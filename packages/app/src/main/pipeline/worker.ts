/**
 * Pipeline worker.
 *
 * One-at-a-time orchestrator. Picks the oldest `tagged` recording and runs
 * it through the four steps, each step respecting a per-recording
 * AbortSignal so user cancellation can interrupt cleanly.
 *
 * Recovery strategy: on startup, call recoverInterrupted() which reverts any
 * recording stuck in a pipeline-running status back to `tagged`. The step
 * runner below checks each step's output field before running; if a prior
 * crash left transcript_text populated but summary_text empty, the worker
 * resumes at summarise without re-running transcribe.
 */

import type { Logger } from 'pino';
import { existsSync, unlinkSync } from 'node:fs';
import type { PipelineContext } from './types.js';
import { CancelledError, isCancelled } from './types.js';
import { doDownload, doSummarise, doTranscribe, doWriteOutputs } from './steps.js';
import type { State } from '../state.js';
import { prettifyError } from '../errorMessages.js';
import { shouldRunStep } from '../pause.js';

export interface WorkerCallbacks {
  /** Called after any state change so the tray + renderer can refresh. */
  onStateChanged: () => void;
  /** Called after a recording successfully completes the full pipeline. */
  onComplete: (id: string) => void;
}

export class Worker {
  private running = false;
  private stopRequested = false;
  private currentId: string | null = null;
  private currentAbort: AbortController | null = null;

  constructor(
    private readonly ctx: PipelineContext,
    private readonly cb: WorkerCallbacks,
  ) {}

  /**
   * Revert interrupted rows and nudge the worker. Call once during app
   * startup, after the State is opened.
   */
  recoverOnStartup(): void {
    const recovered = this.ctx.state.recoverInterrupted();
    if (recovered.length > 0) {
      this.ctx.logger.warn(
        { ids: recovered, count: recovered.length },
        'recovered interrupted recordings \u2014 will resume from last checkpoint',
      );
    }
    this.nudge();
  }

  /**
   * Wake the worker. Call after any tag save, retry, or recovery.
   * Multiple calls while running are coalesced \u2014 the worker naturally
   * picks up new tagged rows on its next iteration.
   */
  nudge(): void {
    if (!this.running && !this.stopRequested) {
      void this.loop();
    }
  }

  /**
   * Cancel a specific recording. If it's the one currently running, aborts
   * the in-flight step immediately. Either way, marks the row as
   * `cancelled` and cleans up partial audio.
   */
  cancel(id: string): void {
    const prevRow = this.ctx.state.cancel(id);
    if (!prevRow) return; // not in a cancellable state

    // If the cancelled row is the one we're actively running, signal the
    // step to bail. The loop will catch CancelledError and move on.
    if (this.currentId === id && this.currentAbort) {
      this.currentAbort.abort();
    }

    // Clean up partial audio so disk doesn't fill up with dead recordings.
    // Safe to delete only if we haven't already written a markdown for it.
    if (prevRow.audio_path && existsSync(prevRow.audio_path) && !prevRow.markdown_path) {
      try {
        unlinkSync(prevRow.audio_path);
        this.ctx.state.setStatus(id, 'cancelled', { audio_path: null });
        this.ctx.logger.info({ id, path: prevRow.audio_path }, 'removed audio on cancel');
      } catch (e) {
        this.ctx.logger.warn({ id, err: String(e) }, 'failed to remove audio on cancel');
      }
    }
    this.cb.onStateChanged();
  }

  /**
   * Signal the worker to stop between iterations. Does NOT abort an
   * in-flight step \u2014 the pipeline lets the current step finish so the
   * row stays in a consistent state (e.g. partial write avoided). Callers
   * that need immediate abort should additionally call cancel(id) for the
   * currently running recording.
   */
  stop(): void {
    this.stopRequested = true;
  }

  private async loop(): Promise<void> {
    this.running = true;
    try {
      while (!this.stopRequested) {
        // Pause-aware claim: build the set of steps the worker is
        // currently permitted to start, and let claimNextTagged skip
        // any row whose next-needed step isn't allowed. A fully-paused
        // worker just sees no claimable rows and exits the loop.
        // `write` is never pausable — it's always allowed.
        const cfg = this.ctx.getConfig();
        const allowed = new Set<'download' | 'transcribe' | 'summarise' | 'write'>([
          'write',
        ]);
        if (shouldRunStep(cfg.paused, 'download')) allowed.add('download');
        if (shouldRunStep(cfg.paused, 'transcribe')) allowed.add('transcribe');
        if (shouldRunStep(cfg.paused, 'summarise')) allowed.add('summarise');

        const claimed = this.ctx.state.claimNextTagged(allowed);
        if (!claimed) break; // nothing claimable right now

        this.cb.onStateChanged();

        const abort = new AbortController();
        this.currentId = claimed.id;
        this.currentAbort = abort;

        try {
          await this.runPipelineForId(claimed.id, abort.signal);
          // If the row is still in a processing status, mark complete.
          const final = this.ctx.state.getRecording(claimed.id);
          if (final && final.status !== 'cancelled' && final.status !== 'error') {
            this.ctx.state.setStatus(claimed.id, 'complete');
            this.cb.onComplete(claimed.id);
          }
        } catch (e) {
          if (isCancelled(e)) {
            this.ctx.logger.info({ id: claimed.id }, 'pipeline cancelled');
            // Status is already 'cancelled' (set by cancel()); do nothing.
          } else {
            const rawMsg = e instanceof Error ? e.message : String(e);
            // Log the raw message so debugging from logs still works, but
            // store a prettified version on the row so the UI can show
            // actionable text instead of raw exception strings.
            this.ctx.logger.error({ id: claimed.id, err: rawMsg }, 'pipeline failed');
            const row = this.ctx.state.getRecording(claimed.id);
            const cfg = this.ctx.getConfig();
            const friendly = prettifyError(rawMsg, {
              step: row?.last_step ?? null,
              ollamaHost: cfg.ollama.host,
              ollamaModel: cfg.ollama.model,
              appSupportDir: this.ctx.appSupportDir,
              isPackaged: this.ctx.isPackaged,
            });
            this.ctx.state.setStatus(claimed.id, 'error', {
              error: friendly.message,
              is_auth_error: friendly.isAuthError ? 1 : 0,
            });
          }
        } finally {
          this.currentId = null;
          this.currentAbort = null;
          this.cb.onStateChanged();
        }
      }
    } finally {
      this.running = false;
    }
  }

  private async runPipelineForId(id: string, signal: AbortSignal): Promise<void> {
    // Fetch fresh state at each step so we correctly skip already-done work.
    // This is what gives the pipeline its crash-recovery property - the row
    // knows which outputs have been produced.
    //
    // Pause handling: each step also re-reads the live pause config and
    // bails out by reverting the row to `tagged` if its step has been
    // paused mid-pipeline. The next worker loop iteration will only
    // re-claim the row when the step is unpaused. This honours
    // BACKLOG's "paused steps don't START new work" semantics: an
    // already-running step (e.g. an in-flight transcribe) finishes
    // because the gate is checked before each step, not during one.

    // --- download ------------------------------------------------------
    const afterClaim = this.ctx.state.getRecording(id);
    if (!afterClaim) return;
    if (!afterClaim.audio_path) {
      if (!shouldRunStep(this.ctx.getConfig().paused, 'download')) {
        this.ctx.state.setStatus(id, 'tagged');
        return;
      }
      this.ctx.state.setStatus(id, 'downloading', { last_step: 'download' });
      this.cb.onStateChanged();
      await doDownload(id, signal, this.ctx);
    }

    // --- transcribe ----------------------------------------------------
    const afterDownload = this.ctx.state.getRecording(id);
    if (!afterDownload) return;
    if (!afterDownload.transcript_text) {
      if (!shouldRunStep(this.ctx.getConfig().paused, 'transcribe')) {
        this.ctx.state.setStatus(id, 'tagged');
        return;
      }
      this.ctx.state.setStatus(id, 'transcribing', { last_step: 'transcribe' });
      this.cb.onStateChanged();
      await doTranscribe(id, signal, this.ctx);
    }

    // --- summarise -----------------------------------------------------
    const afterTranscribe = this.ctx.state.getRecording(id);
    if (!afterTranscribe) return;
    if (!afterTranscribe.summary_text) {
      if (!shouldRunStep(this.ctx.getConfig().paused, 'summarise')) {
        this.ctx.state.setStatus(id, 'tagged');
        return;
      }
      this.ctx.state.setStatus(id, 'summarising', { last_step: 'summarise' });
      this.cb.onStateChanged();
      await doSummarise(id, signal, this.ctx);
    }

    // --- write ---------------------------------------------------------
    // Unlike the other three steps, the write step is always entered \u2014
    // it's internally idempotent, running only enabled destinations that
    // haven't yet succeeded (tracked by per-destination `*_written_at`
    // timestamps). On a retry where every enabled destination already
    // wrote, the step is a cheap no-op that still clears any lingering
    // error message. See DECISIONS.md \u00a71. Write is never pausable.
    const afterSummarise = this.ctx.state.getRecording(id);
    if (!afterSummarise) return;
    this.ctx.state.setStatus(id, 'writing', { last_step: 'write' });
    this.cb.onStateChanged();
    await doWriteOutputs(id, signal, this.ctx);
  }
}

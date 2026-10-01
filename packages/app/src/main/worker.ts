import fs from 'node:fs';
import { shouldRunStep } from './config.js';
import { evaluateSchedule } from './processingSchedule.js';
import { isCancelled } from './cancellation.js';
import { prettifyError } from './errorMessages.js';
import { doDownload, doTranscribe, doSummarise, doWriteOutputs } from './pipelineSteps.js';
import type { PipelineContext } from './pipelineSteps.js';
import type { PipelineStep } from './state.js';

export interface WorkerCallbacks {
  /** Fired on every status transition so the tray + inbox can refresh. */
  onStateChanged: () => void;
  /** Fired when a recording reaches 'complete'. */
  onComplete: (id: string) => void;
  /**
   * Fired when a recording lands in 'error', with the user-facing
   * message. Success was always announced; failure only changed the
   * tray icon, so a run could fail silently and sit there unexplained.
   */
  onError?: (id: string, message: string) => void;
}

/**
 * The single pipeline worker. Claims `tagged` rows one at a time and walks
 * each through download → transcribe → summarise → write. Steps are
 * idempotent — a step whose output column is already populated is skipped —
 * which is what makes crash recovery and per-step pause safe.
 */
export class Worker {
  private ctx: PipelineContext;
  private cb: WorkerCallbacks;
  private running = false;
  private stopRequested = false;
  private currentId: string | null = null;
  private currentAbort: AbortController | null = null;

  constructor(ctx: PipelineContext, cb: WorkerCallbacks) {
    this.ctx = ctx;
    this.cb = cb;
  }

  /**
   * Revert interrupted rows and nudge the worker. Call once during app
   * startup, after the State is opened.
   */
  recoverOnStartup(): void {
    const recovered = this.ctx.state.recoverInterrupted();
    if (recovered.length > 0) {
      this.ctx.logger.warn(
        { ids: recovered, count: recovered.length },
        'recovered interrupted recordings — will resume from last checkpoint',
      );
    }
    this.nudge();
  }

  /**
   * Wake the worker. Call after any tag save, retry, or recovery.
   * Multiple calls while running are coalesced — the worker naturally
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
    if (!prevRow) return;
    if (this.currentId === id && this.currentAbort) {
      this.currentAbort.abort();
    }
    if (prevRow.audio_path && fs.existsSync(prevRow.audio_path) && !prevRow.markdown_path) {
      try {
        fs.unlinkSync(prevRow.audio_path);
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
   * in-flight step — the pipeline lets the current step finish so the
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
        const cfg = this.ctx.getConfig();
        // 'write' is never pausable — a summary that exists should always
        // land on disk.
        const allowed = new Set<PipelineStep>(['write']);
        if (shouldRunStep(cfg.paused, 'download')) allowed.add('download');
        if (shouldRunStep(cfg.paused, 'transcribe')) allowed.add('transcribe');
        if (shouldRunStep(cfg.paused, 'summarise')) allowed.add('summarise');
        // An idle/overnight processing schedule only gates new claims,
        // never in-flight work, exactly like the per-step pause above —
        // see processingSchedule.ts. An urgent-flagged row always bypasses
        // it (claimNextTagged's urgentOnly restricts to those specifically
        // when the schedule is blocking normal claims).
        const idleSeconds = this.ctx.getSystemIdleSeconds?.() ?? 0;
        const schedule = evaluateSchedule(cfg.processingSchedule, idleSeconds);
        const claimed = this.ctx.state.claimNextTagged(allowed, !schedule.allowed);
        if (!claimed) break;
        this.cb.onStateChanged();
        const abort = new AbortController();
        this.currentId = claimed.id;
        this.currentAbort = abort;
        try {
          await this.runPipelineForId(claimed.id, abort.signal);
          const final = this.ctx.state.getRecording(claimed.id);
          if (final && final.status !== 'cancelled' && final.status !== 'error') {
            this.ctx.state.setStatus(claimed.id, 'complete');
            this.cb.onComplete(claimed.id);
          }
        } catch (e) {
          if (isCancelled(e)) {
            this.ctx.logger.info({ id: claimed.id }, 'pipeline cancelled');
          } else {
            const rawMsg = e instanceof Error ? e.message : String(e);
            this.ctx.logger.error({ id: claimed.id, err: rawMsg }, 'pipeline failed');
            const row = this.ctx.state.getRecording(claimed.id);
            const cfg2 = this.ctx.getConfig();
            const friendly = prettifyError(rawMsg, {
              step: row?.last_step ?? null,
              ollamaHost: cfg2.ollama.host,
              ollamaModel: cfg2.ollama.model,
              appSupportDir: this.ctx.appSupportDir,
              isPackaged: this.ctx.isPackaged,
            });
            this.ctx.state.setStatus(claimed.id, 'error', {
              error: friendly.message,
              is_auth_error: friendly.isAuthError ? 1 : 0,
            });
            this.cb.onError?.(claimed.id, friendly.message);
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
    const afterClaim = this.ctx.state.getRecording(id);
    if (!afterClaim) return;
    // A row that already carries a transcript (imported from a previous
    // output file) needs neither audio nor Whisper — go straight to
    // summarise. Guarding on transcript_text rather than audio_path also
    // stops a recovered row re-downloading audio it no longer needs.
    if (!afterClaim.transcript_text && !afterClaim.audio_path) {
      if (!shouldRunStep(this.ctx.getConfig().paused, 'download')) {
        this.ctx.state.setStatus(id, 'tagged');
        return;
      }
      this.ctx.state.setStatus(id, 'downloading', { last_step: 'download' });
      this.cb.onStateChanged();
      await doDownload(id, signal, this.ctx);
    }
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
    const afterSummarise = this.ctx.state.getRecording(id);
    if (!afterSummarise) return;
    this.ctx.state.setStatus(id, 'writing', { last_step: 'write' });
    this.cb.onStateChanged();
    await doWriteOutputs(id, signal, this.ctx);
  }
}

/**
 * Polls the Plaud cloud on a timer, diffs results against SQLite, inserts
 * new recordings as `inbox`, and emits callbacks for tray / notifications.
 *
 * The poller is deliberately dumb:
 *   - calls listRecordings()
 *   - inserts any id not already in our DB
 *   - never modifies Plaud-side state
 *   - never processes anything (that's the pipeline's job in M2)
 *
 * Failure handling: logs each attempt, exposes a lastResult for the tray to
 * surface. We do NOT aggressively back off — polling every 5 minutes and
 * quietly failing twice is fine. After 3 consecutive failures we extend
 * the next interval once, giving transient network issues room to clear.
 */

import type { Logger } from 'pino';
import type { RecordingRow, RecordingStatus } from './state.js';
import type { PlaudRecording } from './plaud.js';
import type { ProcessedRecord } from './processedElsewhere.js';

export interface PlaudListClient {
  /**
   * Structural interface duck-typed against @plaud/core's PlaudClient.
   * Tests can supply a fake without instantiating the full SDK.
   */
  listRecordings(): Promise<PlaudRecording[]>;
}

/**
 * The minimal subset of State the Poller actually uses. Keeping this narrow
 * lets tests supply an in-memory fake without requiring better-sqlite3 to be
 * ABI-compatible with the test runtime (better-sqlite3 gets rebuilt for
 * Electron's Node, which is usually a different NODE_MODULE_VERSION than the
 * system Node that runs vitest).
 *
 * The real State class from state.ts satisfies this interface structurally —
 * nothing additional needed at the call site.
 */
export interface InboxStore {
  recordingExists(id: string): boolean;
  insertRecording(r: Omit<RecordingRow, 'created_at' | 'updated_at' | 'retries'>): void;
  getAppState(key: string): string | undefined;
  setAppState(key: string, value: string): void;
}

export const INITIAL_POLL_KEY = 'hasCompletedInitialPoll';

export type PollResult =
  | { kind: 'ok'; newCount: number; totalSeen: number; at: number }
  | { kind: 'skipped-paused'; at: number }
  | { kind: 'error'; message: string; at: number };

export interface PollerOptions {
  state: InboxStore;
  client: PlaudListClient;
  intervalMinutes: number;
  logger: Logger;
  /** Return true to skip polling (used to respect `config.paused`). */
  shouldPause: () => boolean;
  /**
   * Called once per poll cycle BEFORE the recording diff. Returns a
   * Map keyed by Plaud recording_id of recordings that another machine
   * has already processed (markdown file with matching frontmatter
   * found in the configured Markdown output dir). The poller uses
   * this to insert such recordings as `complete` /
   * `processed_externally = 1` rather than `inbox`, so the user isn't
   * prompted to re-process work that's already done elsewhere.
   *
   * Returns an empty Map (or rejects — errors are caught and treated
   * as empty) when no Markdown output is configured or the directory
   * doesn't exist yet. Cross-machine detection is best-effort; an
   * error here never blocks the poll.
   *
   * Optional so existing tests that don't care about this surface
   * can omit it; the poller treats `undefined` the same as a function
   * returning an empty Map.
   */
  loadProcessedElsewhere?: () => Promise<Map<string, ProcessedRecord>>;
  /**
   * Called after every poll attempt with the result, whether success, pause,
   * or error. Used by the tray to refresh its status line and by the app
   * entry point to fire "new recording" notifications.
   *
   * For success polls, `newRecordings` lists the ids that were freshly
   * inserted — downstream can iterate to send one notification per recording.
   */
  onPoll: (result: PollResult, newRecordings: PlaudRecording[]) => void;
}

export class Poller {
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private inFlight = false;
  private lastResult: PollResult | null = null;
  private started = false;

  constructor(private readonly opts: PollerOptions) {}

  start(): void {
    if (this.started) return;
    this.started = true;
    // Fire one poll on start so the tray comes up populated, then schedule.
    void this.tick();
    this.scheduleNext();
  }

  stop(): void {
    this.started = false;
    if (this.timer) {
      clearTimeout(this.timer);
      this.timer = null;
    }
  }

  getLastResult(): PollResult | null {
    return this.lastResult;
  }

  /** Manually trigger a poll now (from the tray "Sync now" item). */
  async syncNow(): Promise<PollResult> {
    return this.tick();
  }

  private scheduleNext(): void {
    if (!this.started) return;
    if (this.timer) clearTimeout(this.timer);

    // Base interval. If we've had >=3 consecutive failures, double it for
    // this one cycle — gives transient network issues room to resolve.
    let intervalMs = this.opts.intervalMinutes * 60_000;
    if (this.consecutiveFailures >= 3) intervalMs *= 2;

    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, intervalMs);
  }

  private async tick(): Promise<PollResult> {
    if (this.inFlight) {
      // Shouldn't happen with our scheduling, but guard against it.
      return this.lastResult ?? { kind: 'ok', newCount: 0, totalSeen: 0, at: Date.now() };
    }
    this.inFlight = true;

    try {
      if (this.opts.shouldPause()) {
        const result: PollResult = { kind: 'skipped-paused', at: Date.now() };
        this.lastResult = result;
        this.opts.onPoll(result, []);
        return result;
      }

      const all = await this.opts.client.listRecordings();

      // Cross-machine completion lookup: scan the configured Markdown
      // output dir for files whose frontmatter recording_id matches
      // a recording we're about to insert. When found, the row goes
      // straight to `complete` with `processed_externally = 1` rather
      // than landing in the inbox to be re-processed. See
      // processedElsewhere.ts for the strategy and design rationale.
      //
      // Errors here never block the poll — a transient I/O hiccup or
      // a missing directory just means no cross-machine matches for
      // this cycle, equivalent to single-machine behaviour.
      let processedElsewhere = new Map<string, ProcessedRecord>();
      if (this.opts.loadProcessedElsewhere) {
        try {
          processedElsewhere = await this.opts.loadProcessedElsewhere();
          if (processedElsewhere.size > 0) {
            this.opts.logger.info(
              { count: processedElsewhere.size },
              'cross-machine completion lookup ready',
            );
          }
        } catch (e) {
          this.opts.logger.warn(
            { err: e instanceof Error ? e.message : String(e) },
            'cross-machine completion lookup failed; proceeding without it',
          );
        }
      }

      // On the very first successful poll of a fresh install, Plaud cloud
      // returns the user's entire history. Flooding the inbox with hundreds
      // of historical recordings is not what anyone wants, so we mark them
      // all as `skipped`. Subsequent polls use the normal `inbox` path so
      // genuinely new recordings surface as expected.
      const isInitialPoll = this.opts.state.getAppState(INITIAL_POLL_KEY) !== 'true';
      const initialStatus: RecordingStatus = isInitialPoll ? 'skipped' : 'inbox';

      const fresh: PlaudRecording[] = [];
      let processedExternallyCount = 0;

      for (const r of all) {
        if (this.opts.state.recordingExists(r.id)) continue;
        // Normalise units at the Plaud boundary: Plaud returns `duration`
        // in milliseconds, so divide by 1000 to store seconds as the column
        // name implies. `start_time` is already in milliseconds and we
        // store it as ms (naming is inherited from Plaud).
        const durationSeconds =
          typeof r.duration === 'number' ? Math.round(r.duration / 1000) : null;

        // Cross-machine completion check. If a Markdown file exists
        // for this recording_id, skip the inbox entirely and insert
        // as `complete` with the metadata from the existing file.
        // Honours initial-poll semantics: during the first poll, even
        // a recording that was processed elsewhere stays as `skipped`
        // (the user's catch-up wishes overrule cross-machine detection).
        const elsewhere =
          initialStatus === 'inbox' ? processedElsewhere.get(r.id) : undefined;
        const rowStatus: RecordingStatus = elsewhere ? 'complete' : initialStatus;
        if (elsewhere) processedExternallyCount += 1;

        this.opts.state.insertRecording({
          id: r.id,
          filename: r.filename,
          duration_seconds: durationSeconds,
          start_time: r.start_time,
          filesize_bytes: r.filesize,
          synced_at: Date.now(),
          status: rowStatus,
          client_id: null,
          meeting_type_id: null,
          audio_path: null,
          transcript_text: null,
          summary_text: null,
          markdown_path: elsewhere ? elsewhere.markdownPath : null,
          error: null,
          is_auth_error: 0,
          last_step: null,
          prompt_snapshot: null,
          model_snapshot: elsewhere ? elsewhere.modelSnapshot : null,
          whisper_snapshot: elsewhere ? elsewhere.whisperSnapshot : null,
          vocabulary_sources: null,
          vocabulary_rules_applied: null,
          source: 'plaud',
          html_path: null,
          apple_note_id: null,
          markdown_written_at: elsewhere ? elsewhere.writtenAtMs : null,
          html_written_at: null,
          apple_note_written_at: null,
          truncation_warning: 0,
          estimated_input_tokens: null,
          context_window_at_submit: null,
          processed_externally: elsewhere ? 1 : 0,
        });
        // Only surface fresh items to the caller when they actually went to
        // the inbox — otherwise notifications would fire for the catch-up
        // and for already-processed-elsewhere rows.
        if (rowStatus === 'inbox') fresh.push(r);
      }

      if (isInitialPoll) {
        this.opts.state.setAppState(INITIAL_POLL_KEY, 'true');
        this.opts.logger.info(
          { totalSeen: all.length, markedSkipped: all.length },
          'initial poll complete — existing recordings marked as skipped',
        );
      } else if (processedExternallyCount > 0) {
        this.opts.logger.info(
          { count: processedExternallyCount },
          'recordings adopted from another machine’s outputs',
        );
      }

      const result: PollResult = {
        kind: 'ok',
        newCount: fresh.length,
        totalSeen: all.length,
        at: Date.now(),
      };
      this.lastResult = result;
      this.consecutiveFailures = 0;
      this.opts.logger.info(
        { totalSeen: all.length, newCount: fresh.length },
        'poll ok',
      );
      this.opts.onPoll(result, fresh);
      return result;
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      const result: PollResult = { kind: 'error', message, at: Date.now() };
      this.lastResult = result;
      this.consecutiveFailures++;
      this.opts.logger.warn(
        { err: message, consecutiveFailures: this.consecutiveFailures },
        'poll failed',
      );
      this.opts.onPoll(result, []);
      return result;
    } finally {
      this.inFlight = false;
    }
  }
}

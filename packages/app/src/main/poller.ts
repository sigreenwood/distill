import * as fsp from 'node:fs/promises';
import path from 'node:path';
import type { PlaudClient, PlaudRecording } from '@plaud/core';
import type { Logger } from './logger.js';
import type { State } from './state.js';

const INITIAL_POLL_KEY = 'hasCompletedInitialPoll';
const FULL_HISTORY_KEY = 'hasBackfilledFullHistory';

/**
 * How many recordings Plaud's list endpoint returned before
 * listRecordings() asked for the full history. On the first poll after
 * that change, unseen recordings outside the newest this-many (by start
 * time) are treated as back catalogue. If the old listing wasn't the
 * newest 1000, the cost is a few old recordings showing up in the inbox.
 */
export const LEGACY_LIST_LIMIT = 1000;

export type PollResult =
  | { kind: 'ok'; newCount: number; totalSeen: number; at: number }
  | { kind: 'error'; message: string; at: number }
  | { kind: 'skipped-paused'; at: number };

/** What a markdown file found on disk tells us about a recording another machine already processed. */
export interface ProcessedElsewhereEntry {
  markdownPath: string;
  writtenAtMs: number;
  modelSnapshot: string | null;
  whisperSnapshot: string | null;
}

export interface PollerOptions {
  client: PlaudClient;
  state: State;
  logger: Logger;
  intervalMinutes: number;
  shouldPause: () => boolean;
  onPoll: (result: PollResult, fresh: PlaudRecording[]) => void;
  loadProcessedElsewhere?: () => Promise<Map<string, ProcessedElsewhereEntry>>;
  /**
   * How many of the most recent recordings land in the inbox on the very
   * first poll of a fresh install. The rest of the back catalogue is
   * marked skipped. 0 reproduces the original "skip everything" default.
   */
  initialPollInboxCount?: () => number;
}

/**
 * Pick which recordings go to the inbox on a first poll: the `count` most
 * recent by start time. Exported for testing — the ordering matters, and
 * Plaud does not guarantee the list arrives sorted.
 */
export function selectInitialInboxIds(
  recordings: PlaudRecording[],
  count: number,
): Set<string> {
  if (count <= 0) return new Set();
  return new Set(
    [...recordings]
      .sort((a, b) => (b.start_time ?? 0) - (a.start_time ?? 0))
      .slice(0, count)
      .map((r) => r.id),
  );
}

export class Poller {
  private opts: PollerOptions;
  private timer: NodeJS.Timeout | null = null;
  private consecutiveFailures = 0;
  private inFlight = false;
  private lastResult: PollResult | null = null;
  private started = false;

  constructor(opts: PollerOptions) {
    this.opts = opts;
  }

  start(): void {
    if (this.started) return;
    this.started = true;
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
    let intervalMs = this.opts.intervalMinutes * 60_000;
    if (this.consecutiveFailures >= 3) intervalMs *= 2;
    this.timer = setTimeout(() => {
      void this.tick().finally(() => this.scheduleNext());
    }, intervalMs);
  }

  private async tick(): Promise<PollResult> {
    if (this.inFlight) {
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

      let processedElsewhere = new Map<string, ProcessedElsewhereEntry>();
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

      const isInitialPoll = this.opts.state.getAppState(INITIAL_POLL_KEY) !== 'true';
      // On the very first poll the user's whole back catalogue arrives at
      // once — often hundreds of recordings. Keep the most recent few in
      // the inbox (enough to tag and try the pipeline) and skip the rest,
      // rather than flooding a UI built for a handful of rows.
      const initialInboxIds = isInitialPoll
        ? selectInitialInboxIds(all, this.opts.initialPollInboxCount?.() ?? 0)
        : null;

      // The first poll after upgrading to the full-history listing sees,
      // for the first time, every recording older than the old 1000-row
      // window. They are back catalogue, not new: without this they would
      // each land in the inbox with a "New recording" notification. The
      // initial poll already skips back catalogue, so it needs no help.
      const isBackfillPoll =
        !isInitialPoll && this.opts.state.getAppState(FULL_HISTORY_KEY) !== 'true';
      const legacyWindowIds = isBackfillPoll ? selectInitialInboxIds(all, LEGACY_LIST_LIMIT) : null;

      const fresh: PlaudRecording[] = [];
      let processedExternallyCount = 0;
      let backfilledCount = 0;
      for (const r of all) {
        if (this.opts.state.recordingExists(r.id)) continue;
        const durationSeconds = typeof r.duration === 'number' ? Math.round(r.duration / 1000) : null;
        const outsideLegacyWindow = legacyWindowIds !== null && !legacyWindowIds.has(r.id);
        if (outsideLegacyWindow) backfilledCount += 1;
        const initialStatus =
          outsideLegacyWindow
            ? ('skipped' as const)
            : initialInboxIds === null
              ? ('inbox' as const)
              : initialInboxIds.has(r.id)
                ? ('inbox' as const)
                : ('skipped' as const);
        const elsewhere = initialStatus === 'inbox' ? processedElsewhere.get(r.id) : undefined;
        const rowStatus = elsewhere ? ('complete' as const) : initialStatus;
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
        if (rowStatus === 'inbox') fresh.push(r);
      }

      if (isInitialPoll || isBackfillPoll) {
        this.opts.state.setAppState(FULL_HISTORY_KEY, 'true');
      }
      if (isBackfillPoll && backfilledCount > 0) {
        this.opts.logger.info(
          { backfilled: backfilledCount, totalSeen: all.length },
          'full-history backfill — older recordings added as hidden',
        );
      }

      if (isInitialPoll) {
        this.opts.state.setAppState(INITIAL_POLL_KEY, 'true');
        const keptInInbox = initialInboxIds?.size ?? 0;
        this.opts.logger.info(
          {
            totalSeen: all.length,
            keptInInbox,
            markedSkipped: Math.max(0, all.length - keptInInbox),
          },
          'initial poll complete — recent recordings kept, back catalogue skipped',
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
      this.opts.logger.info({ totalSeen: all.length, newCount: fresh.length }, 'poll ok');
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

/**
 * Scan the configured markdown output directory (one level of client
 * subfolders deep) for files whose frontmatter names a recording_id —
 * evidence another machine already processed that recording. Returns the
 * newest file per recording id.
 */
export async function loadProcessedElsewhereIds(
  baseDir: string,
): Promise<Map<string, ProcessedElsewhereEntry>> {
  const result = new Map<string, ProcessedElsewhereEntry>();
  let topLevel: { name: string; isDirectory: boolean }[];
  try {
    const entries = await fsp.readdir(baseDir, { withFileTypes: true });
    topLevel = entries.map((e) => ({ name: e.name, isDirectory: e.isDirectory() }));
  } catch {
    return result;
  }
  for (const entry of topLevel) {
    if (entry.isDirectory) {
      await scanDirectoryInto(path.join(baseDir, entry.name), result);
    } else if (entry.name.toLowerCase().endsWith('.md')) {
      await tryAddFile(path.join(baseDir, entry.name), result);
    }
  }
  return result;
}

async function scanDirectoryInto(
  dir: string,
  result: Map<string, ProcessedElsewhereEntry>,
): Promise<void> {
  let entries: string[];
  try {
    entries = await fsp.readdir(dir);
  } catch {
    return;
  }
  for (const name of entries) {
    if (!name.toLowerCase().endsWith('.md')) continue;
    await tryAddFile(path.join(dir, name), result);
  }
}

async function tryAddFile(
  filePath: string,
  result: Map<string, ProcessedElsewhereEntry>,
): Promise<void> {
  let frontmatter: string;
  let mtimeMs: number;
  try {
    const buf = await fsp.readFile(filePath);
    const head = buf.subarray(0, 4096).toString('utf8');
    const match = head.match(/^---\r?\n([\s\S]*?)\r?\n---/);
    if (!match) return;
    frontmatter = match[1];
    const stats = await fsp.stat(filePath);
    mtimeMs = stats.mtimeMs;
  } catch {
    return;
  }
  const parsed = parseSimpleFrontmatter(frontmatter);
  const recordingId = parsed.recording_id;
  if (!recordingId) return;
  const existing = result.get(recordingId);
  if (existing && existing.writtenAtMs >= mtimeMs) return;
  result.set(recordingId, {
    markdownPath: filePath,
    writtenAtMs: mtimeMs,
    modelSnapshot: parsed.model ?? null,
    whisperSnapshot: parsed.whisper_model ?? null,
  });
}

export function parseSimpleFrontmatter(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const rawLine of text.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (!line || line.startsWith('#')) continue;
    const colon = line.indexOf(':');
    if (colon < 0) continue;
    const key = line.slice(0, colon).trim();
    let value = line.slice(colon + 1).trim();
    if (value.length === 0) continue;
    if (
      (value.startsWith('"') && value.endsWith('"')) ||
      (value.startsWith("'") && value.endsWith("'"))
    ) {
      try {
        value = JSON.parse(value.replace(/^'|'$/g, '"'));
      } catch {
        // keep the quoted raw value
      }
    }
    out[key] = value;
  }
  return out;
}

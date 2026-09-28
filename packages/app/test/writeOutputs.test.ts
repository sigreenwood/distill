/**
 * Tests for the write-outputs step's per-destination idempotency.
 *
 * The writers themselves (writeMarkdown, writeHtml, writeAppleNote) are
 * mocked via vitest so we don't touch disk or AppleScript. We test the
 * orchestration: which destinations ran, what got persisted, and how
 * retries interact with `*_written_at` timestamps.
 *
 * See DECISIONS.md §1 for the full contract being tested here.
 */

import { describe, it, expect, beforeEach, vi } from 'vitest';
import pino from 'pino';
import type { PipelineContext } from '../src/main/pipeline/types.js';
import type { AppConfig } from '../src/main/config.js';
import type { JoinedRecordingRow, RecordingRow } from '../src/main/state.js';

// Mock the three concrete writers BEFORE importing anything that transitively
// pulls them in. Vitest hoists vi.mock to the top of the file so these take
// effect before writeOutputs runs.
vi.mock('../src/main/outputs/writeMarkdown.js', () => ({
  writeMarkdown: vi.fn(),
}));
vi.mock('../src/main/outputs/writeHtml.js', () => ({
  writeHtml: vi.fn(),
}));
vi.mock('../src/main/outputs/writeAppleNotes.js', () => ({
  writeAppleNote: vi.fn(),
}));

// Now import the system under test and the mocked modules.
import { doWriteOutputs } from '../src/main/pipeline/steps.js';
import { writeMarkdown } from '../src/main/outputs/writeMarkdown.js';
import { writeHtml } from '../src/main/outputs/writeHtml.js';
import { writeAppleNote } from '../src/main/outputs/writeAppleNotes.js';

// ---------------------------------------------------------------------------
// Test fixtures — lightweight fakes for State and config
// ---------------------------------------------------------------------------

function makeRow(overrides: Partial<JoinedRecordingRow> = {}): JoinedRecordingRow {
  const now = Date.now();
  return {
    id: 'rec-1',
    filename: 'Test meeting.mp3',
    duration_seconds: 1800,
    start_time: 1_700_000_000_000,
    filesize_bytes: 1_000_000,
    synced_at: now,
    status: 'writing',
    client_id: 'c1',
    meeting_type_id: 'm1',
    audio_path: '/tmp/x.mp3',
    transcript_text: 'hello',
    summary_text: 'summary',
    markdown_path: null,
    error: null,
    last_step: 'write',
    retries: 0,
    prompt_snapshot: null,
    model_snapshot: null,
    whisper_snapshot: null,
    vocabulary_sources: null,
    vocabulary_rules_applied: null,
    source: 'plaud',
    html_path: null,
    apple_note_id: null,
    markdown_written_at: null,
    html_written_at: null,
    apple_note_written_at: null,
    created_at: now,
    updated_at: now,
    client_name: 'Acme',
    meeting_type_name: 'client-call',
    ...overrides,
  };
}

function makeConfig(enabled: {
  markdown?: boolean;
  html?: boolean;
  appleNotes?: boolean;
}): AppConfig {
  return {
    version: 1,
    ollama: {
      host: 'http://localhost:11434',
      model: 'qwen2.5:32b',
      contextWindow: 32768,
      temperature: 0.3,
      keepAlive: '24h',
    },
    pollIntervalMinutes: 5,
    paused: {
      all: false,
      polling: false,
      download: false,
      transcribe: false,
      summarise: false,
    },
    whisperModel: 'mlx-community/whisper-large-v3-mlx',
    outputs: {
      markdown: {
        enabled: enabled.markdown ?? false,
        dir: '/tmp/md',
        includeTranscript: true,
      },
      html: {
        enabled: enabled.html ?? false,
        dir: '/tmp/html',
        includeTranscript: true,
      },
      appleNotes: {
        enabled: enabled.appleNotes ?? false,
        parentFolder: 'distill',
        includeTranscript: true,
      },
    },
    audioRetentionDays: 14,
    autoDismissCompleteMinutes: 10,
    logLevel: 'silent',
  };
}

/**
 * In-memory stand-in for State. Only implements what doWriteOutputs
 * actually calls on ctx.state:
 *   - getRecordingJoined(id)
 *   - setStatus(id, status, patch)
 *
 * Other methods throw if called, so mistakes show up as test failures
 * rather than silent skips.
 */
class FakeState {
  public row: JoinedRecordingRow;
  public setStatusCalls: Array<{
    id: string;
    status: string;
    patch: Record<string, unknown> | undefined;
  }> = [];

  constructor(row: JoinedRecordingRow) {
    this.row = row;
  }

  getRecordingJoined(id: string): JoinedRecordingRow | undefined {
    return id === this.row.id ? this.row : undefined;
  }

  // doWriteOutputs calls setStatus to persist successes. We merge the patch
  // into our in-memory row so a follow-up retry in the same test sees the
  // updated state — mirrors real State behaviour.
  setStatus(
    id: string,
    status: RecordingRow['status'],
    patch?: Partial<RecordingRow>,
  ): void {
    this.setStatusCalls.push({ id, status, patch: patch as Record<string, unknown> | undefined });
    if (patch) {
      for (const [k, v] of Object.entries(patch)) {
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        (this.row as any)[k] = v;
      }
      // Keep status in sync too.
      this.row.status = status;
    }
  }
}

function makeCtx(state: FakeState, cfg: AppConfig): PipelineContext {
  return {
    state: state as unknown as PipelineContext['state'],
    getConfig: () => cfg,
    logger: pino({ level: 'silent' }),
    // writeOutputs doesn't call ollama/plaud, but PipelineContext requires them.
    ollama: {} as unknown as PipelineContext['ollama'],
    plaud: {} as unknown as PipelineContext['plaud'],
    packageDir: '/tmp/pkg',
  };
}

const writeMarkdownMock = vi.mocked(writeMarkdown);
const writeHtmlMock = vi.mocked(writeHtml);
const writeAppleNoteMock = vi.mocked(writeAppleNote);
const neverAborted = new AbortController().signal;

beforeEach(() => {
  writeMarkdownMock.mockReset();
  writeHtmlMock.mockReset();
  writeAppleNoteMock.mockReset();
});

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('doWriteOutputs — initial write', () => {
  it('runs every enabled destination and persists paths + timestamps', async () => {
    writeMarkdownMock.mockResolvedValue({ path: '/tmp/md/out.md' });
    writeHtmlMock.mockResolvedValue({ path: '/tmp/html/out.html' });
    writeAppleNoteMock.mockResolvedValue({ noteId: 'note-123' });

    const state = new FakeState(makeRow());
    const cfg = makeConfig({ markdown: true, html: true, appleNotes: true });

    await doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg));

    expect(writeMarkdownMock).toHaveBeenCalledTimes(1);
    expect(writeHtmlMock).toHaveBeenCalledTimes(1);
    expect(writeAppleNoteMock).toHaveBeenCalledTimes(1);

    // One setStatus call writes all three successes plus clears error.
    expect(state.setStatusCalls).toHaveLength(1);
    const patch = state.setStatusCalls[0]!.patch!;
    expect(patch.markdown_path).toBe('/tmp/md/out.md');
    expect(patch.html_path).toBe('/tmp/html/out.html');
    expect(patch.apple_note_id).toBe('note-123');
    expect(patch.markdown_written_at).toBeTypeOf('number');
    expect(patch.html_written_at).toBeTypeOf('number');
    expect(patch.apple_note_written_at).toBeTypeOf('number');
    expect(patch.error).toBeNull();
  });

  it('throws with a useful message when no destinations are enabled', async () => {
    const state = new FakeState(makeRow());
    const cfg = makeConfig({}); // everything disabled

    await expect(doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg))).rejects.toThrow(
      /no output destinations are enabled/i,
    );
    expect(writeMarkdownMock).not.toHaveBeenCalled();
    expect(writeHtmlMock).not.toHaveBeenCalled();
    expect(writeAppleNoteMock).not.toHaveBeenCalled();
  });

  it('persists successes and throws on partial failure', async () => {
    writeMarkdownMock.mockResolvedValue({ path: '/tmp/md/out.md' });
    writeHtmlMock.mockRejectedValue(new Error('disk full'));
    writeAppleNoteMock.mockResolvedValue({ noteId: 'note-123' });

    const state = new FakeState(makeRow());
    const cfg = makeConfig({ markdown: true, html: true, appleNotes: true });

    await expect(doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg))).rejects.toThrow(
      /partial output failure.*disk full/i,
    );

    // Successes were still persisted — so retry won't re-run them.
    expect(state.setStatusCalls).toHaveLength(1);
    const patch = state.setStatusCalls[0]!.patch!;
    expect(patch.markdown_path).toBe('/tmp/md/out.md');
    expect(patch.apple_note_id).toBe('note-123');
    expect(patch.markdown_written_at).toBeTypeOf('number');
    expect(patch.apple_note_written_at).toBeTypeOf('number');
    // HTML was attempted but failed — no path, no timestamp, no patch entry.
    expect(patch.html_path).toBeUndefined();
    expect(patch.html_written_at).toBeUndefined();
    // And we didn't clear `error` because we threw.
    expect(patch.error).toBeUndefined();
  });

  it('throws without persisting when all attempted destinations fail', async () => {
    writeMarkdownMock.mockRejectedValue(new Error('permission denied'));
    writeHtmlMock.mockRejectedValue(new Error('disk full'));

    const state = new FakeState(makeRow());
    const cfg = makeConfig({ markdown: true, html: true });

    await expect(doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg))).rejects.toThrow(
      /all output destinations failed/i,
    );

    // Nothing succeeded, so no patch should have been written.
    expect(state.setStatusCalls).toHaveLength(0);
  });
});

describe('doWriteOutputs — retry semantics', () => {
  it('skips destinations that already have a written_at timestamp', async () => {
    writeHtmlMock.mockResolvedValue({ path: '/tmp/html/out.html' });

    // Row simulates: Markdown and Apple Notes wrote on a prior attempt,
    // HTML failed and is about to be retried.
    const state = new FakeState(
      makeRow({
        markdown_path: '/tmp/md/prior.md',
        markdown_written_at: Date.now() - 5_000,
        apple_note_id: 'prior-note',
        apple_note_written_at: Date.now() - 5_000,
        // html_path + html_written_at still null
      }),
    );
    const cfg = makeConfig({ markdown: true, html: true, appleNotes: true });

    await doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg));

    // Only HTML ran; Markdown and Apple Notes were correctly skipped.
    expect(writeMarkdownMock).not.toHaveBeenCalled();
    expect(writeAppleNoteMock).not.toHaveBeenCalled();
    expect(writeHtmlMock).toHaveBeenCalledTimes(1);

    // The persist patch should only set HTML's path+timestamp plus clear
    // error — it must NOT overwrite the preserved markdown_path or
    // apple_note_id with null or anything else.
    expect(state.setStatusCalls).toHaveLength(1);
    const patch = state.setStatusCalls[0]!.patch!;
    expect(patch.html_path).toBe('/tmp/html/out.html');
    expect(patch.html_written_at).toBeTypeOf('number');
    expect('markdown_path' in patch).toBe(false);
    expect('markdown_written_at' in patch).toBe(false);
    expect('apple_note_id' in patch).toBe(false);
    expect('apple_note_written_at' in patch).toBe(false);
    expect(patch.error).toBeNull();
  });

  it('is a no-op (besides clearing error) when every enabled destination is already written', async () => {
    // All three destinations have timestamps from a prior successful run.
    const state = new FakeState(
      makeRow({
        markdown_path: '/tmp/md/prior.md',
        markdown_written_at: Date.now() - 10_000,
        html_path: '/tmp/html/prior.html',
        html_written_at: Date.now() - 10_000,
        apple_note_id: 'prior-note',
        apple_note_written_at: Date.now() - 10_000,
      }),
    );
    const cfg = makeConfig({ markdown: true, html: true, appleNotes: true });

    await doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg));

    expect(writeMarkdownMock).not.toHaveBeenCalled();
    expect(writeHtmlMock).not.toHaveBeenCalled();
    expect(writeAppleNoteMock).not.toHaveBeenCalled();

    // One setStatus call with just error:null — no destinations to record.
    expect(state.setStatusCalls).toHaveLength(1);
    const patch = state.setStatusCalls[0]!.patch!;
    expect(patch.error).toBeNull();
    expect('markdown_path' in patch).toBe(false);
    expect('html_path' in patch).toBe(false);
    expect('apple_note_id' in patch).toBe(false);
  });

  it('does not run a destination the user has disabled since the prior attempt', async () => {
    writeHtmlMock.mockResolvedValue({ path: '/tmp/html/out.html' });

    // Apple Notes previously failed; now user has turned it off in Settings.
    // HTML had written successfully in a prior attempt? No — say HTML is
    // the thing we're retrying. Markdown was already off. So the only
    // destination to run is HTML.
    const state = new FakeState(
      makeRow({
        apple_note_id: null,
        apple_note_written_at: null,
      }),
    );
    // Apple Notes disabled; only HTML enabled.
    const cfg = makeConfig({ html: true });

    await doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg));

    expect(writeMarkdownMock).not.toHaveBeenCalled();
    expect(writeHtmlMock).toHaveBeenCalledTimes(1);
    expect(writeAppleNoteMock).not.toHaveBeenCalled();
  });

  it('runs a destination the user has newly enabled even if other destinations were already written', async () => {
    writeHtmlMock.mockResolvedValue({ path: '/tmp/html/new.html' });

    // Prior run: only Markdown was enabled and it succeeded. Now the user
    // has also enabled HTML; on retry (say, after hitting Retry on a row
    // that errored for some unrelated reason), HTML should run because
    // its `html_written_at` is still null.
    const state = new FakeState(
      makeRow({
        markdown_path: '/tmp/md/prior.md',
        markdown_written_at: Date.now() - 10_000,
        html_path: null,
        html_written_at: null,
      }),
    );
    const cfg = makeConfig({ markdown: true, html: true });

    await doWriteOutputs('rec-1', neverAborted, makeCtx(state, cfg));

    expect(writeMarkdownMock).not.toHaveBeenCalled();
    expect(writeHtmlMock).toHaveBeenCalledTimes(1);

    const patch = state.setStatusCalls[0]!.patch!;
    expect(patch.html_path).toBe('/tmp/html/new.html');
    expect(patch.html_written_at).toBeTypeOf('number');
    // Must NOT overwrite existing markdown_path.
    expect('markdown_path' in patch).toBe(false);
  });
});

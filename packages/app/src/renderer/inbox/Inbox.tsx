import { useEffect, useMemo, useState, useCallback, useRef } from 'react';
import type {
  InboxRecordingDTO,
  LocalImportProgressEvent,
  PipelineStep,
  RecordingStatus,
  TipJarStatusDTO,
} from '../../shared/ipc-contract.js';
import { formatDuration, formatWhen } from '../shared/format.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; recordings: InboxRecordingDTO[] }
  | { kind: 'error'; message: string };

/**
 * One entry in the user-driven import queue. Lives entirely in
 * renderer state — the main process doesn't know about the queue,
 * only about individual `importPath` invocations. If the inbox
 * window closes mid-batch, queued entries are lost; in-flight and
 * already-imported files are unaffected because they live in the
 * main-process state and the SQLite DB.
 */
interface ImportEntry {
  /** Absolute filesystem path of the source file. */
  sourcePath: string;
  status: 'queued' | 'active' | 'error';
  phase: 'probe' | 'copy' | 'extract' | 'finalise' | null;
  /** 0-100, or null when indeterminate. Only meaningful while status='active'. */
  percent: number | null;
  error: string | null;
}

/**
 * The inbox window shows every recording that needs the user's attention —
 * waiting to tag, mid-pipeline, errored, cancelled, or recently completed.
 * Skipped recordings are hidden entirely; they're the "done with" bucket.
 *
 * Rows are grouped into sections by status so the user can see the flow at
 * a glance: "3 processing, 2 waiting, 1 error". Each section renders only
 * when it has rows.
 */
export function Inbox(): JSX.Element {
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  /**
   * The import queue. Each entry represents a file the user has
   * asked us to import; entries flow from `queued` -> `active` (with
   * progress) -> removed-on-success or `error` -> dismiss-by-user.
   * The renderer drives the queue itself: a single async loop
   * (importLoop) pulls the head entry, awaits importPath, and
   * advances. We never run two imports concurrently — ffmpeg is
   * CPU-heavy and the user will be running transcription on the
   * same machine. Sequential is the right policy.
   *
   * Source path is the queue key. We never need to dedupe the same
   * path twice in a row — if the user adds it twice it gets imported
   * twice (two recordings). Real duplicate detection lives downstream.
   */
  const [importQueue, setImportQueue] = useState<ImportEntry[]>([]);
  // Ref mirror of the queue, used inside the import loop. The loop
  // runs in a closure that would otherwise see a stale snapshot of
  // `importQueue` between awaits. Updating both together keeps them
  // in sync.
  const importQueueRef = useRef<ImportEntry[]>([]);
  const importLoopRunningRef = useRef(false);

  // Tip-jar banner state. Loaded on mount and refreshed whenever the
  // inbox-changed broadcast fires (a new completion may have just
  // bumped the count past the threshold). The banner displays only
  // when `tipJar.shouldShowBanner` is true; dismissing it sets a
  // sticky flag in main and hides locally without waiting for the
  // round-trip.
  const [tipJar, setTipJar] = useState<TipJarStatusDTO | null>(null);

  const refresh = useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await window.distill.inbox.list();
      setState({ kind: 'ready', recordings: list });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }, []);

  // Initial load + subscribe to inbox-changed pushes.
  useEffect(() => {
    void refresh();
    const off = window.distill.onInboxChanged(() => {
      void refresh();
    });
    return off;
  }, [refresh]);

  // Tip-jar status: load on mount and refresh on every inbox change.
  // The status is small (six fields) and main reads it from app_state
  // with three indexed lookups, so re-fetching on every push is cheap
  // and the banner appears the moment the user crosses the threshold
  // without the inbox needing its own "+1 on every complete" wiring.
  useEffect(() => {
    const load = async (): Promise<void> => {
      try {
        const status = await window.distill.app.getTipJarStatus();
        setTipJar(status);
      } catch (e) {
        // Failures here are non-fatal — the banner just doesn't show.
        // Log to the console so a curious developer notices, but
        // don't surface to the user.
        // eslint-disable-next-line no-console
        console.warn('failed to read tip-jar status', e);
      }
    };
    void load();
    const off = window.distill.onInboxChanged(() => {
      void load();
    });
    return off;
  }, []);

  // Banner dismiss handler. Hides locally first (so the click is
  // instant) and writes the sticky flag through main; failure to
  // persist is logged but the banner stays hidden for this session.
  const onDismissTipJar = useCallback(async (): Promise<void> => {
    setTipJar((prev) =>
      prev ? { ...prev, bannerDismissed: true, shouldShowBanner: false } : prev,
    );
    try {
      await window.distill.app.dismissTipJarBanner();
    } catch (e) {
      // eslint-disable-next-line no-console
      console.warn('failed to dismiss tip-jar banner', e);
    }
  }, []);

  const onOpenTipJar = useCallback((): void => {
    void window.distill.app.openTipJar();
  }, []);

  // Focus a specific recording when a notification is clicked.
  useEffect(() => {
    return window.distill.onFocusRecording((id) => {
      setFocusedId(id);
      requestAnimationFrame(() => {
        document
          .getElementById(`recording-${id}`)
          ?.scrollIntoView({ behavior: 'smooth', block: 'center' });
      });
    });
  }, []);

  // Esc closes. ⌘R refreshes.
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        void refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh]);

  // --- Action handlers -----------------------------------------------------

  const onSkip = useCallback(async (id: string) => {
    try {
      await window.distill.inbox.skip(id);
      setState((prev) =>
        prev.kind === 'ready'
          ? { kind: 'ready', recordings: prev.recordings.filter((r) => r.id !== id) }
          : prev,
      );
    } catch (e) {
      alert(`Could not skip: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);

  const onTag = useCallback((id: string) => {
    void window.distill.tag.open(id).catch((e) => alert(`Could not open tag sheet: ${String(e)}`));
  }, []);

  const onCancel = useCallback((id: string) => {
    void window.distill.pipeline.cancel(id).catch((e) => alert(`Could not cancel: ${String(e)}`));
  }, []);

  const onRetry = useCallback((id: string) => {
    void window.distill.pipeline.retry(id).catch((e) => alert(`Could not retry: ${String(e)}`));
  }, []);

  const onReveal = useCallback((id: string) => {
    void window.distill.inbox.revealInFinder(id).catch((e) => alert(`Could not reveal: ${String(e)}`));
  }, []);

  /**
   * Handler for the "Sign in again" button on auth-error rows. Opens
   * Settings on the Sources tab via the typed IPC. Errors here are
   * extremely unlikely (it's a window-open call) but we surface them
   * with the same alert pattern the other handlers use, for consistency.
   */
  const onOpenSources = useCallback(() => {
    void window.distill.app
      .openSettings({ tab: 'sources' })
      .catch((e) => alert(`Could not open Settings: ${String(e)}`));
  }, []);

  // --- Local file import ---------------------------------------------------

  /**
   * Append paths to the queue and kick the import loop. The loop is
   * idempotent — calling enqueueImports while the loop is already
   * running just adds the new items to the back of the queue and the
   * existing loop picks them up on its next iteration.
   */
  const enqueueImports = useCallback((paths: string[]): void => {
    if (paths.length === 0) return;
    const newEntries: ImportEntry[] = paths.map((p) => ({
      sourcePath: p,
      status: 'queued',
      phase: null,
      percent: null,
      error: null,
    }));
    setImportQueue((prev) => {
      const next = [...prev, ...newEntries];
      importQueueRef.current = next;
      return next;
    });
    void runImportLoop();
  }, []);

  /**
   * Drive the queue: pick the head item that's still 'queued', mark
   * it 'active', await the main-process import, then either remove it
   * (success) or mark it 'error' (failure). Repeats until no more
   * 'queued' items. Multiple invocations are coalesced via
   * importLoopRunningRef so spamming the + button can't start parallel
   * loops.
   */
  const runImportLoop = useCallback(async (): Promise<void> => {
    if (importLoopRunningRef.current) return;
    importLoopRunningRef.current = true;
    try {
      while (true) {
        const next = importQueueRef.current.find((e) => e.status === 'queued');
        if (!next) break;

        // Mark as active. Update both ref and state in lockstep.
        importQueueRef.current = importQueueRef.current.map((e) =>
          e.sourcePath === next.sourcePath && e.status === 'queued'
            ? { ...e, status: 'active' as const }
            : e,
        );
        setImportQueue(importQueueRef.current);

        try {
          const { recordingId } = await window.distill.localImport.importPath(
            next.sourcePath,
          );
          // Success: drop the queue entry. The recording row will
          // show up via the inbox-changed broadcast that the main
          // process fires after a successful import.
          setFocusedId(recordingId);
          importQueueRef.current = importQueueRef.current.filter(
            (e) => e.sourcePath !== next.sourcePath,
          );
          setImportQueue(importQueueRef.current);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          // Failure: stamp the entry with the error so the user can
          // see it in the queue and dismiss it.
          importQueueRef.current = importQueueRef.current.map((entry) =>
            entry.sourcePath === next.sourcePath
              ? { ...entry, status: 'error' as const, error: msg }
              : entry,
          );
          setImportQueue(importQueueRef.current);
        }
      }
    } finally {
      importLoopRunningRef.current = false;
    }
  }, []);

  const dismissQueueEntry = useCallback((sourcePath: string): void => {
    importQueueRef.current = importQueueRef.current.filter(
      (e) => e.sourcePath !== sourcePath,
    );
    setImportQueue(importQueueRef.current);
  }, []);

  const onPickAndImport = useCallback(async () => {
    // Step 1: open the picker. While the OS dialog is up, we are
    // explicitly NOT in any "importing" state — the user is just
    // browsing folders. Previously we set importing=true here, which
    // made the inbox show "Importing…" with no file picked yet, and
    // disabled the + button so a second pick was impossible.
    let paths: string[];
    try {
      paths = await window.distill.localImport.pickFiles();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      // Picker errors are rare (it's just a dialog open) but surface
      // them anyway via the same queue surface so the user sees them.
      enqueueImports([]);
      setImportQueue((prev) => [
        ...prev,
        {
          sourcePath: '(picker)',
          status: 'error',
          phase: null,
          percent: null,
          error: `Could not open picker: ${msg}`,
        },
      ]);
      return;
    }
    enqueueImports(paths);
  }, [enqueueImports]);

  // Drag-and-drop handlers for the entire window. macOS Dock drops go through
  // main/index.ts::open-file; these handlers cover drops onto the visible
  // inbox window itself (from Finder, Mail attachments, etc.).
  const onDragOver = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent<HTMLDivElement>) => {
    // relatedTarget is null when leaving the window entirely. Ignore
    // in-window transitions between child elements.
    if (!e.relatedTarget) setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent<HTMLDivElement>) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const paths: string[] = [];
      const failed: string[] = [];
      for (const f of files) {
        const p = window.distill.localImport.getPathForFile(f);
        if (p) paths.push(p);
        else failed.push(f.name);
      }
      if (failed.length > 0) {
        // Path resolution can fail in obscure cases (e.g. a sandboxed
        // dragged item with no underlying filesystem path). Stamp a
        // synthetic error entry so the user knows; it's dismissable
        // like any other queue entry.
        setImportQueue((prev) => [
          ...prev,
          {
            sourcePath: `(drop) ${failed.join(', ')}`,
            status: 'error',
            phase: null,
            percent: null,
            error:
              `Could not resolve ${failed.length} file(s) to a path. ` +
              `This usually means they came from a sandboxed source. Try the + button instead.`,
          },
        ]);
      }
      enqueueImports(paths);
    },
    [enqueueImports],
  );

  // --- Listen for progress events from main --------------------------------

  useEffect(() => {
    return window.distill.onLocalImportProgress((p: LocalImportProgressEvent) => {
      // Update the matching active entry. Out-of-order events for an
      // entry that's already been marked done/error are ignored — the
      // refs/state pair has already moved on.
      importQueueRef.current = importQueueRef.current.map((e) =>
        e.sourcePath === p.sourcePath && e.status === 'active'
          ? { ...e, phase: p.phase, percent: p.percent }
          : e,
      );
      setImportQueue(importQueueRef.current);
    });
  }, []);

  // --- Section partitioning ------------------------------------------------

  const sections = useMemo(() => bucket(state), [state]);

  // --- Render --------------------------------------------------------------

  if (state.kind === 'loading') {
    return (
      <Shell
        refreshing={refreshing}
        onRefresh={refresh}
        total={0}
        dragOver={dragOver}
        importQueue={importQueue}
        dismissQueueEntry={dismissQueueEntry}
        onPickAndImport={onPickAndImport}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        tipJar={tipJar}
        onDismissTipJar={onDismissTipJar}
        onOpenTipJar={onOpenTipJar}
      >
        <div style={{ padding: 24, color: 'var(--fg-muted)', textAlign: 'center' }}>Loading…</div>
      </Shell>
    );
  }

  if (state.kind === 'error') {
    return (
      <Shell
        refreshing={refreshing}
        onRefresh={refresh}
        total={0}
        dragOver={dragOver}
        importQueue={importQueue}
        dismissQueueEntry={dismissQueueEntry}
        onPickAndImport={onPickAndImport}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        tipJar={tipJar}
        onDismissTipJar={onDismissTipJar}
        onOpenTipJar={onOpenTipJar}
      >
        <div style={{ padding: 24 }}>
          <div style={{ marginBottom: 12 }}>Could not load the inbox.</div>
          <div
            className="muted"
            style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}
          >
            {state.message}
          </div>
          <button style={{ marginTop: 12 }} onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  // Header count shows what needs the user's attention: everything
  // except already-completed rows. The bucket() partition handles this
  // for us — sum the four "still relevant" sections. Completed rows
  // are kept in state so the Recent section can render them, but they
  // don't contribute to the headline number.
  const headerCount =
    sections.processing.length +
    sections.waiting.length +
    sections.errored.length +
    sections.cancelled.length;
  const total = state.recordings.length;
  if (total === 0) {
    return (
      <Shell
        refreshing={refreshing}
        onRefresh={refresh}
        total={0}
        dragOver={dragOver}
        importQueue={importQueue}
        dismissQueueEntry={dismissQueueEntry}
        onPickAndImport={onPickAndImport}
        onDragOver={onDragOver}
        onDragLeave={onDragLeave}
        onDrop={onDrop}
        tipJar={tipJar}
        onDismissTipJar={onDismissTipJar}
        onOpenTipJar={onOpenTipJar}
      >
        <div
          style={{
            padding: 32,
            color: 'var(--fg-muted)',
            textAlign: 'center',
            fontSize: 12,
          }}
        >
          Nothing here.
          <br />
          New recordings will show up as Plaud syncs.
          <br />
          <span style={{ fontStyle: 'italic' }}>
            Or drop an mp3/mp4 here to import.
          </span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell
      refreshing={refreshing}
      onRefresh={refresh}
      total={headerCount}
      dragOver={dragOver}
      importQueue={importQueue}
      dismissQueueEntry={dismissQueueEntry}
      onPickAndImport={onPickAndImport}
      onDragOver={onDragOver}
      onDragLeave={onDragLeave}
      onDrop={onDrop}
      tipJar={tipJar}
      onDismissTipJar={onDismissTipJar}
      onOpenTipJar={onOpenTipJar}
    >
      {sections.processing.length > 0 && (
        <Section title="Processing" count={sections.processing.length}>
          {sections.processing.map((r) => (
            <ProcessingRow key={r.id} r={r} focused={focusedId === r.id} onCancel={onCancel} />
          ))}
        </Section>
      )}

      {sections.waiting.length > 0 && (
        <Section title="Waiting to tag" count={sections.waiting.length}>
          {sections.waiting.map((r) => (
            <WaitingRow key={r.id} r={r} focused={focusedId === r.id} onTag={onTag} onSkip={onSkip} />
          ))}
        </Section>
      )}

      {sections.errored.length > 0 && (
        <Section title="Errors" count={sections.errored.length}>
          {sections.errored.map((r) => (
            <ErrorRow
              key={r.id}
              r={r}
              focused={focusedId === r.id}
              onRetry={onRetry}
              onSkip={onSkip}
              onOpenSources={onOpenSources}
            />
          ))}
        </Section>
      )}

      {sections.cancelled.length > 0 && (
        <Section title="Cancelled" count={sections.cancelled.length}>
          {sections.cancelled.map((r) => (
            <CancelledRow key={r.id} r={r} focused={focusedId === r.id} onRetry={onRetry} onSkip={onSkip} />
          ))}
        </Section>
      )}

      {sections.complete.length > 0 && (
        <Section title="Recent" count={sections.complete.length} defaultCollapsed>
          {sections.complete.map((r) => (
            <CompleteRow key={r.id} r={r} focused={focusedId === r.id} onReveal={onReveal} onSkip={onSkip} />
          ))}
        </Section>
      )}
    </Shell>
  );
}

// ---------------------------------------------------------------------------
// Bucket rows by status.
// ---------------------------------------------------------------------------

interface Buckets {
  processing: InboxRecordingDTO[];
  waiting: InboxRecordingDTO[];
  errored: InboxRecordingDTO[];
  cancelled: InboxRecordingDTO[];
  complete: InboxRecordingDTO[];
}

function bucket(state: LoadState): Buckets {
  const out: Buckets = {
    processing: [],
    waiting: [],
    errored: [],
    cancelled: [],
    complete: [],
  };
  if (state.kind !== 'ready') return out;
  for (const r of state.recordings) {
    switch (r.status) {
      case 'tagged':
      case 'downloading':
      case 'transcribing':
      case 'summarising':
      case 'writing':
        out.processing.push(r);
        break;
      case 'inbox':
        out.waiting.push(r);
        break;
      case 'error':
        out.errored.push(r);
        break;
      case 'cancelled':
        out.cancelled.push(r);
        break;
      case 'complete':
        out.complete.push(r);
        break;
      // 'skipped' is filtered out by the server-side listActiveJoined query.
    }
  }
  return out;
}

// ---------------------------------------------------------------------------
// Layout shell + section scaffold
// ---------------------------------------------------------------------------

function Shell(props: {
  refreshing: boolean;
  onRefresh: () => void | Promise<void>;
  total: number;
  children: React.ReactNode;
  dragOver: boolean;
  importQueue: ImportEntry[];
  dismissQueueEntry: (sourcePath: string) => void;
  onPickAndImport: () => void | Promise<void>;
  onDragOver: (e: React.DragEvent<HTMLDivElement>) => void;
  onDragLeave: (e: React.DragEvent<HTMLDivElement>) => void;
  onDrop: (e: React.DragEvent<HTMLDivElement>) => void | Promise<void>;
  /**
   * Tip-jar status, null until the initial fetch resolves. The
   * Shell renders the threshold banner when status is non-null AND
   * status.shouldShowBanner is true. Passing the whole DTO rather
   * than just a boolean lets the banner copy reference the actual
   * threshold value ("You've completed N summaries…") without
   * hard-coding 50 in renderer code.
   */
  tipJar: TipJarStatusDTO | null;
  onDismissTipJar: () => void | Promise<void>;
  onOpenTipJar: () => void;
}): JSX.Element {
  const activeOrQueued = props.importQueue.filter(
    (e) => e.status === 'queued' || e.status === 'active',
  ).length;

  return (
    <div
      style={{
        display: 'flex',
        flexDirection: 'column',
        height: '100%',
        position: 'relative',
      }}
      onDragOver={props.onDragOver}
      onDragLeave={props.onDragLeave}
      onDrop={(e) => void props.onDrop(e)}
    >
      <header
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600 }}>Inbox</div>
        <div className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {props.total > 0 ? `${props.total} total` : ''}
        </div>
        {/*
          The + button is intentionally NOT disabled while imports are
          in flight — the user can keep adding files to the queue and
          the loop will pick them up. Previously this was disabled
          during the OS file picker too, which made queueing impossible.
        */}
        <HeaderButton
          title="Import audio or video…"
          onClick={() => void props.onPickAndImport()}
        >
          +
        </HeaderButton>
        <HeaderButton
          title="Refresh (⌘R)"
          onClick={() => void props.onRefresh()}
          disabled={props.refreshing}
        >
          {props.refreshing ? '⋯' : '↻'}
        </HeaderButton>
        <HeaderButton title="Close (Esc)" onClick={() => window.close()}>
          ×
        </HeaderButton>
      </header>

      {props.tipJar && props.tipJar.shouldShowBanner && (
        <TipJarBanner
          status={props.tipJar}
          onDismiss={() => void props.onDismissTipJar()}
          onOpen={props.onOpenTipJar}
        />
      )}

      {props.importQueue.length > 0 && (
        <ImportQueuePanel
          entries={props.importQueue}
          onDismiss={props.dismissQueueEntry}
          activeOrQueued={activeOrQueued}
        />
      )}

      <main style={{ flexGrow: 1, overflowY: 'auto' }}>{props.children}</main>

      {props.dragOver && (
        <div
          style={{
            position: 'absolute',
            inset: 0,
            pointerEvents: 'none',
            border: '3px dashed var(--accent)',
            background: 'rgba(59, 130, 246, 0.08)',
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            zIndex: 10,
          }}
        >
          <div
            style={{
              padding: '16px 24px',
              background: 'var(--bg)',
              border: '1px solid var(--border)',
              borderRadius: 8,
              textAlign: 'center',
              fontSize: 13,
              fontWeight: 500,
            }}
          >
            Drop to import
            <div
              className="muted"
              style={{ fontSize: 11, fontWeight: 400, marginTop: 4 }}
            >
              Audio: mp3 m4a wav aac ogg flac opus
              <br />
              Video: mp4 mov m4v mkv webm (needs ffmpeg)
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

function Section(props: {
  title: string;
  count: number;
  children: React.ReactNode;
  /**
   * If true, the section starts in the collapsed state on mount. The user
   * can still expand it by clicking the header. We deliberately don't
   * persist the expanded/collapsed state across launches: "Recent" is the
   * only collapsed-by-default section today, and the design intent is
   * that the inbox should be quiet by default. If you wanted yesterday's
   * recent open, you'd open it; the next launch starts fresh.
   */
  defaultCollapsed?: boolean;
}): JSX.Element {
  const [collapsed, setCollapsed] = useState(props.defaultCollapsed ?? false);
  return (
    <section>
      <button
        type="button"
        onClick={() => setCollapsed((c) => !c)}
        style={{
          // Style the header as a clickable banner. We previously used
          // `all: 'unset'` here as a one-line reset, but that interacted
          // badly with the surrounding styles in some browser versions
          // (the click target became unreliable for the Recent section
          // specifically). Spelling out the resets we want avoids that
          // and keeps the visual identical.
          appearance: 'none',
          WebkitAppearance: 'none',
          border: 'none',
          margin: 0,
          textAlign: 'left',
          font: 'inherit',
          display: 'block',
          width: '100%',
          boxSizing: 'border-box',
          cursor: 'pointer',
          padding: '8px 14px 4px',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          borderTop: '1px solid var(--border)',
          background: 'var(--row-hover)',
        }}
        aria-expanded={!collapsed}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 10,
            marginRight: 4,
            // Rotated triangle, no font dependency. Plain ASCII chevron
            // would also work but the triangle scales nicely with font size.
            transform: collapsed ? 'rotate(0deg)' : 'rotate(90deg)',
            transition: 'transform 120ms',
          }}
        >
          ▸
        </span>
        {props.title} <span style={{ fontWeight: 400 }}>· {props.count}</span>
      </button>
      {!collapsed && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{props.children}</ul>
      )}
    </section>
  );
}

// ---------------------------------------------------------------------------
// Row variants
// ---------------------------------------------------------------------------

function Row(props: { id: string; focused: boolean; children: React.ReactNode }): JSX.Element {
  return (
    <li
      id={`recording-${props.id}`}
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: props.focused ? 'var(--row-hover)' : 'transparent',
      }}
    >
      {props.children}
    </li>
  );
}

function Title({ r }: { r: InboxRecordingDTO }): JSX.Element {
  return (
    <div className="ellipsis" style={{ fontWeight: 500, marginBottom: 2 }}>
      {r.filename}
    </div>
  );
}

function MetaLine({ r }: { r: InboxRecordingDTO }): JSX.Element {
  const tag =
    r.clientName && r.meetingTypeName ? `${r.clientName} · ${r.meetingTypeName}` : null;
  return (
    <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
      {formatWhen(r.start_time, r.synced_at)} · {formatDuration(r.duration_seconds)}
      {tag ? ` · ${tag}` : ''}
    </div>
  );
}

function ProcessingRow(props: {
  r: InboxRecordingDTO;
  focused: boolean;
  onCancel: (id: string) => void;
}): JSX.Element {
  const { r } = props;
  const stepLabel = r.status === 'tagged' ? 'Queued' : humanStep(r.currentStep) + '…';
  return (
    <Row id={r.id} focused={props.focused}>
      <Title r={r} />
      <MetaLine r={r} />
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: 'var(--accent)',
          marginBottom: 8,
        }}
      >
        <Spinner />
        <span>{stepLabel}</span>
      </div>
      <div className="row">
        <button onClick={() => props.onCancel(r.id)}>Cancel</button>
      </div>
    </Row>
  );
}

function WaitingRow(props: {
  r: InboxRecordingDTO;
  focused: boolean;
  onTag: (id: string) => void;
  onSkip: (id: string) => void | Promise<void>;
}): JSX.Element {
  const lengthHint = describeDurationRisk(props.r.duration_seconds);
  return (
    <Row id={props.r.id} focused={props.focused}>
      <Title r={props.r} />
      <MetaLine r={props.r} />
      {lengthHint && (
        <div
          style={{
            fontSize: 11,
            marginBottom: 8,
            color: lengthHint.severity === 'red' ? 'var(--danger)' : 'var(--warning, #b58900)',
          }}
          title={lengthHint.tooltip}
        >
          ⚠ {lengthHint.message}
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={() => props.onTag(props.r.id)}>
          Tag &amp; process
        </button>
        <button onClick={() => void props.onSkip(props.r.id)}>Skip</button>
      </div>
    </Row>
  );
}

function ErrorRow(props: {
  r: InboxRecordingDTO;
  focused: boolean;
  onRetry: (id: string) => void;
  onSkip: (id: string) => void | Promise<void>;
  onOpenSources: () => void;
}): JSX.Element {
  return (
    <Row id={props.r.id} focused={props.focused}>
      <Title r={props.r} />
      <MetaLine r={props.r} />
      {props.r.error && (
        <div
          style={{
            fontSize: 11,
            color: 'var(--danger)',
            marginBottom: 8,
            fontFamily: 'ui-monospace, Menlo, monospace',
            whiteSpace: 'pre-wrap',
          }}
        >
          {props.r.error}
        </div>
      )}
      <div className="row">
        {props.r.isAuthError ? (
          <button className="primary" onClick={props.onOpenSources}>
            Sign in again
          </button>
        ) : (
          <button className="primary" onClick={() => props.onRetry(props.r.id)}>
            Retry
          </button>
        )}
        {/*
          Auth-error rows still get a Retry button, just demoted from
          primary. The user might fix the underlying auth issue (sign
          in via Sources, then come back here) and want to re-run the
          row without it landing back in 'tagged' before they're ready.
        */}
        {props.r.isAuthError && (
          <button onClick={() => props.onRetry(props.r.id)}>Retry</button>
        )}
        <button onClick={() => void props.onSkip(props.r.id)}>Skip</button>
      </div>
    </Row>
  );
}

function CancelledRow(props: {
  r: InboxRecordingDTO;
  focused: boolean;
  onRetry: (id: string) => void;
  onSkip: (id: string) => void | Promise<void>;
}): JSX.Element {
  return (
    <Row id={props.r.id} focused={props.focused}>
      <Title r={props.r} />
      <MetaLine r={props.r} />
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Cancelled
      </div>
      <div className="row">
        <button className="primary" onClick={() => props.onRetry(props.r.id)}>
          Resume
        </button>
        <button onClick={() => void props.onSkip(props.r.id)}>Dismiss</button>
      </div>
    </Row>
  );
}

function CompleteRow(props: {
  r: InboxRecordingDTO;
  focused: boolean;
  onReveal: (id: string) => void;
  onSkip: (id: string) => void | Promise<void>;
}): JSX.Element {
  const { r } = props;
  const vocabLine =
    r.vocabularyRulesApplied != null && r.vocabularyRulesApplied > 0
      ? `${r.vocabularyRulesApplied} correction${r.vocabularyRulesApplied === 1 ? '' : 's'} applied${
          r.vocabularySources ? ` · ${r.vocabularySources.split(',').join(' + ')}` : ''
        }`
      : null;
  // Truncation tooltip carries the actual numbers from submit time so
  // a curious user can see how badly the row exceeded its budget. Falls
  // back to a generic message if the tokens fields are null (rows
  // summarised before this feature shipped won't have them populated).
  const truncationTooltip =
    r.estimatedInputTokens !== null && r.contextWindowAtSubmit !== null
      ? `Estimated input ${r.estimatedInputTokens.toLocaleString()} tokens against a ${r.contextWindowAtSubmit.toLocaleString()}-token context window. The model silently truncates the start of the input when this happens, so the early part of the meeting may be missing from the summary.`
      : 'Input was likely larger than the model context window; the summary may be missing detail from the start of the meeting.';
  // Cross-machine hint copy. Pulls the model name when available so the
  // user knows which model produced the summary on the other machine
  // (M4 with 48GB runs qwen2.5:32b; M5 with 24GB would run qwen2.5:14b).
  // The hint is informational only — the row behaves like any other
  // complete row, with a Reveal in Finder button pointing at the
  // existing markdown file.
  const externalLabel = r.modelSnapshot
    ? `Processed on another machine (summary by ${r.modelSnapshot})`
    : 'Processed on another machine';
  const externalTooltip =
    'This recording was processed on another Mac and its Markdown output ' +
    'was found via iCloud Drive. The pipeline did not run on this machine, ' +
    'so the summary reflects whatever model the other machine used. To ' +
    're-run on this machine, delete the Markdown file and tag the recording ' +
    'again on the next poll.';
  return (
    <Row id={r.id} focused={props.focused}>
      <Title r={r} />
      <MetaLine r={r} />
      {r.processedExternally && (
        <div
          style={{
            fontSize: 11,
            marginBottom: 8,
            color: 'var(--fg-muted)',
            display: 'flex',
            alignItems: 'center',
            gap: 4,
          }}
          title={externalTooltip}
        >
          📁 {externalLabel}
        </div>
      )}
      {r.truncationWarning && (
        <div
          style={{
            fontSize: 11,
            marginBottom: 8,
            color: 'var(--warning, #b58900)',
          }}
          title={truncationTooltip}
        >
          ⚠ Long meeting — summary may be missing detail from the start.
        </div>
      )}
      {vocabLine && (
        <div
          className="muted"
          style={{ fontSize: 11, marginBottom: 8, fontStyle: 'italic' }}
          title="Vocabulary corrections applied during transcription"
        >
          {vocabLine}
        </div>
      )}
      <div className="row">
        <button className="primary" onClick={() => props.onReveal(r.id)}>
          Reveal in Finder
        </button>
        <button onClick={() => void props.onSkip(r.id)}>Dismiss</button>
      </div>
    </Row>
  );
}

// ---------------------------------------------------------------------------
// Tiny helpers
// ---------------------------------------------------------------------------

/**
 * Threshold-celebration banner for the inbox. Rendered just under
 * the header and above the import queue when the user crosses
 * `tipJar.threshold` completed summaries AND hasn't dismissed the
 * banner yet. Wording leans on the user's own evidence — they've
 * actually used the app N times — rather than a cold marketing
 * pitch.
 *
 * Visual: amber-leaning soft strip, distinct from the import queue's
 * neutral row-hover background. Two actions:
 *   - “Buy me a coffee” primary button → opens the tip-jar URL
 *   - "Not now" link  → dismisses (sticky; never shown again on
 *                       this install)
 *
 * The banner intentionally does NOT auto-dismiss after clicking the
 * primary action: a user who clicked "Buy me a coffee" might want
 * to come back and confirm later, or the click might have gone to
 * a misclick — they shouldn't lose the banner without explicitly
 * dismissing.
 */
function TipJarBanner(props: {
  status: TipJarStatusDTO;
  onDismiss: () => void;
  onOpen: () => void;
}): JSX.Element {
  return (
    <div
      role="region"
      aria-label="Support development"
      style={{
        padding: '10px 14px',
        borderBottom: '1px solid var(--border)',
        background: 'rgba(245, 158, 11, 0.08)',
        display: 'flex',
        alignItems: 'center',
        gap: 12,
      }}
    >
      <div style={{ flex: 1, fontSize: 12, lineHeight: 1.4 }}>
        <div style={{ fontWeight: 500, marginBottom: 2 }}>
          {props.status.completionCount} summaries done — nice work
        </div>
        <div className="muted" style={{ fontSize: 11 }}>
          Glad distill is earning its keep. If you'd like to support
          development, you can keep me caffeinated.
        </div>
      </div>
      <button
        className="primary"
        onClick={props.onOpen}
        style={{ fontSize: 12 }}
        title={`Opens ${props.status.url} in your default browser`}
      >
        Buy me a coffee
      </button>
      <button
        onClick={props.onDismiss}
        style={{
          fontSize: 11,
          background: 'transparent',
          border: 'none',
          color: 'var(--fg-muted)',
          cursor: 'pointer',
          padding: '4px 6px',
        }}
        title="Hide this banner. It won't come back."
      >
        Not now
      </button>
    </div>
  );
}

/**
 * Translate a recording's duration into a pre-tag risk hint shown on
 * the WaitingRow. Yellow at 1h30m+, red at 3h+. Below 1h30m we show
 * nothing — most meetings are fine and a hint on every row would
 * become noise. Returns null when there's nothing to surface.
 *
 * Why duration and not estimated tokens? At pre-tag time we have only
 * the duration; the transcript hasn't been produced yet. Conversational
 * speech runs ~150 words/min so a 3h meeting is ~27,000 words ≈ 36k
 * tokens — already over the new 64k budget once you add the prompt
 * and output reserve, and a real risk of truncation. The 1h30m
 * yellow threshold is conservative: at typical rates that's 13,500
 * words ≈ 18k tokens, comfortably under 64k. The hint there is
 * "summary quality may suffer" rather than "likely to truncate" —
 * model attention spreads thin across long context even before
 * truncation kicks in.
 */
function describeDurationRisk(durationSeconds: number | null): null | {
  severity: 'yellow' | 'red';
  message: string;
  tooltip: string;
} {
  if (durationSeconds == null) return null;
  // 3h = 10800s. Above this we expect risk of truncation against the
  // new 64k context window and definitely degraded attention.
  if (durationSeconds >= 10800) {
    return {
      severity: 'red',
      message: 'Very long meeting — summary likely to lose detail.',
      tooltip:
        'Meetings over 3 hours often exceed the model’s context window after transcription. ' +
        'The model will silently truncate the start of the input and the summary may be missing earlier topics.',
    };
  }
  // 1h30m = 5400s. Below truncation risk but model attention starts
  // thinning out across very long context.
  if (durationSeconds >= 5400) {
    return {
      severity: 'yellow',
      message: 'Long meeting — summary quality may suffer.',
      tooltip:
        'Long meetings produce long transcripts. The model can still summarise them, ' +
        'but its attention spreads more thinly so finer points are easier to miss. ' +
        'Worth re-reading against the source if anything seems off.',
    };
  }
  return null;
}

function humanStep(step: PipelineStep | null): string {
  switch (step) {
    case 'download':
      return 'Downloading';
    case 'transcribe':
      return 'Transcribing';
    case 'summarise':
      return 'Summarising';
    case 'write':
      return 'Writing markdown';
    default:
      return 'Processing';
  }
}

function Spinner(): JSX.Element {
  return (
    <span
      style={{
        display: 'inline-block',
        width: 10,
        height: 10,
        border: '2px solid var(--accent)',
        borderRightColor: 'transparent',
        borderRadius: '50%',
        animation: 'plaud-spin 0.7s linear infinite',
      }}
    />
  );
}

function HeaderButton(props: {
  title: string;
  onClick: () => void;
  disabled?: boolean;
  children: React.ReactNode;
}): JSX.Element {
  return (
    <button
      title={props.title}
      onClick={props.onClick}
      disabled={props.disabled}
      style={{
        padding: '2px 8px',
        fontSize: 14,
        lineHeight: 1,
        minWidth: 24,
      }}
    >
      {props.children}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Import queue panel
//
// Renders a fixed-position banner under the header showing every
// in-flight or errored import. Successful imports drop out of the
// queue and become regular inbox rows via the inbox-changed broadcast.
//
// Each row shows:
//   - the file's basename (full path on hover via title)
//   - the current phase (queued, copying, extracting, etc.)
//   - a percentage if known
//   - a progress bar for active imports
//   - the error message + a dismiss button on errored rows
// ---------------------------------------------------------------------------

function ImportQueuePanel(props: {
  entries: ImportEntry[];
  onDismiss: (sourcePath: string) => void;
  activeOrQueued: number;
}): JSX.Element {
  return (
    <div
      role="region"
      aria-label="Imports in progress"
      style={{
        borderBottom: '1px solid var(--border)',
        background: 'var(--row-hover)',
      }}
    >
      <div
        style={{
          padding: '6px 14px',
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: '0.05em',
          textTransform: 'uppercase',
          color: 'var(--fg-muted)',
          display: 'flex',
          alignItems: 'center',
          gap: 6,
        }}
      >
        <span>Imports</span>
        <span style={{ fontWeight: 400 }}>
          · {props.entries.length}
          {props.activeOrQueued > 0 && ` (${props.activeOrQueued} pending)`}
        </span>
      </div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {props.entries.map((e) => (
          <ImportQueueRow
            key={e.sourcePath}
            entry={e}
            onDismiss={() => props.onDismiss(e.sourcePath)}
          />
        ))}
      </ul>
    </div>
  );
}

function ImportQueueRow(props: {
  entry: ImportEntry;
  onDismiss: () => void;
}): JSX.Element {
  const e = props.entry;
  // Display the basename without leaning on path libraries (renderer
  // is sandboxed, no node imports). The user's title attribute gets
  // the full path for context.
  const lastSlash = Math.max(e.sourcePath.lastIndexOf('/'), e.sourcePath.lastIndexOf('\\'));
  const basename = lastSlash >= 0 ? e.sourcePath.slice(lastSlash + 1) : e.sourcePath;

  return (
    <li
      title={e.sourcePath}
      style={{
        padding: '8px 14px',
        borderTop: '1px solid var(--border)',
        fontSize: 12,
      }}
    >
      <div
        className="ellipsis"
        style={{ fontWeight: 500, marginBottom: 4 }}
      >
        {basename}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color:
            e.status === 'error' ? 'var(--danger)' : 'var(--fg-muted)',
        }}
      >
        <span>{describeImportStatus(e)}</span>
        {e.status === 'active' && (
          <ImportProgressBar percent={e.percent} />
        )}
        {e.status === 'error' && (
          <button onClick={props.onDismiss} style={{ marginLeft: 'auto', fontSize: 11 }}>
            Dismiss
          </button>
        )}
      </div>
      {e.error && (
        <div
          style={{
            marginTop: 6,
            color: 'var(--danger)',
            fontFamily: 'ui-monospace, Menlo, monospace',
            fontSize: 11,
            whiteSpace: 'pre-wrap',
          }}
        >
          {e.error}
        </div>
      )}
    </li>
  );
}

/**
 * Render a thin determinate progress bar at the given percent. Falls
 * back to an indeterminate striped animation when percent is null.
 */
function ImportProgressBar(props: { percent: number | null }): JSX.Element {
  const p = props.percent;
  return (
    <div
      style={{
        flex: 1,
        height: 4,
        borderRadius: 2,
        overflow: 'hidden',
        background: 'var(--border)',
        position: 'relative',
      }}
    >
      <div
        style={{
          width: p === null ? '100%' : `${p}%`,
          height: '100%',
          background: 'var(--accent)',
          // Indeterminate: gentle pulse via opacity. Keeps the CSS
          // surface here tiny; if we ever want a sliding stripe we
          // can move this into shared/styles.css.
          opacity: p === null ? 0.6 : 1,
          transition: 'width 200ms linear',
        }}
      />
    </div>
  );
}

function describeImportStatus(e: ImportEntry): string {
  if (e.status === 'queued') return 'Queued';
  if (e.status === 'error') return 'Failed';
  // 'active'
  switch (e.phase) {
    case 'probe':
      return 'Reading file…';
    case 'copy':
      return e.percent !== null ? `Copying audio… ${e.percent}%` : 'Copying audio…';
    case 'extract':
      return e.percent !== null
        ? `Extracting audio… ${e.percent}%`
        : 'Extracting audio…';
    case 'finalise':
      return 'Finalising…';
    default:
      return 'Importing…';
  }
}

// The spinner CSS animation lives in src/renderer/shared/styles.css
// (keyframes plaud-spin). Keeping it there instead of a module-level side
// effect here means this module is safely importable in tests.

// RecordingStatus is only imported for type-level completeness on the bucket
// switch above. Reference it so TypeScript doesn't complain about the import.
type _StatusKeep = RecordingStatus;
void ({} as _StatusKeep);

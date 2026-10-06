import { MeetingSearch } from './MeetingSearch.js';
import { resolveInboxDrop } from './importFiles.js';
import { useCalendarImport } from './useCalendarImport.js';
import { EssenceLogo } from '../essence/EssenceLogo.js';
import { useEssenceActivity } from '../essence/useEssenceActivity.js';
import type { EssenceActivity } from '../essence/tokens.js';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type {
  ClientDTO,
  InboxItemDTO,
  MeetingTypeDTO,
  LocalImportProgressDTO,
  PipelineStep,
  TipJarStatusDTO,
} from '../shared/api.js';
import {
  formatDuration,
  formatWhen,
  Row,
  Title,
  MetaLine,
  OutputLinks,
  FullRerunButton,
  OutputTargetPicker,
} from '../shared/recordingRow.js';

type InboxState =
  | { kind: 'loading' }
  | { kind: 'ready'; recordings: InboxItemDTO[] }
  | { kind: 'error'; message: string };

interface ImportQueueEntry {
  sourcePath: string;
  status: 'queued' | 'active' | 'error';
  phase: LocalImportProgressDTO['phase'] | null;
  percent: number | null;
  error: string | null;
}

function Inbox() {
  const [state, setState] = useState<InboxState>({ kind: 'loading' });
  const [focusedId, setFocusedId] = useState<string | null>(null);
  const [refreshing, setRefreshing] = useState(false);
  const [dragOver, setDragOver] = useState(false);
  const [importQueue, setImportQueue] = useState<ImportQueueEntry[]>([]);
  const importQueueRef = useRef<ImportQueueEntry[]>([]);
  const importLoopRunningRef = useRef(false);
  const [tipJar, setTipJar] = useState<TipJarStatusDTO | null>(null);
  const calendar = useCalendarImport();
  const importCalendarPdfs = calendar.importPdfs;

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

  useEffect(() => {
    void refresh();
    const off = window.distill.onInboxChanged(() => {
      void refresh();
    });
    return off;
  }, [refresh]);

  useEffect(() => {
    const load = async () => {
      try {
        const status = await window.distill.app.getTipJarStatus();
        setTipJar(status);
      } catch (e) {
        console.warn('failed to read tip-jar status', e);
      }
    };
    void load();
    const off = window.distill.onInboxChanged(() => {
      void load();
    });
    return off;
  }, []);

  const onDismissTipJar = useCallback(async () => {
    setTipJar((prev) => (prev ? { ...prev, bannerDismissed: true, shouldShowBanner: false } : prev));
    try {
      await window.distill.app.dismissTipJarBanner();
    } catch (e) {
      console.warn('failed to dismiss tip-jar banner', e);
    }
  }, []);

  const onOpenTipJar = useCallback(() => {
    void window.distill.app.openTipJar();
  }, []);

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

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
      if ((e.metaKey || e.ctrlKey) && e.key === 'r') {
        e.preventDefault();
        void refresh();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [refresh]);

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

  const onToggleUrgent = useCallback((id: string, urgent: boolean) => {
    void window.distill.pipeline.setUrgent(id, urgent).catch((e) => alert(`Could not update: ${String(e)}`));
  }, []);


  const onReveal = useCallback((id: string) => {
    void window.distill.inbox.revealInFinder(id).catch((e) => alert(`Could not reveal: ${String(e)}`));
  }, []);

  const onOpenSources = useCallback(() => {
    void window.distill.app
      .openSettings({ tab: 'sources' })
      .catch((e) => alert(`Could not open Settings: ${String(e)}`));
  }, []);

  const runImportLoop = useCallback(async () => {
    if (importLoopRunningRef.current) return;
    importLoopRunningRef.current = true;
    try {
      while (true) {
        const next = importQueueRef.current.find((e) => e.status === 'queued');
        if (!next) break;
        importQueueRef.current = importQueueRef.current.map((e) =>
          e.sourcePath === next.sourcePath && e.status === 'queued' ? { ...e, status: 'active' } : e,
        );
        setImportQueue(importQueueRef.current);
        try {
          const { recordingId } = await window.distill.localImport.importPath(next.sourcePath);
          setFocusedId(recordingId);
          importQueueRef.current = importQueueRef.current.filter(
            (e) => e.sourcePath !== next.sourcePath,
          );
          setImportQueue(importQueueRef.current);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          importQueueRef.current = importQueueRef.current.map((entry) =>
            entry.sourcePath === next.sourcePath ? { ...entry, status: 'error', error: msg } : entry,
          );
          setImportQueue(importQueueRef.current);
        }
      }
    } finally {
      importLoopRunningRef.current = false;
    }
  }, []);

  const enqueueImports = useCallback(
    (paths: string[]) => {
      if (paths.length === 0) return;
      const newEntries: ImportQueueEntry[] = paths.map((p) => ({
        sourcePath: p,
        status: 'queued',
        phase: null,
        percent: null,
        error: null,
      }));
      // The ref must be updated synchronously, before the loop starts.
      // This previously assigned it inside a setImportQueue updater —
      // but React runs updaters during the render phase, i.e. after this
      // handler returns, so runImportLoop() read a stale ref, found
      // nothing queued and exited immediately. The entry then sat at
      // "queued · pending" forever with nothing to restart it.
      importQueueRef.current = [...importQueueRef.current, ...newEntries];
      setImportQueue(importQueueRef.current);
      void runImportLoop();
    },
    [runImportLoop],
  );

  const dismissQueueEntry = useCallback((sourcePath: string) => {
    importQueueRef.current = importQueueRef.current.filter((e) => e.sourcePath !== sourcePath);
    setImportQueue(importQueueRef.current);
  }, []);

  // Safety net for the same class of problem: if anything ever leaves an
  // entry queued while the loop isn't running (a throw between enqueue
  // and start, say), pick it back up rather than stranding it.
  useEffect(() => {
    if (importLoopRunningRef.current) return;
    if (importQueue.some((e) => e.status === 'queued')) {
      void runImportLoop();
    }
  }, [importQueue, runImportLoop]);

  const onPickAndImport = useCallback(async () => {
    let paths: string[];
    try {
      paths = await window.distill.localImport.pickFiles();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
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

  const onDragOver = useCallback((e: React.DragEvent) => {
    if (e.dataTransfer.types.includes('Files')) {
      e.preventDefault();
      e.dataTransfer.dropEffect = 'copy';
      setDragOver(true);
    }
  }, []);

  const onDragLeave = useCallback((e: React.DragEvent) => {
    if (!e.relatedTarget) setDragOver(false);
  }, []);

  const onDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const { calendarPaths, recordingPaths, unresolvedNames } = resolveInboxDrop(
        files,
        window.distill.localImport.getPathForFile,
      );
      if (unresolvedNames.length > 0) {
        importQueueRef.current = [
          ...importQueueRef.current,
          {
            sourcePath: `(drop) ${unresolvedNames.join(', ')}`,
            status: 'error',
            phase: null,
            percent: null,
            error: `Could not resolve ${unresolvedNames.length} file(s) to a path. Try Import calendar PDFs… for calendar printouts, or the + button for recordings and transcripts.`,
          },
        ];
        setImportQueue(importQueueRef.current);
      }
      if (calendarPaths.length > 0) void importCalendarPdfs(calendarPaths);
      enqueueImports(recordingPaths);
    },
    [enqueueImports, importCalendarPdfs],
  );

  useEffect(() => {
    return window.distill.onLocalImportProgress((p) => {
      importQueueRef.current = importQueueRef.current.map((e) =>
        e.sourcePath === p.sourcePath && e.status === 'active'
          ? { ...e, phase: p.phase, percent: p.percent }
          : e,
      );
      setImportQueue(importQueueRef.current);
    });
  }, []);

  const sections = useMemo(() => bucket(state), [state]);
  const { activity, completionKey } = useEssenceActivity(state.kind === 'ready' ? state.recordings : []);

  const shellProps = {
    refreshing,
    onRefresh: refresh,
    dragOver,
    importQueue,
    dismissQueueEntry,
    onPickAndImport,
    onDragOver,
    onDragLeave,
    onDrop,
    tipJar,
    onDismissTipJar,
    onOpenTipJar,
    activity,
    completionKey,
    calendar,
  };

  if (state.kind === 'loading') {
    return (
      <Shell {...shellProps} total={0}>
        <div style={{ padding: 24, color: 'var(--fg-muted)', textAlign: 'center' }}>Loading…</div>
      </Shell>
    );
  }
  if (state.kind === 'error') {
    return (
      <Shell {...shellProps} total={0}>
        <div style={{ padding: 24 }}>
          <div style={{ marginBottom: 12 }}>Could not load the inbox.</div>
          <div className="muted" style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11 }}>
            {state.message}
          </div>
          <button style={{ marginTop: 12 }} onClick={() => void refresh()}>
            Retry
          </button>
        </div>
      </Shell>
    );
  }

  const headerCount =
    sections.toFile.length +
    sections.processing.length +
    sections.waiting.length +
    sections.errored.length +
    sections.cancelled.length;
  const total = state.recordings.length;
  if (total === 0) {
    return (
      <Shell {...shellProps} total={0}>
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
          <span style={{ fontStyle: 'italic' }}>Drop audio, video, transcripts or calendar PDFs here to import.</span>
        </div>
      </Shell>
    );
  }

  return (
    <Shell {...shellProps} total={headerCount}>
      {/*
        Errors first, deliberately. The tray shows a ⚠ while any row is
        errored, and the only controls that clear it (Retry / Skip) live
        on the row itself. With a handful of waiting rows above them the
        error rows fell below the fold — the warning had no obvious way
        to clear, even now the list scrolls and the window resizes. listActiveJoined already ranks errors first
        (CASE r.status WHEN 'error' THEN 1); this matches that intent.
      */}
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
      {sections.toFile.length > 0 && (
        <Section title="Ready to file" count={sections.toFile.length}>
          <FilingRows rows={sections.toFile} focusedId={focusedId} onSkip={onSkip} />
        </Section>
      )}
      {sections.processing.length > 0 && (
        <Section title="Processing" count={sections.processing.length}>
          {sections.processing.map((r) => (
            <ProcessingRow key={r.id} r={r} focused={focusedId === r.id} onCancel={onCancel} onToggleUrgent={onToggleUrgent} />
          ))}
        </Section>
      )}
      {sections.waiting.length > 0 && (
        <Section title="Waiting to tag" count={sections.waiting.length}>
          <QueueAllBar count={sections.waiting.length} />
          {sections.waiting.map((r) => (
            <WaitingRow key={r.id} r={r} focused={focusedId === r.id} onTag={onTag} onSkip={onSkip} />
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
      <HiddenSection onChanged={() => void refresh()} />
    </Shell>
  );
}

/**
 * Hidden (skipped) recordings, collapsed by default and only loaded
 * when opened — on a fresh install this contains the entire back
 * catalogue the first poll skipped, which is hundreds of rows.
 *
 * Hiding used to be one-way, which made "Hide" a decision you couldn't
 * revisit. Unhiding returns a recording to the inbox, or to Recent if
 * it had already produced output.
 */
function HiddenSection({ onChanged }: { onChanged: () => void }) {
  const [open, setOpen] = useState(false);
  const [state, setState] = useState<{ total: number; items: InboxItemDTO[] } | null>(null);
  const [busy, setBusy] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setState(await window.distill.inbox.listHidden());
    } catch (e) {
      console.warn('failed to list hidden recordings', e);
    }
  }, []);

  useEffect(() => {
    if (open && state === null) void load();
  }, [open, state, load]);

  const onUnhide = useCallback(
    async (id: string) => {
      setBusy(id);
      try {
        await window.distill.inbox.unhide(id);
        await load();
        onChanged();
      } catch (e) {
        alert(`Could not unhide: ${e instanceof Error ? e.message : String(e)}`);
      } finally {
        setBusy(null);
      }
    },
    [load, onChanged],
  );

  return (
    <section>
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        style={{
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
        aria-expanded={open}
      >
        <span
          aria-hidden="true"
          style={{
            display: 'inline-block',
            width: 10,
            marginRight: 4,
            transform: open ? 'rotate(90deg)' : 'rotate(0deg)',
            transition: 'transform 120ms',
          }}
        >
          ▸
        </span>
        Hidden {state && <span style={{ fontWeight: 400 }}>· {state.total}</span>}
      </button>
      {open && (
        <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
          {state === null && (
            <li className="muted" style={{ padding: '10px 14px', fontSize: 11 }}>
              Loading…
            </li>
          )}
          {state?.items.length === 0 && (
            <li className="muted" style={{ padding: '10px 14px', fontSize: 11 }}>
              Nothing hidden.
            </li>
          )}
          {state?.items.map((r) => (
            <li
              key={r.id}
              style={{
                padding: '8px 14px',
                borderBottom: '1px solid var(--border)',
                display: 'flex',
                alignItems: 'center',
                gap: 8,
              }}
            >
              <div style={{ flex: 1, minWidth: 0 }}>
                <div className="ellipsis" style={{ fontSize: 12 }}>
                  {r.filename}
                </div>
                <div className="muted" style={{ fontSize: 10 }}>
                  {formatWhen(r.start_time, r.synced_at)}
                  {r.outputs.markdown || r.outputs.html || r.outputs.appleNote
                    ? ' · already summarised'
                    : ''}
                </div>
              </div>
              <button
                onClick={() => void onUnhide(r.id)}
                disabled={busy === r.id}
                style={{ fontSize: 11 }}
              >
                {busy === r.id ? 'Restoring…' : 'Unhide'}
              </button>
            </li>
          ))}
          {state && state.total > state.items.length && (
            <li className="muted" style={{ padding: '8px 14px', fontSize: 10, fontStyle: 'italic' }}>
              Showing the {state.items.length} most recent of {state.total}.
            </li>
          )}
        </ul>
      )}
    </section>
  );
}

interface Buckets {
  toFile: InboxItemDTO[];
  processing: InboxItemDTO[];
  waiting: InboxItemDTO[];
  errored: InboxItemDTO[];
  cancelled: InboxItemDTO[];
  complete: InboxItemDTO[];
}

function bucket(state: InboxState): Buckets {
  const out: Buckets = {
    toFile: [],
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
      case 'to_file':
        out.toFile.push(r);
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
    }
  }
  // Keep the running recording above the queue, then mirror claim priority.
  out.processing.sort((a, b) =>
    Number(a.status === 'tagged') - Number(b.status === 'tagged') ||
    Number(b.urgent) - Number(a.urgent) ||
    a.synced_at - b.synced_at ||
    (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return out;
}

interface ShellProps {
  refreshing: boolean;
  onRefresh: () => Promise<void>;
  total: number;
  dragOver: boolean;
  importQueue: ImportQueueEntry[];
  dismissQueueEntry: (sourcePath: string) => void;
  onPickAndImport: () => Promise<void>;
  onDragOver: (e: React.DragEvent) => void;
  onDragLeave: (e: React.DragEvent) => void;
  onDrop: (e: React.DragEvent) => void;
  tipJar: TipJarStatusDTO | null;
  onDismissTipJar: () => Promise<void>;
  onOpenTipJar: () => void;
  activity: EssenceActivity;
  completionKey: string;
  calendar: ReturnType<typeof useCalendarImport>;
  children: React.ReactNode;
}

function Shell(props: ShellProps) {
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
          flexShrink: 0,
        }}
        className="drag-region"
      >
        <EssenceLogo activity={props.activity} completionKey={props.completionKey} size={22} decorative />
        <div style={{ fontWeight: 600 }}>Inbox</div>
        <div className="muted" style={{ marginLeft: 'auto', fontSize: 11 }}>
          {props.total > 0 ? `${props.total} total` : ''}
        </div>
        <HeaderButton
          title="Import audio, video, or an existing transcript (.md / .txt) to re-summarise"
          onClick={() => void props.onPickAndImport()}
        >
          +
        </HeaderButton>
        <HeaderButton title="Refresh (⌘R)" onClick={() => void props.onRefresh()} disabled={props.refreshing}>
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
      {/* The list scrolls; only the header is a drag handle (styles.css .drag-region). */}
      <main style={{ flex: '1 1 auto', minHeight: 0, overflowY: 'auto' }}>
        <CalendarBar {...props.calendar} />
        <MeetingSearch />
        {props.children}
      </main>
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
            <div className="muted" style={{ fontSize: 11, fontWeight: 400, marginTop: 4 }}>
              Audio: mp3 m4a wav aac ogg flac opus
              <br />
              Video: mp4 mov m4v mkv webm (needs ffmpeg)
              <br />
              Transcript: md txt — re-summarises without re-transcribing
              <br />
              Calendar: pdf — Outlook detailed agenda printouts
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
  defaultCollapsed?: boolean;
  children: React.ReactNode;
}) {
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
      {!collapsed && <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>{props.children}</ul>}
    </section>
  );
}

function ProcessingRow(props: {
  r: InboxItemDTO;
  focused: boolean;
  onCancel: (id: string) => void;
  onToggleUrgent: (id: string, urgent: boolean) => void;
}) {
  const { r } = props;
  // "2/4 Transcribing…" — the total comes from the row's own plan, so an
  // imported transcript honestly reads "1/2 Summarising…" rather than
  // pretending it skipped two steps.
  const queued = r.status === 'tagged';
  const stepLabel = queued
    ? `${r.urgent ? 'Urgent · ' : ''}Queued · ${r.stepTotal} step${r.stepTotal === 1 ? '' : 's'}`
    : `${r.stepIndex ?? '?'}/${r.stepTotal} ${humanStep(r.currentStep)}…`;
  return (
    <Row id={r.id} focused={props.focused}>
      <Title r={r} />
      <MetaLine r={r} />
      <OutputTargetPicker r={r} />
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
        {/* Only meaningful while still queued — once claimed the worker is already running it. */}
        {queued && (
          <button
            onClick={() => props.onToggleUrgent(r.id, !r.urgent)}
            title="Run ahead of non-urgent queued recordings after the current recording finishes. Also bypasses the idle/overnight schedule; paused steps stay paused."
          >
            {r.urgent ? 'Unmark urgent' : 'Mark urgent'}
          </button>
        )}
      </div>
    </Row>
  );
}

function WaitingRow(props: {
  r: InboxItemDTO;
  focused: boolean;
  onTag: (id: string) => void;
  onSkip: (id: string) => Promise<void>;
}) {
  const lengthHint = describeDurationRisk(props.r.duration_seconds);
  return (
    <Row id={props.r.id} focused={props.focused}>
      <Title r={props.r} />
      <MetaLine r={props.r} />
      <CalendarLine r={props.r} />
      <OutputTargetPicker r={props.r} />
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
          Process…
        </button>
        <button onClick={() => void props.onSkip(props.r.id)} title="Hide this recording. You can bring it back from Hidden.">
          Hide
        </button>
      </div>
    </Row>
  );
}

/** The Outlook meeting a recording overlapped, and the account it points to. */
function CalendarLine({ r }: { r: InboxItemDTO }) {
  if (!r.calendarSubject) return null;
  return (
    <div className="muted" style={{ fontSize: 11, marginBottom: 6 }} title={r.calendarClientReason ?? undefined}>
      📅 {r.calendarRejected ? 'Booked: ' : ''}
      {r.calendarSubject}
      {r.calendarAlternatives.length > 0 ? ` — or ${r.calendarAlternatives.map((a) => `“${a}”`).join(', or ')}` : ''}
      {r.calendarRejected ? ' (the transcript doesn’t match it)' : ''}
      {r.calendarClientName ? ` · ${r.calendarClientName}` : r.calendarAlternatives.length > 0 ? ' · overlapping meetings, account unclear' : ''}
    </div>
  );
}

function formatDay(ms: number | null): string {
  return ms === null ? '?' : new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

/**
 * Import Outlook calendar printouts (Calendar → Print → detailed agenda,
 * saved as PDF). Each recording is matched to the meeting it overlapped,
 * which then suggests the account, attendees and meeting type. Read
 * locally by python/calendar_pdf.py; nothing is sent anywhere.
 */
function CalendarBar({ coverage, pending, messages, importPdfs }: ReturnType<typeof useCalendarImport>) {
  return (
    <section aria-label="Calendar import" style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', fontSize: 11 }}>
      <div style={{ display: 'flex', alignItems: 'center', flexWrap: 'wrap', gap: 8 }}>
        <button onClick={() => void importPdfs()} disabled={pending > 0}>
          Import calendar PDFs…
        </button>
        <span className="muted" role="status">
          {pending > 0
            ? `Reading calendar printouts…${pending > 1 ? ` (${pending - 1} more import${pending === 2 ? '' : 's'} queued)` : ''}`
            : coverage && coverage.meetings > 0
              ? `Calendar: ${coverage.meetings.toLocaleString()} meetings, ${formatDay(coverage.firstMs)} – ${formatDay(coverage.lastMs)}`
              : 'Drop PDFs here, or choose files. Outlook → Print → detailed agenda → Save as PDF.'}
        </span>
      </div>
      <div role="status">
        {messages.map((message, index) => (
          <div key={index} style={{ marginTop: 6, overflowWrap: 'anywhere' }}>{message}</div>
        ))}
      </div>
    </section>
  );
}

/**
 * "Queue all": process every waiting recording without tagging it. Each is
 * classified after transcription and held in Ready to file — nothing is
 * written anywhere until its client is confirmed there.
 */
function QueueAllBar(props: { count: number }) {
  const [busy, setBusy] = useState(false);
  const onClick = async () => {
    const n = props.count;
    const ok = confirm(
      `Queue ${n} recording${n === 1 ? '' : 's'} without tagging?\n\n` +
        'Each will be transcribed and summarised on your processing schedule (Settings → General), ' +
        'with the client and meeting type suggested from the transcript. Each then waits under Ready to ' +
        'file for you to confirm where it goes (unless Automatic filing is on and the match is high-' +
        'confidence). Recordings shorter than your minimum length (Settings → General) are hidden instead.',
    );
    if (!ok) return;
    setBusy(true);
    try {
      const { hidden } = await window.distill.inbox.queueAll();
      if (hidden > 0) {
        alert(`${hidden} recording${hidden === 1 ? ' was' : 's were'} shorter than your minimum length and moved to Hidden.`);
      }
    } catch (e) {
      alert(`Could not queue: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setBusy(false);
    }
  };
  return (
    <li style={{ padding: '8px 14px', borderBottom: '1px solid var(--border)', display: 'flex', alignItems: 'center', gap: 8 }}>
      <button onClick={() => void onClick()} disabled={busy}>
        Queue all
      </button>
      <span className="muted" style={{ fontSize: 11 }}>
        Process without tagging; confirm the client afterwards.
      </span>
    </li>
  );
}

/** Loads the client and meeting-type lists once for every Ready to file row. */
function FilingRows(props: {
  rows: InboxItemDTO[];
  focusedId: string | null;
  onSkip: (id: string) => Promise<void>;
}) {
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [types, setTypes] = useState<MeetingTypeDTO[]>([]);
  useEffect(() => {
    void Promise.all([window.distill.clients.list(), window.distill.meetingTypes.list()])
      .then(([c, t]) => {
        setClients(c);
        setTypes(t);
      })
      .catch((e) => alert(`Could not load clients and meeting types: ${String(e)}`));
  }, []);
  return (
    <>
      {props.rows.map((r) => (
        <FilingRow
          key={r.id}
          r={r}
          focused={props.focusedId === r.id}
          clients={clients}
          types={types}
          onSkip={props.onSkip}
        />
      ))}
    </>
  );
}

function FilingRow(props: {
  r: InboxItemDTO;
  focused: boolean;
  clients: ClientDTO[];
  types: MeetingTypeDTO[];
  onSkip: (id: string) => Promise<void>;
}) {
  const { r } = props;
  const [clientId, setClientId] = useState(r.suggestedClientId ?? r.calendarClientId ?? '');
  const [typeId, setTypeId] = useState(r.meetingTypeId ?? '');
  const [busy, setBusy] = useState(false);
  // A suggestion for a client deleted since classification shows as no pick.
  const clientKnown = props.clients.some((c) => c.id === clientId);
  // Re-summarised on filing when the meeting type changes, or when the
  // client changes and either client has an account context (the summary
  // was written with the suggested client's context).
  const contextOf = (id: string | null) => props.clients.find((c) => c.id === id)?.context.trim() ?? '';
  const resummarise =
    (typeId !== '' && typeId !== r.meetingTypeId) ||
    (clientKnown && clientId !== r.suggestedClientId && (contextOf(clientId) !== '' || contextOf(r.suggestedClientId) !== ''));
  const suggestedName = props.clients.find((c) => c.id === r.suggestedClientId)?.name ?? null;
  const onFile = async () => {
    setBusy(true);
    try {
      await window.distill.inbox.file({ recordingId: r.id, clientId, meetingTypeId: typeId });
    } catch (e) {
      alert(`Could not file: ${e instanceof Error ? e.message : String(e)}`);
      setBusy(false);
    }
  };
  return (
    <Row id={r.id} focused={props.focused}>
      <Title r={r} />
      <MetaLine r={r} />
      <OutputTargetPicker r={r} />
      <div style={{ fontSize: 11, marginBottom: 8 }}>
        <span style={{ fontWeight: 600 }}>
          {suggestedName ? `Suggested: ${suggestedName}` : 'No client suggested'}
          {r.filingConfidence ? ` · ${r.filingConfidence} confidence` : ''}
        </span>
        {r.filingReason && <div className="muted">{r.filingReason}</div>}
      </div>
      <CalendarLine r={r} />
      <div className="row" style={{ marginBottom: 8, gap: 6 }}>
        <select value={clientKnown ? clientId : ''} onChange={(e) => setClientId(e.target.value)} aria-label="Client">
          <option value="" disabled>
            Choose a client…
          </option>
          {props.clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select value={typeId} onChange={(e) => setTypeId(e.target.value)} aria-label="Meeting type">
          {props.types.filter((t) => !t.retired || t.id === typeId).map((t) => (
            <option key={t.id} value={t.id}>
              {t.name}
            </option>
          ))}
        </select>
      </div>
      {resummarise && (
        <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
          The summary was written for a different meeting type or with another client's account context,
          so it will be regenerated from the transcript first (on your processing schedule, unless marked
          urgent).
        </div>
      )}
      <div className="row">
        <button className="primary" disabled={busy || !clientKnown || typeId === ''} onClick={() => void onFile()}>
          {resummarise ? 'File & re-summarise' : 'File'}
        </button>
        <button
          onClick={() => {
            void window.distill.meeting.open(r.id).catch((e) => alert(e instanceof Error ? e.message : String(e)));
          }}
        >
          Read summary
        </button>
        <button onClick={() => void props.onSkip(r.id)} title="Hide this recording. You can bring it back from Hidden.">
          Hide
        </button>
      </div>
    </Row>
  );
}

function ErrorRow(props: {
  r: InboxItemDTO;
  focused: boolean;
  onRetry: (id: string) => void;
  onSkip: (id: string) => Promise<void>;
  onOpenSources: () => void;
}) {
  return (
    <Row id={props.r.id} focused={props.focused}>
      <Title r={props.r} />
      <MetaLine r={props.r} />
      <OutputTargetPicker r={props.r} />
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
        {props.r.isAuthError && <button onClick={() => props.onRetry(props.r.id)}>Retry</button>}
        <button onClick={() => void props.onSkip(props.r.id)} title="Hide this recording. You can bring it back from Hidden.">
          Hide
        </button>
      </div>
    </Row>
  );
}

function CancelledRow(props: {
  r: InboxItemDTO;
  focused: boolean;
  onRetry: (id: string) => void;
  onSkip: (id: string) => Promise<void>;
}) {
  return (
    <Row id={props.r.id} focused={props.focused}>
      <Title r={props.r} />
      <MetaLine r={props.r} />
      <OutputTargetPicker r={props.r} />
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        Cancelled
      </div>
      <div className="row">
        <button className="primary" onClick={() => props.onRetry(props.r.id)}>
          Resume
        </button>
        <button onClick={() => void props.onSkip(props.r.id)} title="Hide this recording. You can bring it back from Hidden.">
          Hide
        </button>
      </div>
    </Row>
  );
}

function CompleteRow(props: {
  r: InboxItemDTO;
  focused: boolean;
  onReveal: (id: string) => void;
  onSkip: (id: string) => Promise<void>;
}) {
  const { r } = props;
  const vocabLine =
    r.vocabularyRulesApplied != null && r.vocabularyRulesApplied > 0
      ? `${r.vocabularyRulesApplied} correction${r.vocabularyRulesApplied === 1 ? '' : 's'} applied${
          r.vocabularySources ? ` · ${r.vocabularySources.split(',').join(' + ')}` : ''
        }`
      : null;
  const truncationTooltip =
    r.estimatedInputTokens !== null && r.contextWindowAtSubmit !== null
      ? `Estimated input ${r.estimatedInputTokens.toLocaleString()} tokens against a ${r.contextWindowAtSubmit.toLocaleString()}-token context window. The model silently truncates the start of the input when this happens, so the early part of the meeting may be missing from the summary.`
      : 'Input was likely larger than the model context window; the summary may be missing detail from the start of the meeting.';
  const externalLabel = r.modelSnapshot
    ? `Processed on another machine (summary by ${r.modelSnapshot})`
    : 'Processed on another machine';
  const externalTooltip =
    'This recording was processed on another Mac and its Markdown output was found via iCloud Drive. The pipeline did not run on this machine, so the summary reflects whatever model the other machine used. Use "Full re-run" below to process it on this machine instead.';
  return (
    <Row id={r.id} focused={props.focused}>
      <Title r={r} />
      <MetaLine r={r} />
      <OutputTargetPicker r={r} />
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
      {r.autoFiled && (
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }} title={r.filingReason ?? undefined}>
          Filed automatically{r.clientName ? ` under ${r.clientName}` : ''}
          {r.meetingTypeName ? ` as ${r.meetingTypeName}` : ''} — high confidence. Wrong? Refile it.
        </div>
      )}
      {!r.autoFiled && <CalendarLine r={r} />}
      <OutputLinks r={r} />
      <div className="row">
        <button className="primary" onClick={() => {
          void window.distill.meeting.open(r.id).catch(e => alert(e instanceof Error ? e.message : String(e)));
        }}>Read meeting</button>
        <button onClick={() => void props.onSkip(r.id)} title="Hide this recording. You can bring it back from Hidden.">
          Hide
        </button>
        <FullRerunButton r={r} />
        <button
          onClick={() => {
            void window.distill.inbox.refile(r.id).catch((e) => alert(e instanceof Error ? e.message : String(e)));
          }}
          title="Move back to Ready to file to change the client or meeting type"
        >
          Refile…
        </button>
      </div>
    </Row>
  );
}

function TipJarBanner(props: { status: TipJarStatusDTO; onDismiss: () => void; onOpen: () => void }) {
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
          Glad distill is earning its keep. If you'd like to support development, you can keep me
          caffeinated.
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

function describeDurationRisk(
  durationSeconds: number | null,
): { severity: 'red' | 'yellow'; message: string; tooltip: string } | null {
  if (durationSeconds == null) return null;
  if (durationSeconds >= 10_800) {
    return {
      severity: 'red',
      message: 'Very long meeting — summary likely to lose detail.',
      tooltip:
        'Meetings over 3 hours often exceed the model’s context window after transcription. The model will silently truncate the start of the input and the summary may be missing earlier topics.',
    };
  }
  if (durationSeconds >= 5400) {
    return {
      severity: 'yellow',
      message: 'Long meeting — summary quality may suffer.',
      tooltip:
        'Long meetings produce long transcripts. The model can still summarise them, but its attention spreads more thinly so finer points are easier to miss. Worth re-reading against the source if anything seems off.',
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

function Spinner() {
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
}) {
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

function ImportQueuePanel(props: {
  entries: ImportQueueEntry[];
  onDismiss: (sourcePath: string) => void;
  activeOrQueued: number;
}) {
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
          <ImportQueueRow key={e.sourcePath} entry={e} onDismiss={() => props.onDismiss(e.sourcePath)} />
        ))}
      </ul>
    </div>
  );
}

function ImportQueueRow(props: { entry: ImportQueueEntry; onDismiss: () => void }) {
  const e = props.entry;
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
      <div className="ellipsis" style={{ fontWeight: 500, marginBottom: 4 }}>
        {basename}
      </div>
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 8,
          fontSize: 11,
          color: e.status === 'error' ? 'var(--danger)' : 'var(--fg-muted)',
        }}
      >
        <span>{describeImportStatus(e)}</span>
        {e.status === 'active' && <ImportProgressBar percent={e.percent} />}
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

function ImportProgressBar(props: { percent: number | null }) {
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

function describeImportStatus(e: ImportQueueEntry): string {
  if (e.status === 'queued') return 'Queued';
  if (e.status === 'error') return 'Failed';
  switch (e.phase) {
    case 'probe':
      return 'Reading file…';
    case 'copy':
      return e.percent !== null ? `Copying audio… ${e.percent}%` : 'Copying audio…';
    case 'extract':
      return e.percent !== null ? `Extracting audio… ${e.percent}%` : 'Extracting audio…';
    case 'finalise':
      return 'Finalising…';
    default:
      return 'Importing…';
  }
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Inbox />
  </React.StrictMode>,
);

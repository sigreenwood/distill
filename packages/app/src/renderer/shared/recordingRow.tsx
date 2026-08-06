import React, { useEffect, useState } from 'react';
import type { InboxItemDTO } from './api.js';

/**
 * Pieces shared between the Inbox and History windows for rendering a
 * single recording row. Split out rather than duplicated so the two
 * windows can't quietly drift (e.g. one window's "Full re-run" button
 * gaining a confirmation the other's doesn't).
 */

export function formatDuration(seconds: number | null): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${r.toString().padStart(2, '0')}s`;
  return `${r}s`;
}

export function formatWhen(startTimeMs: number | null, fallbackEpochMs: number): string {
  const ms = startTimeMs != null ? startTimeMs : fallbackEpochMs;
  const d = new Date(ms);
  const now = new Date();
  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();
  const hm = `${d.getHours().toString().padStart(2, '0')}:${d.getMinutes().toString().padStart(2, '0')}`;
  if (sameDay) return `Today ${hm}`;
  if (isYesterday) return `Yesterday ${hm}`;
  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const day = d.getDate();
  const month = d.toLocaleDateString(undefined, { month: 'short' });
  return `${weekday} ${day} ${month} ${hm}`;
}

export function Row(props: { id: string; focused: boolean; children: React.ReactNode }) {
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

export function Title({ r }: { r: InboxItemDTO }) {
  return (
    <div className="ellipsis" style={{ fontWeight: 500, marginBottom: 2 }}>
      {r.filename}
    </div>
  );
}

export function MetaLine({ r }: { r: InboxItemDTO }) {
  const tag = r.clientName && r.meetingTypeName ? `${r.clientName} · ${r.meetingTypeName}` : null;
  return (
    <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
      {formatWhen(r.start_time, r.synced_at)} · {formatDuration(r.duration_seconds)}
      {tag ? ` · ${tag}` : ''}
    </div>
  );
}

/**
 * One control per output destination. Written destinations are
 * clickable and open the file; unwritten ones stay visible but greyed,
 * so you can tell at a glance that (say) Apple Notes was configured and
 * did not land, rather than never having been asked for.
 */
export function OutputLinks({ r }: { r: InboxItemDTO }) {
  const items: { kind: 'markdown' | 'html' | 'appleNote'; label: string; value: string | null }[] = [
    { kind: 'markdown', label: 'MD', value: r.outputs.markdown },
    { kind: 'html', label: 'HTML', value: r.outputs.html },
    { kind: 'appleNote', label: 'Notes', value: r.outputs.appleNote },
  ];
  return (
    <div style={{ display: 'flex', gap: 6, marginBottom: 8, alignItems: 'center' }}>
      {items.map(({ kind, label, value }) => {
        const written = value !== null;
        return (
          <button
            key={kind}
            disabled={!written}
            onClick={() =>
              void window.distill.inbox
                .revealOutput(r.id, kind)
                .catch((e) => alert(String(e instanceof Error ? e.message : e)))
            }
            title={
              written
                ? kind === 'appleNote'
                  ? 'Open Notes'
                  : `Show in Finder: ${value}`
                : `No ${label} output was written for this recording`
            }
            style={{
              fontSize: 10,
              padding: '2px 8px',
              borderRadius: 3,
              border: '1px solid var(--border)',
              background: 'transparent',
              color: written ? 'var(--accent, #3b82f6)' : 'var(--fg-muted)',
              opacity: written ? 1 : 0.45,
              cursor: written ? 'pointer' : 'default',
            }}
          >
            {written ? '↗ ' : ''}
            {label}
          </button>
        );
      })}
    </div>
  );
}

/**
 * Re-transcribe + re-summarise a finished recording from scratch. The
 * confirmation (this deletes existing outputs) happens on the main-process
 * side, since that's the process actually doing the deleting — this button
 * just triggers the request and reports the outcome.
 */
export function FullRerunButton({ r }: { r: InboxItemDTO }) {
  const onClick = () => {
    void window.distill.pipeline.fullRerun(r.id).catch((e) => alert(`Could not re-run: ${String(e)}`));
  };
  return (
    <button
      onClick={onClick}
      disabled={!r.audioAvailable}
      title={
        r.audioAvailable
          ? 'Delete the existing outputs and re-transcribe + re-summarise from the original audio.'
          : 'The original audio is no longer available, so this recording cannot be re-run.'
      }
    >
      Full re-run…
    </button>
  );
}

type OutputTargets = InboxItemDTO['outputTargets'];
const OUTPUT_TARGET_LABELS: [keyof OutputTargets, string][] = [
  ['markdown', 'MD'],
  ['html', 'HTML'],
  ['appleNote', 'Notes'],
];

/**
 * Per-recording override for which destinations this row writes to.
 * Pre-filled from the effective value the main process already computed
 * (this row's override if it has one, else the current Settings ->
 * Outputs default) — toggling never touches that global default, only
 * this one recording. See effectiveOutputTargets in state.ts.
 *
 * Checking a box that's already-written on a complete row is a no-op;
 * checking one that isn't written yet kicks the row back through the
 * write step for just that destination (handled main-process side, same
 * mechanism Full re-run uses to resume from `tagged`).
 */
export function OutputTargetPicker({ r }: { r: InboxItemDTO }) {
  const [targets, setTargets] = useState<OutputTargets>(r.outputTargets);
  useEffect(() => setTargets(r.outputTargets), [r.outputTargets]);

  const toggle = (key: keyof OutputTargets) => {
    const previous = targets;
    const next = { ...targets, [key]: !targets[key] };
    setTargets(next);
    void window.distill.inbox.setOutputTargets(r.id, next).catch((e) => {
      setTargets(previous);
      alert(`Could not update output targets: ${e instanceof Error ? e.message : String(e)}`);
    });
  };

  return (
    <div style={{ display: 'flex', gap: 10, alignItems: 'center', fontSize: 11, marginBottom: 8 }}>
      <span className="muted">Write to:</span>
      {OUTPUT_TARGET_LABELS.map(([key, label]) => (
        <label key={key} style={{ display: 'flex', alignItems: 'center', gap: 4, cursor: 'pointer' }}>
          <input type="checkbox" checked={targets[key]} onChange={() => toggle(key)} />
          {label}
        </label>
      ))}
    </div>
  );
}

const STATUS_LABELS: Record<InboxItemDTO['status'], string> = {
  inbox: 'Inbox',
  tagged: 'Queued',
  downloading: 'Downloading',
  transcribing: 'Transcribing',
  summarising: 'Summarising',
  writing: 'Writing',
  complete: 'Complete',
  error: 'Error',
  cancelled: 'Cancelled',
  skipped: 'Hidden',
};

/** Small status pill — History shows every status, unlike the Inbox's sectioned rows. */
export function StatusBadge({ status }: { status: InboxItemDTO['status'] }) {
  const color =
    status === 'error'
      ? 'var(--danger, #dc2626)'
      : status === 'complete'
        ? 'var(--accent, #3b82f6)'
        : 'var(--fg-muted)';
  return (
    <span
      style={{
        fontSize: 10,
        fontWeight: 600,
        letterSpacing: '0.02em',
        textTransform: 'uppercase',
        color,
        border: `1px solid ${color}`,
        borderRadius: 3,
        padding: '1px 6px',
      }}
    >
      {STATUS_LABELS[status]}
    </span>
  );
}

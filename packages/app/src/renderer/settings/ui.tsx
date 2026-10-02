import React from 'react';
import type { OutputDirStatusDTO } from '../shared/api.js';

/** Ollama keep_alive presets — must mirror shared/ipcChannels.ts. */
export const KEEPALIVE_PRESETS = [
  { value: '0', label: 'Off (unload immediately)' },
  { value: '5m', label: '5 minutes' },
  { value: '30m', label: '30 minutes' },
  { value: '1h', label: '1 hour' },
  { value: '24h', label: '24 hours' },
] as const;

/** MLX Whisper presets — must mirror shared/ipcChannels.ts. */
export const WHISPER_MODEL_PRESETS = [
  { value: 'mlx-community/whisper-large-v3-mlx', label: 'Large v3 (best quality, slowest)' },
  {
    value: 'mlx-community/whisper-large-v3-turbo',
    label: 'Large v3 Turbo (near-large quality, much faster)',
  },
  { value: 'mlx-community/whisper-medium-mlx', label: 'Medium' },
  { value: 'mlx-community/whisper-small-mlx', label: 'Small' },
  { value: 'mlx-community/whisper-base-mlx', label: 'Base' },
  { value: 'mlx-community/whisper-tiny-mlx', label: 'Tiny (fastest, lowest quality)' },
] as const;

export type SettingsTab =
  | 'sources'
  | 'outputs'
  | 'prompts'
  | 'clients'
  | 'vocabulary'
  | 'general'
  | 'performance'
  | 'about';

export function readTabFromHash(): SettingsTab {
  const hash = window.location.hash.replace(/^#/, '');
  switch (hash) {
    case 'sources':
    case 'outputs':
    case 'prompts':
    case 'clients':
    case 'vocabulary':
    case 'general':
    case 'performance':
    case 'about':
      return hash;
    default:
      return 'sources';
  }
}

export function TabButton(props: { label: string; active: boolean; onClick: () => void }) {
  return (
    <button
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      style={{
        ...tabButtonStyle,
        borderBottomColor: props.active ? 'var(--accent, #3b82f6)' : 'transparent',
        color: props.active ? 'var(--fg)' : 'var(--fg-muted)',
        fontWeight: props.active ? 500 : 400,
      }}
    >
      {props.label}
    </button>
  );
}

export function ModifiedBadge() {
  return (
    <span
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 3,
        background: 'var(--accent, #3b82f6)',
        color: 'white',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontWeight: 600,
      }}
      title="Prompt has been edited from the default"
    >
      mod
    </span>
  );
}

export function DestinationCard(props: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}) {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        background: props.enabled ? 'var(--bg)' : 'var(--row-hover)',
      }}
    >
      <label style={{ display: 'flex', gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onToggle(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>{props.title}</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {props.description}
          </div>
        </div>
      </label>
      {props.children}
    </section>
  );
}

export function FolderField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}) {
  const [status, setStatus] = React.useState<OutputDirStatusDTO | null>(null);

  // Re-inspect as the user types, debounced — the check touches the
  // filesystem and the path is half-written on most keystrokes.
  React.useEffect(() => {
    let cancelled = false;
    const handle = setTimeout(() => {
      void window.distill.settings
        .inspectOutputDir(props.value)
        .then((s) => {
          if (!cancelled) setStatus(s);
        })
        .catch(() => {
          if (!cancelled) setStatus(null);
        });
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(handle);
    };
  }, [props.value]);

  return (
    <div style={{ marginTop: 10 }}>
      <label style={fieldLabelStyle}>{props.label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
          placeholder="~/Documents/distill"
        />
        <button onClick={props.onBrowse}>Browse…</button>
        <button
          onClick={() => void window.distill.settings.revealPath(props.value)}
          title="Show this folder in Finder (opens the parent if it doesn't exist yet)"
          disabled={!status || status.problem !== null}
        >
          Reveal
        </button>
      </div>
      {status && <OutputDirStatusLine status={status} />}
    </div>
  );
}

function OutputDirStatusLine({ status }: { status: OutputDirStatusDTO }) {
  if (status.problem) {
    return (
      <div style={{ ...hintStyle, color: 'var(--danger)', fontStyle: 'normal' }} role="alert">
        ⚠ {status.problem}
      </div>
    );
  }
  const summary = status.exists
    ? status.existingSummaries > 0
      ? `Folder exists · ${status.existingSummaries} summar${status.existingSummaries === 1 ? 'y' : 'ies'} here`
      : 'Folder exists · empty so far'
    : 'Folder will be created on the first summary';
  return (
    <div className="muted" style={{ ...hintStyle, fontStyle: 'normal' }}>
      <span title={status.resolvedPath}>
        {status.exists ? '✓' : '·'} {summary}
      </span>
      {status.note && <div style={{ marginTop: 2 }}>{status.note}</div>}
    </div>
  );
}

export function TranscriptToggle(props: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      <input type="checkbox" checked={props.checked} onChange={(e) => props.onChange(e.target.checked)} />
      <span>Embed full transcript below the summary</span>
    </label>
  );
}

export function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  const d = new Date(epochMs);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

export function modelMatches(name: string, target: string): boolean {
  if (name === target) return true;
  if (name === `${target}:latest`) return true;
  if (`${name}:latest` === target) return true;
  return false;
}

export function formatBytes(bytes: number | undefined): string {
  if (!Number.isFinite(bytes) || (bytes as number) <= 0) return '?';
  const gb = (bytes as number) / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = (bytes as number) / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

// --- shared style constants ------------------------------------------------

export const shellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--bg)',
  color: 'var(--fg)',
};

export const headerStyle: React.CSSProperties = {
  padding: '12px 20px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  borderBottom: '1px solid var(--border)',
  padding: '0 12px',
};

const tabButtonStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  cursor: 'pointer',
  marginBottom: -1,
};

export const paneStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
};

export const paneBodyStyle: React.CSSProperties = {
  padding: '14px 20px',
  overflowY: 'auto',
  flex: 1,
};

export const promptsPaneBodyStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
};

export const sidebarStyle: React.CSSProperties = {
  width: 220,
  borderRight: '1px solid var(--border)',
  overflowY: 'auto',
  padding: '10px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

export const sidebarLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '4px 8px 8px',
};

export const sidebarItemStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--fg)',
  lineHeight: 1.3,
};

export const sidebarMetaStyle: React.CSSProperties = {
  fontSize: 10,
  marginTop: 2,
};

export const editorStyle: React.CSSProperties = {
  flex: 1,
  padding: '14px 20px',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'auto',
};

export const editorHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  marginBottom: 10,
};

export const textareaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 240,
  padding: 10,
  fontSize: 12,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  background: 'var(--input-bg, var(--row-hover))',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  resize: 'none',
  lineHeight: 1.5,
  whiteSpace: 'pre',
};

export const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--fg-muted)',
  marginBottom: 4,
};

export const hintStyle: React.CSSProperties = {
  fontSize: 10,
  marginTop: 4,
  fontStyle: 'italic',
};

export const warningBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: 'rgba(220, 38, 38, 0.08)',
  color: 'var(--danger)',
  fontSize: 12,
  borderRadius: 6,
};

export const errorBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: 'rgba(220, 38, 38, 0.08)',
  color: 'var(--danger)',
  fontSize: 12,
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
};

export const infoBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: 'rgba(59, 130, 246, 0.08)',
  color: 'var(--fg)',
  fontSize: 12,
  borderRadius: 6,
  borderLeft: '3px solid var(--accent, #3b82f6)',
};

export const footerStyle: React.CSSProperties = {
  padding: '12px 20px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

export const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  background: 'var(--input-bg, var(--row-hover))',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  width: '100%',
  boxSizing: 'border-box',
};

export const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
  marginTop: 4,
  marginBottom: 4,
};

export const tableStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 4,
};

export const tableRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
};

export const replacementHeaderStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  fontSize: 10,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
  padding: '0 2px 2px',
};

export const deleteButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  fontSize: 12,
  lineHeight: 1,
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  flex: 'none',
};

export const addButtonStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  marginTop: 4,
  padding: '4px 10px',
  fontSize: 11,
  background: 'transparent',
  border: '1px dashed var(--border)',
  borderRadius: 4,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
};

export const notesListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 11,
  color: 'var(--fg-muted)',
  lineHeight: 1.4,
};

export const termCountBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 8,
  background: 'var(--row-hover)',
  color: 'var(--fg-muted)',
  minWidth: 20,
  textAlign: 'center',
};

export const helpCodeStyle: React.CSSProperties = {
  margin: '4px 0',
  padding: 10,
  fontSize: 10,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  whiteSpace: 'pre',
  overflowX: 'auto',
  lineHeight: 1.5,
};

export const aboutHeadingStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  marginTop: 0,
  marginBottom: 6,
  letterSpacing: -0.2,
};

export const aboutLeadStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  marginTop: 0,
  marginBottom: 18,
  color: 'var(--fg)',
};

export const aboutSectionStyle: React.CSSProperties = {
  marginBottom: 18,
};

export const aboutSubheadingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
  marginTop: 0,
  marginBottom: 8,
};

export const aboutOrderedListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.55,
};

export const aboutUnorderedListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.55,
};

export const aboutSmallTextStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0,
};

export const aboutFooterStyle: React.CSSProperties = {
  marginTop: 24,
  paddingTop: 12,
  borderTop: '1px solid var(--border)',
  display: 'flex',
  justifyContent: 'flex-end',
};

export const aboutVersionStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

import { useCallback, useEffect, useState } from 'react';
import type { MaterialDTO } from '../../shared/materials.js';

function errorText(e: unknown): string {
  return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

const STATUS: Record<MaterialDTO['status'], string> = {
  pending: 'read when the meeting is next summarised',
  ready: 'notes ready',
  error: 'could not be read',
};

/**
 * Slides, PDFs and screenshots attached to one recording (shared/materials.ts).
 * Each is read in its own model pass when the meeting is next summarised —
 * by the pipeline, or by Versions… for a finished meeting — and only those
 * notes join the summary. Drop files here or use Attach….
 */
export function MaterialsPanel({ recordingId, finished }: { recordingId: string; finished?: boolean }) {
  const [items, setItems] = useState<MaterialDTO[] | null>(null);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [dragging, setDragging] = useState(false);
  const [openId, setOpenId] = useState<string | null>(null);

  const load = useCallback(() => {
    void window.distill.materials
      .list(recordingId)
      .then(setItems)
      .catch((e) => setMessage(errorText(e)));
  }, [recordingId]);

  useEffect(load, [load]);

  const attach = async (paths?: string[]) => {
    setBusy(true);
    setMessage(null);
    try {
      const { added, duplicates } = await window.distill.materials.add(recordingId, paths);
      if (duplicates) setMessage(`${duplicates} file${duplicates === 1 ? ' was' : 's were'} already attached.`);
      else if (added && finished) setMessage('Attached. Use Versions… → Generate to summarise again with it.');
      load();
    } catch (e) {
      setMessage(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const act = async (op: () => Promise<void>) => {
    setMessage(null);
    try {
      await op();
      load();
    } catch (e) {
      setMessage(errorText(e));
    }
  };

  return (
    <div
      onDragOver={(e) => {
        if (!e.dataTransfer.types.includes('Files')) return;
        e.preventDefault();
        e.stopPropagation();
        setDragging(true);
      }}
      onDragLeave={() => setDragging(false)}
      onDrop={(e) => {
        e.preventDefault();
        e.stopPropagation();
        setDragging(false);
        const paths = [...e.dataTransfer.files].map((f) => window.distill.localImport.getPathForFile(f)).filter(Boolean);
        if (paths.length) void attach(paths);
      }}
      style={{
        border: `1px ${dragging ? 'solid var(--accent, #0a84ff)' : 'dashed var(--border)'}`,
        borderRadius: 6,
        padding: '6px 8px',
        fontSize: 11,
      }}
    >
      <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong style={{ fontSize: 11 }}>Materials</strong>
        <span className="muted" style={{ flex: 1, minWidth: 0 }}>
          Slides, PDFs or screenshots — drop here. Each is read on its own, on this Mac.
        </span>
        <button disabled={busy} onClick={() => void attach()} style={{ fontSize: 11 }}>
          {busy ? 'Attaching…' : 'Attach…'}
        </button>
      </div>
      {items && items.length > 0 && (
        <ul style={{ listStyle: 'none', margin: '6px 0 0', padding: 0 }}>
          {items.map((m) => (
            <li key={m.id} style={{ padding: '3px 0', borderTop: '1px solid var(--border)' }}>
              <div style={{ display: 'flex', gap: 6, alignItems: 'baseline' }}>
                <span className="ellipsis" style={{ flex: 1, minWidth: 0 }} title={m.filename}>
                  {m.kind === 'image' ? '🖼 ' : '📄 '}
                  {m.filename}
                </span>
                <span
                  className="muted"
                  style={{ color: m.status === 'error' ? 'var(--danger)' : undefined, whiteSpace: 'nowrap' }}
                  title={m.error ?? (m.notesModel === 'verbatim' ? 'Short enough to use its own text' : m.notesModel ?? '')}
                >
                  {STATUS[m.status]}
                </span>
                {m.notes && (
                  <button style={{ fontSize: 10, padding: '0 6px' }} onClick={() => setOpenId(openId === m.id ? null : m.id)}>
                    {openId === m.id ? 'Hide' : 'Notes'}
                  </button>
                )}
                {m.status === 'error' && (
                  <button style={{ fontSize: 10, padding: '0 6px' }} onClick={() => void act(() => window.distill.materials.retry(m.id))}>
                    Retry
                  </button>
                )}
                <button
                  style={{ fontSize: 10, padding: '0 6px' }}
                  title="Remove this file from the meeting"
                  onClick={() => void act(() => window.distill.materials.remove(m.id))}
                >
                  Remove
                </button>
              </div>
              {m.status === 'error' && m.error && (
                <div style={{ color: 'var(--danger)', fontSize: 10 }}>{m.error}</div>
              )}
              {openId === m.id && m.notes && (
                <pre style={{ whiteSpace: 'pre-wrap', fontSize: 11, maxHeight: 240, overflowY: 'auto', margin: '4px 0 0' }}>{m.notes}</pre>
              )}
            </li>
          ))}
        </ul>
      )}
      {message && (
        <div className="muted" role="status" style={{ marginTop: 4 }}>
          {message}
        </div>
      )}
    </div>
  );
}

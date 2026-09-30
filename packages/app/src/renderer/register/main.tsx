import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientDTO } from '../shared/api.js';
import { isOverdue, type RegisterItem } from '../../shared/register.js';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

type ActionFilter = 'open' | 'done' | 'all';

/**
 * The confirmed action/decision register: items a brief or the meeting
 * reader offered and the user explicitly chose to keep. Status only ever
 * changes from the checkbox here — nothing in this window infers
 * completion from a meeting simply not mentioning something again.
 */
function Register() {
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [clientId, setClientId] = useState('');
  const [items, setItems] = useState<RegisterItem[] | null>(null);
  const [filter, setFilter] = useState<ActionFilter>('open');
  const [error, setError] = useState<string | null>(null);
  const [busyId, setBusyId] = useState<string | null>(null);

  useEffect(() => {
    void window.distill.clients.list().then((list) => {
      const usable = list.filter((c) => c.id !== 'unclassified');
      setClients(usable);
      if (usable[0]) setClientId(usable[0].id);
    });
  }, []);

  const load = useCallback(() => {
    if (!clientId) return;
    setError(null);
    void window.distill.register
      .list(clientId)
      .then(setItems)
      .catch((e) => setError(e instanceof Error ? e.message : String(e)));
  }, [clientId]);

  useEffect(() => {
    setItems(null);
    load();
  }, [load]);

  const actions = useMemo(
    () => (items ?? []).filter((i) => i.kind === 'action' && (filter === 'all' || i.status === filter)),
    [items, filter],
  );
  const decisions = useMemo(() => (items ?? []).filter((i) => i.kind === 'decision'), [items]);

  const toggle = async (item: RegisterItem) => {
    setBusyId(item.id);
    try {
      await window.distill.register.setStatus(item.id, item.status === 'done' ? 'open' : 'done');
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  const remove = async (item: RegisterItem) => {
    if (!window.confirm(`Remove "${item.text}" from the register? This can't be undone.`)) return;
    setBusyId(item.id);
    try {
      await window.distill.register.delete(item.id);
      load();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusyId(null);
    }
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <div style={{ fontWeight: 600, marginRight: 8, whiteSpace: 'nowrap' }}>Client register</div>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </header>
      <main style={{ flexGrow: 1, overflowY: 'auto', padding: '10px 14px' }}>
        {error && <div style={{ color: 'var(--danger)', fontSize: 12, margin: '10px 0' }}>{error}</div>}
        {items === null ? (
          <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>
            Loading…
          </div>
        ) : (
          <>
            <section style={{ marginBottom: 20 }}>
              <div style={{ display: 'flex', alignItems: 'baseline', gap: 10, marginBottom: 6 }}>
                <h3 style={{ fontSize: 13, margin: 0 }}>Actions</h3>
                <select value={filter} onChange={(e) => setFilter(e.target.value as ActionFilter)} style={{ fontSize: 11 }}>
                  <option value="open">Open</option>
                  <option value="done">Done</option>
                  <option value="all">All</option>
                </select>
              </div>
              {actions.length === 0 ? (
                <p className="muted" style={{ fontSize: 12 }}>
                  Nothing here. Add actions from a client brief or the meeting reader.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {actions.map((item) => (
                    <RegisterRow
                      key={item.id}
                      item={item}
                      busy={busyId === item.id}
                      onToggle={() => void toggle(item)}
                      onDelete={() => void remove(item)}
                    />
                  ))}
                </ul>
              )}
            </section>
            <section>
              <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Decisions</h3>
              {decisions.length === 0 ? (
                <p className="muted" style={{ fontSize: 12 }}>
                  None recorded for this client yet.
                </p>
              ) : (
                <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                  {decisions.map((item) => (
                    <RegisterRow key={item.id} item={item} busy={busyId === item.id} onDelete={() => void remove(item)} />
                  ))}
                </ul>
              )}
            </section>
          </>
        )}
      </main>
    </div>
  );
}

function RegisterRow(props: { item: RegisterItem; busy: boolean; onToggle?: () => void; onDelete: () => void }) {
  const { item } = props;
  const overdue = isOverdue(item);
  return (
    <li style={{ padding: '8px 0', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'flex-start' }}>
      {item.kind === 'action' && (
        <input
          type="checkbox"
          checked={item.status === 'done'}
          disabled={props.busy}
          onChange={props.onToggle}
          style={{ marginTop: 3 }}
        />
      )}
      <div style={{ flex: 1, minWidth: 0 }}>
        <div style={{ fontSize: 13, textDecoration: item.status === 'done' ? 'line-through' : 'none' }}>
          {item.owner && <strong>{item.owner}: </strong>}
          {item.text}
        </div>
        <div className="muted" style={{ fontSize: 10 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void window.distill.meeting.open(item.sourceRecordingId, 'summary');
            }}
          >
            {item.sourceTitle}
          </a>
          {' · '}
          {formatDate(item.sourceDate)}
          {item.dueAt != null && (
            <span style={{ color: overdue ? 'var(--danger)' : undefined }}>
              {' · Due '}
              {formatDate(item.dueAt)}
              {overdue ? ' (overdue)' : ''}
            </span>
          )}
        </div>
      </div>
      <button onClick={props.onDelete} disabled={props.busy} title="Remove from the register" style={{ fontSize: 10 }}>
        Remove
      </button>
    </li>
  );
}

createRoot(document.getElementById('root')!).render(<Register />);

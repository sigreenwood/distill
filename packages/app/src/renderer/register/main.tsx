import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientDTO } from '../shared/api.js';
import { isOverdue, type RegisterItem } from '../../shared/register.js';
import type { FollowUpItem, MeetingFollowUps } from '../../shared/followUps.js';

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

function errorText(e: unknown): string {
  // Electron prefixes IPC errors; keep only the message itself.
  return (e instanceof Error ? e.message : String(e)).replace(/^Error invoking remote method '[^']+': (Error: )?/, '');
}

type Tab = 'review' | 'register';
type ActionFilter = 'open' | 'done' | 'all';

const PERIODS: { label: string; days: number | null }[] = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 182 },
  { label: 'Last year', days: 365 },
  { label: 'All time', days: null },
];

/** Register entries are matched to summary lines by meeting and text, to show what is already tracked. */
const trackedKey = (recordingId: string, text: string) => `${recordingId}|${text.trim().toLowerCase()}`;

/**
 * Follow-ups: meetings whose summaries recorded actions or decisions,
 * flagged until the user marks them reviewed, and the confirmed
 * register beside them. Lines are read from the summaries as written
 * (shared/followUps.ts); nothing joins the register, and nothing is
 * marked reviewed or done, except by the user's click.
 */
function FollowUps() {
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [clientId, setClientId] = useState('');
  const [tab, setTab] = useState<Tab>('review');
  const [registerItems, setRegisterItems] = useState<RegisterItem[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.distill.clients.list().then(setClients);
  }, []);

  const loadRegister = useCallback(() => {
    setError(null);
    void window.distill.register
      .list(clientId || undefined)
      .then(setRegisterItems)
      .catch((e) => setError(errorText(e)));
  }, [clientId]);

  useEffect(() => {
    setRegisterItems(null);
    loadRegister();
  }, [loadRegister]);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' }}
      >
        <div style={{ fontWeight: 600, marginRight: 8, whiteSpace: 'nowrap' }}>Follow-ups</div>
        <div role="tablist" style={{ display: 'flex', gap: 4 }}>
          {(['review', 'register'] as const).map((t) => (
            <button key={t} role="tab" aria-selected={tab === t} className={tab === t ? 'primary' : undefined} onClick={() => setTab(t)}>
              {t === 'review' ? 'From meetings' : 'Register'}
            </button>
          ))}
        </div>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} style={{ marginLeft: 'auto' }}>
          <option value="">All clients</option>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
      </header>
      {error && <div style={{ color: 'var(--danger)', fontSize: 12, padding: '8px 14px 0' }}>{error}</div>}
      {tab === 'review' ? (
        <Review clientId={clientId} registerItems={registerItems} onRegisterChanged={loadRegister} onError={setError} />
      ) : (
        <Register clientId={clientId} items={registerItems} onChanged={loadRegister} onError={setError} />
      )}
    </div>
  );
}

function Review(props: {
  clientId: string;
  registerItems: RegisterItem[] | null;
  onRegisterChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [days, setDays] = useState<number | null>(90);
  const [unreviewedOnly, setUnreviewedOnly] = useState(true);
  const [meetings, setMeetings] = useState<MeetingFollowUps[] | null>(null);
  const [busy, setBusy] = useState(false);
  const { clientId, onError } = props;

  const load = useCallback(() => {
    void window.distill.followUps
      .list({ clientId: clientId || null, sinceDays: days, unreviewedOnly })
      .then(setMeetings)
      .catch((e) => onError(errorText(e)));
  }, [clientId, days, unreviewedOnly, onError]);

  useEffect(() => {
    setMeetings(null);
    load();
  }, [load]);

  const tracked = useMemo(
    () => new Set((props.registerItems ?? []).map((i) => trackedKey(i.sourceRecordingId, i.text))),
    [props.registerItems],
  );

  const setReviewed = async (ids: string[], reviewed: boolean) => {
    setBusy(true);
    onError(null);
    try {
      await window.distill.followUps.setReviewed(ids, reviewed);
      load();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusy(false);
    }
  };

  const pending = (meetings ?? []).filter((m) => !m.reviewed);
  const totals = (meetings ?? []).reduce(
    (t, m) => ({ actions: t.actions + m.actions.length, decisions: t.decisions + m.decisions.length }),
    { actions: 0, decisions: 0 },
  );

  return (
    <>
      <div style={{ padding: '8px 14px', display: 'flex', gap: 8, alignItems: 'center', borderBottom: '1px solid var(--border)' }}>
        <select value={days ?? 'all'} onChange={(e) => setDays(e.target.value === 'all' ? null : Number(e.target.value))}>
          {PERIODS.map((p) => (
            <option key={p.label} value={p.days ?? 'all'}>
              {p.label}
            </option>
          ))}
        </select>
        <select value={unreviewedOnly ? 'pending' : 'all'} onChange={(e) => setUnreviewedOnly(e.target.value === 'pending')}>
          <option value="pending">Not yet reviewed</option>
          <option value="all">All with follow-ups</option>
        </select>
        <span className="muted" style={{ fontSize: 11 }}>
          {meetings
            ? `${meetings.length} meeting${meetings.length === 1 ? '' : 's'} · ${totals.actions} actions · ${totals.decisions} decisions`
            : ''}
        </span>
      </div>
      <main style={{ flexGrow: 1, overflowY: 'auto', padding: '10px 14px' }}>
        {meetings === null ? (
          <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>Loading…</div>
        ) : meetings.length === 0 ? (
          <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>
            {unreviewedOnly
              ? 'Nothing left to review in this period.'
              : 'No summaries in this period recorded actions or decisions.'}
          </div>
        ) : (
          meetings.map((m) => (
            <MeetingCard
              key={m.recordingId}
              meeting={m}
              showClient={!clientId}
              tracked={tracked}
              busy={busy}
              onReviewed={(reviewed) => void setReviewed([m.recordingId], reviewed)}
              onRegisterChanged={props.onRegisterChanged}
              onError={onError}
            />
          ))
        )}
      </main>
      {pending.length > 1 && (
        <footer style={{ padding: '8px 14px', borderTop: '1px solid var(--border)', display: 'flex', justifyContent: 'flex-end' }}>
          <button
            disabled={busy}
            onClick={() => {
              if (window.confirm(`Mark all ${pending.length} meetings shown as reviewed?`)) {
                void setReviewed(pending.map((m) => m.recordingId), true);
              }
            }}
          >
            Mark all {pending.length} reviewed
          </button>
        </footer>
      )}
    </>
  );
}

function MeetingCard(props: {
  meeting: MeetingFollowUps;
  showClient: boolean;
  tracked: Set<string>;
  busy: boolean;
  onReviewed: (reviewed: boolean) => void;
  onRegisterChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const m = props.meeting;
  const sub = [formatDate(m.date), props.showClient ? m.clientName : null, m.meetingTypeName].filter(Boolean).join(' · ');
  return (
    <section style={{ padding: '10px 0 12px', borderBottom: '1px solid var(--border)', opacity: m.reviewed ? 0.7 : 1 }}>
      <div style={{ display: 'flex', gap: 8, alignItems: 'flex-start' }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <a
            href="#"
            onClick={(e) => {
              e.preventDefault();
              void window.distill.meeting.open(m.recordingId, 'summary');
            }}
            style={{ fontSize: 13, fontWeight: 500 }}
          >
            {m.title}
          </a>
          <div className="muted" style={{ fontSize: 10 }}>{sub}</div>
        </div>
        <button disabled={props.busy} onClick={() => props.onReviewed(!m.reviewed)} style={{ fontSize: 11, whiteSpace: 'nowrap' }}>
          {m.reviewed ? 'Reviewed ✓ — undo' : 'Mark reviewed'}
        </button>
      </div>
      <FollowUpList title="Actions" kind="action" items={m.actions} {...props} />
      <FollowUpList title="Decisions" kind="decision" items={m.decisions} {...props} />
    </section>
  );
}

function FollowUpList(props: {
  title: string;
  kind: 'action' | 'decision';
  items: FollowUpItem[];
  meeting: MeetingFollowUps;
  tracked: Set<string>;
  onRegisterChanged: () => void;
  onError: (message: string | null) => void;
}) {
  if (props.items.length === 0) return null;
  let lastGroup: string | null = null;
  return (
    <div style={{ marginTop: 6 }}>
      <div className="muted" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase' }}>{props.title}</div>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {props.items.map((item, i) => {
          const groupLabel = item.group && item.group !== lastGroup ? item.group : null;
          lastGroup = item.group;
          return (
            <li key={i}>
              {groupLabel && <div className="muted" style={{ fontSize: 10, marginTop: 4 }}>{groupLabel}</div>}
              <div style={{ display: 'flex', gap: 8, alignItems: 'baseline', padding: '2px 0', fontSize: 12 }}>
                <span style={{ flex: 1, minWidth: 0 }}>
                  {item.owner && <strong>{item.owner}: </strong>}
                  {item.text}
                  {item.due && <span className="muted"> — {item.due}</span>}
                </span>
                <AddToRegister kind={props.kind} item={item} meeting={props.meeting} tracked={props.tracked} onAdded={props.onRegisterChanged} onError={props.onError} />
              </div>
            </li>
          );
        })}
      </ul>
    </div>
  );
}

/** The due date stays as words in the text: the summary's "end of week" is not a date to parse. */
function registerText(kind: 'action' | 'decision', item: FollowUpItem): string {
  const text = kind === 'action' && item.due ? `${item.text} (due: ${item.due})` : item.text;
  return text.slice(0, 500);
}

function AddToRegister(props: {
  kind: 'action' | 'decision';
  item: FollowUpItem;
  meeting: MeetingFollowUps;
  tracked: Set<string>;
  onAdded: () => void;
  onError: (message: string | null) => void;
}) {
  const [busy, setBusy] = useState(false);
  const text = registerText(props.kind, props.item);
  if (props.tracked.has(trackedKey(props.meeting.recordingId, text))) {
    return <span className="muted" style={{ fontSize: 10, whiteSpace: 'nowrap' }}>In register</span>;
  }
  if (!props.meeting.clientId) return null;
  return (
    <button
      disabled={busy}
      style={{ fontSize: 10, padding: '0 6px', whiteSpace: 'nowrap' }}
      onClick={async () => {
        setBusy(true);
        props.onError(null);
        try {
          await window.distill.register.add({
            clientId: props.meeting.clientId!,
            kind: props.kind,
            text,
            owner: props.kind === 'action' ? props.item.owner : null,
            sourceRecordingId: props.meeting.recordingId,
          });
          props.onAdded();
        } catch (e) {
          props.onError(errorText(e));
        } finally {
          setBusy(false);
        }
      }}
    >
      Add to register
    </button>
  );
}

/**
 * The confirmed register: items the user chose to keep, from a meeting,
 * a brief or the reader. Status only ever changes from the checkbox here —
 * nothing infers completion from a meeting simply not mentioning
 * something again.
 */
function Register(props: {
  clientId: string;
  items: RegisterItem[] | null;
  onChanged: () => void;
  onError: (message: string | null) => void;
}) {
  const [filter, setFilter] = useState<ActionFilter>('open');
  const [busyId, setBusyId] = useState<string | null>(null);
  const { items, onChanged, onError } = props;

  const actions = useMemo(
    () => (items ?? []).filter((i) => i.kind === 'action' && (filter === 'all' || i.status === filter)),
    [items, filter],
  );
  const decisions = useMemo(() => (items ?? []).filter((i) => i.kind === 'decision'), [items]);

  const run = async (item: RegisterItem, op: () => Promise<void>) => {
    setBusyId(item.id);
    try {
      await op();
      onChanged();
    } catch (e) {
      onError(errorText(e));
    } finally {
      setBusyId(null);
    }
  };
  const toggle = (item: RegisterItem) =>
    void run(item, () => window.distill.register.setStatus(item.id, item.status === 'done' ? 'open' : 'done'));
  const remove = (item: RegisterItem) => {
    if (!window.confirm(`Remove "${item.text}" from the register? This can't be undone.`)) return;
    void run(item, () => window.distill.register.delete(item.id));
  };

  return (
    <main style={{ flexGrow: 1, overflowY: 'auto', padding: '10px 14px' }}>
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
                Nothing here. Add actions from From meetings, a client brief or the meeting reader.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {actions.map((item) => (
                  <RegisterRow
                    key={item.id}
                    item={item}
                    showClient={!props.clientId}
                    busy={busyId === item.id}
                    onToggle={() => toggle(item)}
                    onDelete={() => remove(item)}
                  />
                ))}
              </ul>
            )}
          </section>
          <section>
            <h3 style={{ fontSize: 13, margin: '0 0 6px' }}>Decisions</h3>
            {decisions.length === 0 ? (
              <p className="muted" style={{ fontSize: 12 }}>
                None recorded yet.
              </p>
            ) : (
              <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
                {decisions.map((item) => (
                  <RegisterRow key={item.id} item={item} showClient={!props.clientId} busy={busyId === item.id} onDelete={() => remove(item)} />
                ))}
              </ul>
            )}
          </section>
        </>
      )}
    </main>
  );
}

function RegisterRow(props: { item: RegisterItem; showClient: boolean; busy: boolean; onToggle?: () => void; onDelete: () => void }) {
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
          {props.showClient && `${item.clientName} · `}
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

createRoot(document.getElementById('root')!).render(<FollowUps />);

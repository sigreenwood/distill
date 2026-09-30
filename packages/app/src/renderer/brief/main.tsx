import { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientDTO } from '../shared/api.js';
import {
  BRIEF_MAX_MEETINGS,
  BRIEF_MAX_SUMMARY_CHARS,
  briefToMarkdown,
  checkBriefSelection,
  citationLabel,
  defaultBriefSelection,
  type BriefCandidate,
  type BriefItem,
  type ClientBrief,
} from '../../shared/brief.js';

const PERIODS: { label: string; days: number | null }[] = [
  { label: 'Last 30 days', days: 30 },
  { label: 'Last 90 days', days: 90 },
  { label: 'Last 6 months', days: 182 },
  { label: 'Last year', days: 365 },
  { label: 'All time', days: null },
];

function formatDate(ms: number): string {
  return new Date(ms).toLocaleDateString(undefined, { day: 'numeric', month: 'short', year: 'numeric' });
}

/**
 * On-demand brief for an upcoming client meeting, drawn from the summaries
 * of meetings the user selects. Nothing runs until Generate is pressed,
 * and nothing is saved: the result lives in this window (and the
 * clipboard, if copied).
 */
function Brief() {
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [clientId, setClientId] = useState('');
  const [days, setDays] = useState<number | null>(90);
  const [candidates, setCandidates] = useState<BriefCandidate[] | null>(null);
  const [selected, setSelected] = useState<Set<string>>(new Set());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [brief, setBrief] = useState<ClientBrief | null>(null);
  const [copied, setCopied] = useState(false);

  useEffect(() => {
    void window.distill.clients.list().then((list) => {
      const usable = list.filter((c) => c.id !== 'unclassified');
      setClients(usable);
      if (usable[0]) setClientId(usable[0].id);
    });
  }, []);

  useEffect(() => {
    if (!clientId) return;
    let cancelled = false;
    setCandidates(null);
    setBrief(null);
    setError(null);
    void window.distill.brief
      .listMeetings(clientId, days)
      .then((list) => {
        if (cancelled) return;
        setCandidates(list);
        setSelected(new Set(defaultBriefSelection(list)));
      })
      .catch((e) => {
        if (!cancelled) setError(e instanceof Error ? e.message : String(e));
      });
    return () => {
      cancelled = true;
    };
  }, [clientId, days]);

  // Closing the window mid-generation should stop the model, not leave it
  // working on a brief nobody will see.
  useEffect(() => {
    const stop = () => void window.distill.brief.cancel();
    window.addEventListener('beforeunload', stop);
    return () => window.removeEventListener('beforeunload', stop);
  }, []);

  const chosen = useMemo(
    () => (candidates ?? []).filter((m) => selected.has(m.id)),
    [candidates, selected],
  );
  const check = checkBriefSelection(chosen);

  const toggle = (id: string) =>
    setSelected((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });

  const generate = useCallback(async () => {
    setBusy(true);
    setError(null);
    setBrief(null);
    setCopied(false);
    try {
      setBrief(await window.distill.brief.generate({ clientId, recordingIds: chosen.map((m) => m.id) }));
    } catch (e) {
      const message = e instanceof Error ? e.message : String(e);
      // Electron prefixes IPC errors; keep only the message itself.
      setError(message.replace(/^Error invoking remote method '[^']+': (Error: )?/, ''));
    } finally {
      setBusy(false);
    }
  }, [clientId, chosen]);

  const copy = async () => {
    if (!brief) return;
    await navigator.clipboard.writeText(briefToMarkdown(brief));
    setCopied(true);
  };

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{ padding: '10px 14px', borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}
      >
        <div style={{ fontWeight: 600, marginRight: 8, whiteSpace: 'nowrap' }}>Client brief</div>
        <select value={clientId} onChange={(e) => setClientId(e.target.value)} disabled={busy}>
          {clients.map((c) => (
            <option key={c.id} value={c.id}>
              {c.name}
            </option>
          ))}
        </select>
        <select
          value={days ?? 'all'}
          onChange={(e) => setDays(e.target.value === 'all' ? null : Number(e.target.value))}
          disabled={busy}
        >
          {PERIODS.map((p) => (
            <option key={p.label} value={p.days ?? 'all'}>
              {p.label}
            </option>
          ))}
        </select>
      </header>
      <main style={{ flexGrow: 1, overflowY: 'auto', padding: '10px 14px' }}>
        {!brief && (
          <MeetingPicker candidates={candidates} selected={selected} onToggle={toggle} disabled={busy} />
        )}
        {error && <div style={{ color: 'var(--danger)', fontSize: 12, margin: '10px 0' }}>{error}</div>}
        {brief && <BriefView brief={brief} clientId={clientId} onError={setError} />}
      </main>
      <footer
        style={{ padding: '10px 14px', borderTop: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}
      >
        {brief ? (
          <>
            <span className="muted" style={{ fontSize: 11, flex: 1 }}>
              Drawn from {brief.sources.length} summar{brief.sources.length === 1 ? 'y' : 'ies'} by {brief.model}, on
              this Mac. Check points against their sources before relying on them.
            </span>
            <button onClick={() => void copy()}>{copied ? 'Copied' : 'Copy as Markdown'}</button>
            <button onClick={() => setBrief(null)}>Change meetings</button>
          </>
        ) : busy ? (
          <>
            <span className="muted" style={{ fontSize: 11, flex: 1 }}>
              Generating on this Mac — this can take a few minutes.
            </span>
            <button onClick={() => void window.distill.brief.cancel()}>Cancel</button>
          </>
        ) : (
          <>
            <span className="muted" style={{ fontSize: 11, flex: 1 }}>
              {chosen.length} of {BRIEF_MAX_MEETINGS} meetings ·{' '}
              {check.chars.toLocaleString()} / {BRIEF_MAX_SUMMARY_CHARS.toLocaleString()} characters
              {check.reason && chosen.length > 0 ? ` — ${check.reason}` : ''}
            </span>
            <button className="primary" disabled={!check.ok} onClick={() => void generate()}>
              Generate brief
            </button>
          </>
        )}
      </footer>
    </div>
  );
}

function MeetingPicker(props: {
  candidates: BriefCandidate[] | null;
  selected: Set<string>;
  onToggle: (id: string) => void;
  disabled: boolean;
}) {
  if (props.candidates === null) {
    return <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>Loading meetings…</div>;
  }
  if (props.candidates.length === 0) {
    return (
      <div className="muted" style={{ fontSize: 12, padding: 20, textAlign: 'center' }}>
        No meetings for this client in this period. Try a longer period.
      </div>
    );
  }
  return (
    <>
      <p className="muted" style={{ fontSize: 11, marginTop: 0 }}>
        Choose the meetings to draw on. Only their summaries are used, and only by the model on this Mac.
      </p>
      <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
        {props.candidates.map((m) => {
          const noSummary = m.summaryChars === 0;
          return (
            <li key={m.id} style={{ padding: '6px 0', borderBottom: '1px solid var(--border)' }}>
              {/* Reset the shared stylesheet's small-caps heading look for labels. */}
              <label style={{ display: 'flex', gap: 8, alignItems: 'baseline', cursor: noSummary ? 'default' : 'pointer', opacity: noSummary ? 0.5 : 1, textTransform: 'none', letterSpacing: 'normal', fontSize: 'inherit', color: 'inherit', margin: 0 }}>
                <input
                  type="checkbox"
                  checked={props.selected.has(m.id)}
                  disabled={props.disabled || noSummary}
                  onChange={() => props.onToggle(m.id)}
                />
                <span style={{ flex: 1, minWidth: 0 }}>
                  <span className="ellipsis" style={{ display: 'block', fontSize: 12 }}>{m.title}</span>
                  <span className="muted" style={{ fontSize: 10 }}>
                    {formatDate(m.date)}
                    {m.meetingType ? ` · ${m.meetingType}` : ''}
                    {noSummary ? ' · no summary' : ` · ${m.summaryChars.toLocaleString()} characters`}
                  </span>
                </span>
              </label>
            </li>
          );
        })}
      </ul>
    </>
  );
}

function BriefView({
  brief,
  clientId,
  onError,
}: {
  brief: ClientBrief;
  clientId: string;
  onError: (message: string) => void;
}) {
  const empty =
    !brief.decisions.length && !brief.commitments.length && !brief.openQuestions.length && !brief.suggestedQuestions.length;
  return (
    <div style={{ fontSize: 13, lineHeight: 1.5 }}>
      <h2 style={{ fontSize: 16, margin: '4px 0 12px' }}>{brief.clientName} — preparation brief</h2>
      {empty && <p className="muted">The model found nothing citable in these summaries.</p>}
      <Section title="Decisions" items={brief.decisions} brief={brief} clientId={clientId} registerKind="decision" onError={onError} />
      <Section
        title="Commitments made"
        note="As stated in the meetings. Whether each was done is not tracked."
        items={brief.commitments}
        brief={brief}
        owner={(i) => (i as { owner?: string | null }).owner ?? null}
        clientId={clientId}
        registerKind="action"
        onError={onError}
      />
      <Section title="Questions raised" items={brief.openQuestions} brief={brief} />
      <Section
        title="Suggested questions"
        note="The model's suggestions, prompted by the cited meetings — not something anyone said."
        items={brief.suggestedQuestions}
        brief={brief}
      />
      {brief.dropped > 0 && (
        <p className="muted" style={{ fontSize: 11 }}>
          {brief.dropped} point{brief.dropped === 1 ? '' : 's'} left out because the model gave no valid source.
        </p>
      )}
      <h3 style={{ fontSize: 13, margin: '16px 0 6px' }}>Sources</h3>
      <ul style={{ margin: 0, paddingLeft: 18, fontSize: 12 }}>
        {brief.sources.map((s) => (
          <li key={s.ref}>
            <a href="#" onClick={(e) => { e.preventDefault(); void window.distill.meeting.open(s.id, 'summary'); }}>
              {s.ref}
            </a>{' '}
            · {formatDate(s.date)} · {s.title}
          </li>
        ))}
      </ul>
    </div>
  );
}

function Section(props: {
  title: string;
  note?: string;
  items: BriefItem[];
  brief: ClientBrief;
  owner?: (i: BriefItem) => string | null;
  clientId?: string;
  /** Present only for decisions/commitments — enables "Add to register". */
  registerKind?: 'action' | 'decision';
  onError?: (message: string) => void;
}) {
  if (props.items.length === 0) return null;
  return (
    <section style={{ marginBottom: 14 }}>
      <h3 style={{ fontSize: 13, margin: '0 0 2px' }}>{props.title}</h3>
      {props.note && <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>{props.note}</div>}
      <ul style={{ margin: 0, paddingLeft: 18 }}>
        {props.items.map((item, i) => {
          const owner = props.owner?.(item);
          return (
            <li key={i} style={{ marginBottom: 4 }}>
              {owner && <strong>{owner}: </strong>}
              {item.text}{' '}
              {item.sources.map((ref) => {
                const source = props.brief.sources.find((s) => s.ref === ref);
                return (
                  <button
                    key={ref}
                    onClick={() => source && void window.distill.meeting.open(source.id, 'summary')}
                    title={source ? `Open ${source.title}` : ref}
                    style={{ fontSize: 10, padding: '0 6px', marginLeft: 2 }}
                  >
                    {citationLabel(ref, props.brief.sources)}
                  </button>
                );
              })}
              {props.registerKind && props.clientId && (
                <AddToRegisterButton
                  clientId={props.clientId}
                  kind={props.registerKind}
                  text={item.text}
                  owner={owner ?? null}
                  sourceRecordingId={props.brief.sources.find((s) => s.ref === item.sources[0])?.id ?? null}
                  onError={props.onError ?? (() => {})}
                />
              )}
            </li>
          );
        })}
      </ul>
    </section>
  );
}

/**
 * Confirms one brief point into the persistent register (shared/register.ts).
 * Uses only the first cited meeting as the source — a point citing several
 * meetings still needs exactly one "source meeting" for the register entry.
 */
function AddToRegisterButton(props: {
  clientId: string;
  kind: 'action' | 'decision';
  text: string;
  owner: string | null;
  sourceRecordingId: string | null;
  onError: (message: string) => void;
}) {
  const [state, setState] = useState<'idle' | 'busy' | 'added'>('idle');
  if (!props.sourceRecordingId) return null;
  if (state === 'added') {
    return (
      <span className="muted" style={{ fontSize: 10, marginLeft: 6 }}>
        Added to register
      </span>
    );
  }
  return (
    <button
      disabled={state === 'busy'}
      onClick={async () => {
        setState('busy');
        try {
          await window.distill.register.add({
            clientId: props.clientId,
            kind: props.kind,
            text: props.text,
            owner: props.owner,
            sourceRecordingId: props.sourceRecordingId!,
          });
          setState('added');
        } catch (e) {
          setState('idle');
          props.onError(e instanceof Error ? e.message : String(e));
        }
      }}
      style={{ fontSize: 10, padding: '0 6px', marginLeft: 6 }}
    >
      Add to register
    </button>
  );
}

createRoot(document.getElementById('root')!).render(<Brief />);

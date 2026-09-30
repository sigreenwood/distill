import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MeetingDetail } from '../../shared/meeting.js';
import type { SearchScope } from '../../shared/search.js';
import type { RegisterItemKind } from '../../shared/register.js';
import { MeetingText } from './MeetingText.js';

export function MeetingReader({ recordingId, initialScope = 'summary' }: { recordingId: string; initialScope?: SearchScope }) {
  const [meeting, setMeeting] = useState<MeetingDetail | null>(null);
  const [scope, setScope] = useState<SearchScope>(initialScope);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const [revision, setRevision] = useState(0);
  const [query, setQuery] = useState('');
  const [matchCount, setMatchCount] = useState(0);
  const [activeMatch, setActiveMatch] = useState(0);
  const [showRegisterForm, setShowRegisterForm] = useState(false);
  const [showCorrectForm, setShowCorrectForm] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const article = useRef<HTMLElement>(null);
  const findInput = useRef<HTMLInputElement>(null);

  useEffect(() => {
    let cancelled = false;
    setLoading(true);
    setError(null);
    void window.distill.meeting.get(recordingId).then(result => {
      if (!cancelled) {
        setMeeting(result);
        document.title = `${result.title} — distill`;
      }
    }).catch(e => {
      if (!cancelled) setError(e instanceof Error ? e.message : String(e));
    }).finally(() => { if (!cancelled) setLoading(false); });
    return () => { cancelled = true; };
  }, [recordingId, revision]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === 'f') {
        event.preventDefault(); findInput.current?.focus(); findInput.current?.select();
      }
      if (event.key === 'Escape') {
        if (query) setQuery(''); else window.close();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [query]);

  useLayoutEffect(() => {
    setMatchCount(article.current?.querySelectorAll('mark[data-match]').length ?? 0);
    setActiveMatch(0);
  }, [query, scope, meeting, loading]);

  useEffect(() => {
    const matches = article.current?.querySelectorAll<HTMLElement>('mark[data-match]');
    matches?.forEach((mark, index) => {
      mark.dataset.active = String(index === activeMatch);
      if (index === activeMatch) mark.scrollIntoView({ block: 'center' });
    });
  }, [activeMatch, matchCount, query, scope, meeting, loading]);

  const nextMatch = (direction: number) => {
    if (matchCount) setActiveMatch(current => (current + direction + matchCount) % matchCount);
  };
  const content = meeting?.[scope];
  return <div className="meeting-reader">
    <header className="reader-header">
      <div className="reader-heading">
        <h1>{meeting?.title ?? 'Meeting'}</h1>
        <button disabled={loading} onClick={() => setRevision(value => value + 1)}>Refresh</button>
        <button onClick={() => window.close()}>Close</button>
      </div>
      {meeting && <p className="muted reader-metadata">
        {new Date(meeting.date).toLocaleString()} · {meeting.client ?? 'Unclassified'}
        {meeting.meetingType && ` · ${meeting.meetingType}`}
        {meeting.durationSeconds != null && ` · ${Math.ceil(meeting.durationSeconds / 60)} min`}
      </p>}
      <nav aria-label="Meeting content" className="reader-toolbar">
        <button aria-pressed={scope === 'summary'} className={scope === 'summary' ? 'primary' : ''} onClick={() => setScope('summary')}>Summary</button>
        <button aria-pressed={scope === 'transcript'} className={scope === 'transcript' ? 'primary' : ''} onClick={() => setScope('transcript')}>Transcript</button>
        {meeting?.canReveal && <button onClick={() => {
          void window.distill.inbox.revealInFinder(meeting.id).catch(e => setError(e instanceof Error ? e.message : String(e)));
        }}>Show saved notes</button>}
        {meeting?.clientId && (
          <button aria-pressed={showRegisterForm} onClick={() => setShowRegisterForm(v => !v)}>
            Add to register…
          </button>
        )}
        {scope === 'transcript' && meeting?.canCorrect && (
          <button aria-pressed={showCorrectForm} onClick={() => { setShowCorrectForm(v => !v); setNotice(null); }}>
            Correct a word or phrase…
          </button>
        )}
      </nav>
      {showRegisterForm && meeting?.clientId && (
        <RegisterQuickAdd
          clientId={meeting.clientId}
          sourceRecordingId={meeting.id}
          onDone={() => setShowRegisterForm(false)}
          onError={setError}
        />
      )}
      {showCorrectForm && meeting && (
        <CorrectionForm
          recordingId={meeting.id}
          clientId={meeting.clientId}
          onSaved={message => {
            setShowCorrectForm(false);
            setNotice(message);
            setRevision(value => value + 1);
          }}
          onCancel={() => setShowCorrectForm(false)}
          onError={setError}
        />
      )}
      {notice && <p className="reader-notice" role="status">{notice}</p>}
      <div className="reader-find" role="search" aria-label="Find in this meeting">
        <input ref={findInput} type="text" aria-label={`Find in ${scope}`} placeholder={`Find in ${scope} (⌘F)`}
          value={query} maxLength={300} onChange={event => setQuery(event.target.value)}
          onKeyDown={event => {
            if (event.key === 'Enter') { event.preventDefault(); nextMatch(event.shiftKey ? -1 : 1); }
          }} />
        <span className="muted" aria-live="polite">{query.trim() ? `${matchCount ? activeMatch + 1 : 0} of ${matchCount}` : ''}</span>
        <button disabled={!matchCount} aria-label="Previous match" onClick={() => nextMatch(-1)}>↑</button>
        <button disabled={!matchCount} aria-label="Next match" onClick={() => nextMatch(1)}>↓</button>
      </div>
    </header>
    {error && <p className="reader-notice" role="alert">{error}</p>}
    {meeting?.warning && <p className="reader-notice" role="status">{meeting.warning}</p>}
    {scope === 'summary' && meeting?.truncationWarning && <p className="reader-notice">
      This meeting exceeded the estimated context budget. The summary may omit earlier details; check the transcript.
    </p>}
    <main className="reader-scroll" aria-busy={loading}>
      {loading ? <p role="status">Loading meeting…</p> : <>
        {content ? <>
          <p className="muted reader-source">{scope === 'summary' ? 'Summary' : 'Transcript'} · {content.source === 'markdown' ? 'From saved Markdown' : 'Stored on this Mac'}</p>
          <article ref={article} className="reader-content no-drag" aria-label={scope === 'summary' ? 'Meeting summary' : 'Meeting transcript'}>
            <MeetingText text={content.text} query={query} markdown={scope === 'summary'} />
          </article>
        </> : meeting && <p>No {scope} is available on this Mac for this recording.</p>}
      </>}
    </main>
  </div>;
}

type RememberScope = 'client' | 'organisation' | 'global' | '';

/**
 * Corrects a mistaken word or phrase in the stored transcript, then
 * queues the recording for a fresh summary — Whisper is never re-run
 * (see State.correctTranscript). Optionally promotes the same {from, to}
 * pair to a reusable vocabulary rule at the chosen scope, so future
 * recordings benefit too; nothing is remembered unless asked for.
 */
function CorrectionForm(props: {
  recordingId: string;
  clientId: string | null;
  onSaved: (message: string) => void;
  onCancel: () => void;
  onError: (message: string) => void;
}) {
  const [from, setFrom] = useState('');
  const [to, setTo] = useState('');
  const [rememberScope, setRememberScope] = useState<RememberScope>('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!from.trim() || !to.trim()) return;
    setBusy(true);
    try {
      const result = await window.distill.meeting.correct({
        recordingId: props.recordingId,
        from,
        to,
        rememberScope: rememberScope || null,
      });
      if (result.applied) {
        props.onSaved(
          `Corrected ${result.occurrences} occurrence${result.occurrences === 1 ? '' : 's'} and queued a fresh summary.` +
            (rememberScope ? ' Saved as a reusable vocabulary rule.' : ''),
        );
      }
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reader-register-form">
      <input type="text" placeholder="Heard as" value={from} maxLength={200} disabled={busy}
        onChange={e => setFrom(e.target.value)} />
      <span aria-hidden>→</span>
      <input type="text" placeholder="Should be" value={to} maxLength={200} disabled={busy}
        onChange={e => setTo(e.target.value)} />
      <select value={rememberScope} disabled={busy} onChange={e => setRememberScope(e.target.value as RememberScope)}>
        <option value="">Just this recording</option>
        {props.clientId && <option value="client">Remember for this client</option>}
        <option value="organisation">Remember for the organisation</option>
        <option value="global">Remember globally</option>
      </select>
      <button className="primary" disabled={busy || !from.trim() || !to.trim()} onClick={() => void save()}>
        Correct &amp; regenerate
      </button>
      <button disabled={busy} onClick={props.onCancel}>Cancel</button>
    </div>
  );
}

/**
 * Manual entry point into the confirmed register from a meeting, alongside
 * the structured "Add to register" buttons on client brief points. There is
 * no extraction here — the user types exactly what to keep.
 */
function RegisterQuickAdd(props: {
  clientId: string;
  sourceRecordingId: string;
  onDone: () => void;
  onError: (message: string) => void;
}) {
  const [kind, setKind] = useState<RegisterItemKind>('action');
  const [text, setText] = useState('');
  const [owner, setOwner] = useState('');
  const [dueDate, setDueDate] = useState('');
  const [busy, setBusy] = useState(false);

  const save = async () => {
    if (!text.trim()) return;
    setBusy(true);
    try {
      await window.distill.register.add({
        clientId: props.clientId,
        kind,
        text,
        owner: kind === 'action' && owner.trim() ? owner.trim() : null,
        dueAt: kind === 'action' && dueDate ? new Date(`${dueDate}T00:00:00`).getTime() : null,
        sourceRecordingId: props.sourceRecordingId,
      });
      props.onDone();
    } catch (e) {
      props.onError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };

  return (
    <div className="reader-register-form">
      <select value={kind} onChange={e => setKind(e.target.value as RegisterItemKind)} disabled={busy}>
        <option value="action">Action</option>
        <option value="decision">Decision</option>
      </select>
      <input
        type="text"
        placeholder={kind === 'action' ? 'What needs to happen' : 'What was decided'}
        value={text}
        maxLength={500}
        disabled={busy}
        style={{ flex: 1, minWidth: 200 }}
        onChange={e => setText(e.target.value)}
      />
      {kind === 'action' && (
        <>
          <input type="text" placeholder="Owner (optional)" value={owner} maxLength={100} disabled={busy}
            style={{ width: 140 }} onChange={e => setOwner(e.target.value)} />
          <input type="date" aria-label="Due date (optional)" value={dueDate} disabled={busy}
            onChange={e => setDueDate(e.target.value)} />
        </>
      )}
      <button className="primary" disabled={busy || !text.trim()} onClick={() => void save()}>Save</button>
      <button disabled={busy} onClick={props.onDone}>Cancel</button>
    </div>
  );
}

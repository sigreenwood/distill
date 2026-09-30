import React, { useEffect, useLayoutEffect, useRef, useState } from 'react';
import type { MeetingDetail } from '../../shared/meeting.js';
import type { SearchScope } from '../../shared/search.js';
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
      </nav>
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

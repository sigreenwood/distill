import React, { useRef, useState } from 'react';
import type { MeetingSearchResponse, SearchScope } from '../../shared/search.js';

export function MeetingSearch() {
  const [query, setQuery] = useState('');
  const [searchedQuery, setSearchedQuery] = useState('');
  const [response, setResponse] = useState<MeetingSearchResponse | null>(null);
  const [savedResults, setSavedResults] = useState<Partial<Record<SearchScope, MeetingSearchResponse>>>({});
  const [busy, setBusy] = useState<SearchScope | null>(null);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  async function search(scope: SearchScope, refresh = false) {
    const cached = savedResults[scope];
    if (!refresh && searchedQuery === query.trim() && cached) {
      setResponse(cached);
      setError(null);
      return;
    }
    const id = ++requestId.current;
    if (refresh) {
      setSavedResults({});
      setResponse(null);
    }
    setBusy(scope);
    setError(null);
    try {
      const result = await window.distill.inbox.search(query.trim(), scope);
      if (id !== requestId.current) return;
      setResponse(result);
      setSavedResults(previous => ({ ...previous, [scope]: result }));
      setSearchedQuery(query.trim());
    } catch (e) {
      if (id === requestId.current) setError(e instanceof Error ? e.message : String(e));
    } finally {
      if (id === requestId.current) setBusy(null);
    }
  }

  return <section aria-label="Search your meetings" aria-busy={!!busy} style={{ padding: 16, borderBottom: '1px solid var(--border)' }}>
    <form onSubmit={e => { e.preventDefault(); void search('summary', true); }}>
      <label htmlFor="meeting-query" style={{ display: 'block', marginBottom: 8 }}>Search your meetings</label>
      <input id="meeting-query" type="text" value={query} maxLength={1000} disabled={!!busy}
        placeholder="A call with HSBC that talked about DR"
        style={{ width: '100%', boxSizing: 'border-box', marginBottom: 8 }}
        onChange={e => {
          requestId.current++;
          setSavedResults({});
          setQuery(e.target.value); setResponse(null); setError(null); setBusy(null);
        }} />
      <div style={{ display: 'flex', flexWrap: 'wrap', gap: 8 }}>
        <button className="primary" type="submit" disabled={!!busy || !query.trim()}>Search summaries</button>
        {response && searchedQuery === query.trim() && <button type="button" disabled={!!busy}
          onClick={() => void search(response.scope === 'summary' ? 'transcript' : 'summary')}>
          {response.scope === 'summary' ? 'Search available transcripts' : 'Back to summary results'}
        </button>}
        {!!query && <button type="button" disabled={!!busy} onClick={() => {
          requestId.current++;
          setQuery(''); setSearchedQuery(''); setSavedResults({}); setResponse(null); setError(null);
        }}>Clear</button>}
      </div>
    </form>
    <div aria-live="polite" style={{ fontSize: 12, marginTop: 8 }}>
      {busy && <p>Searching {busy === 'summary' ? 'summaries' : 'available transcripts'} locally…</p>}
      {error && <p role="alert">{error}</p>}
      {!response && !busy && <span className="muted">Search summaries first, then choose to search transcripts. Includes hidden recordings.</span>}
      {response && !busy && <>
        <p>{response.totalMatches} matching recordings · Searched {response.searched} {response.scope === 'summary' ? 'summaries' : 'transcripts'}
          {response.unavailable > 0 && ` · ${response.unavailable} recordings without an available ${response.scope}`}</p>
        <p className="muted">Matching: {response.terms.map(g => g.join(' / ')).join(' + ')}</p>
        {response.warning && <p>{response.warning}</p>}
        {response.totalMatches === 0 && <p>No matches in {response.scope === 'summary' ? 'summaries. Try searching available transcripts for details omitted from the summaries.' : 'the available transcripts. Try a different company name or topic.'}</p>}
        {response.totalMatches > response.results.length && <p>Showing the newest {response.results.length} matches. Narrow your question for more specific results.</p>}
        {response.results.map(result => <article className="no-drag" key={result.id} style={{ padding: '10px 0', borderTop: '1px solid var(--border)', userSelect: 'text', overflowWrap: 'anywhere' }}>
          <strong>{result.title}</strong>
          <div className="muted">{new Date(result.date).toLocaleDateString()} · {result.client ?? 'Unclassified'} · {result.source === 'summary' ? 'Summary' : 'Transcript'}</div>
          {result.excerpts.map((excerpt, i) => <blockquote key={i} style={{ margin: '8px 0', whiteSpace: 'pre-wrap' }}>{excerpt}</blockquote>)}
          {result.canReveal && <button onClick={() => {
            void window.distill.inbox.revealInFinder(result.id).catch(e => setError(String(e)));
          }}>Show saved notes</button>}
        </article>)}
      </>}
    </div>
  </section>;
}

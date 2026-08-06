import React, { useCallback, useEffect, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { InboxItemDTO } from '../shared/api.js';
import {
  Row,
  Title,
  MetaLine,
  OutputLinks,
  FullRerunButton,
  OutputTargetPicker,
  StatusBadge,
} from '../shared/recordingRow.js';

const PAGE_SIZE = 50;

// Full re-run is only legal from a finished state (see State.fullRerun in
// main). Showing the button elsewhere would just produce an error alert.
const RERUNNABLE = new Set<InboxItemDTO['status']>(['complete', 'skipped']);

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; items: InboxItemDTO[]; total: number }
  | { kind: 'error'; message: string };

function History() {
  const [search, setSearch] = useState('');
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [loadingMore, setLoadingMore] = useState(false);
  const debounceRef = useRef<ReturnType<typeof setTimeout> | null>(null);

  const load = useCallback(async (query: string) => {
    setState({ kind: 'loading' });
    try {
      const { items, total } = await window.distill.history.list({
        search: query,
        limit: PAGE_SIZE,
        offset: 0,
      });
      setState({ kind: 'ready', items, total });
    } catch (e) {
      setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
    }
  }, []);

  // Debounced search — first search/pagination code in this app, so no
  // existing pattern to match; 300ms keeps typing feeling responsive
  // without firing a query per keystroke.
  useEffect(() => {
    if (debounceRef.current) clearTimeout(debounceRef.current);
    debounceRef.current = setTimeout(() => void load(search), 300);
    return () => {
      if (debounceRef.current) clearTimeout(debounceRef.current);
    };
  }, [search, load]);

  const searchRef = useRef(search);
  searchRef.current = search;
  useEffect(() => {
    // Deliberately mounted once, reading searchRef rather than depending on
    // `search` directly — otherwise every keystroke would tear down and
    // resubscribe the IPC listener. Refetch-on-search-change is already
    // handled by the debounce effect above.
    return window.distill.onInboxChanged(() => void load(searchRef.current));
  }, [load]);

  const onLoadMore = useCallback(async () => {
    if (state.kind !== 'ready') return;
    setLoadingMore(true);
    try {
      const { items, total } = await window.distill.history.list({
        search,
        limit: PAGE_SIZE,
        offset: state.items.length,
      });
      setState((prev) =>
        prev.kind === 'ready' ? { kind: 'ready', items: [...prev.items, ...items], total } : prev,
      );
    } catch (e) {
      alert(`Could not load more: ${e instanceof Error ? e.message : String(e)}`);
    } finally {
      setLoadingMore(false);
    }
  }, [state, search]);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          display: 'flex',
          alignItems: 'center',
          gap: 8,
        }}
      >
        <div style={{ fontWeight: 600 }}>History</div>
        <input
          type="text"
          value={search}
          onChange={(e) => setSearch(e.target.value)}
          placeholder="Search filename, client, meeting type…"
          className="no-drag"
          style={{ flex: 1, marginLeft: 8 }}
        />
        <button title="Close (Esc)" onClick={() => window.close()} style={{ padding: '2px 8px' }}>
          ×
        </button>
      </header>
      <main style={{ flexGrow: 1, overflowY: 'auto' }}>
        {state.kind === 'loading' && (
          <div className="muted" style={{ padding: 32, textAlign: 'center', fontSize: 12 }}>
            Loading…
          </div>
        )}
        {state.kind === 'error' && (
          <div style={{ padding: 32, textAlign: 'center', fontSize: 12, color: 'var(--danger)' }}>
            {state.message}
          </div>
        )}
        {state.kind === 'ready' && state.items.length === 0 && (
          <div className="muted" style={{ padding: 32, textAlign: 'center', fontSize: 12 }}>
            {search ? 'No recordings match that search.' : 'No recordings yet.'}
          </div>
        )}
        {state.kind === 'ready' && state.items.length > 0 && (
          <>
            <ul style={{ listStyle: 'none', margin: 0, padding: 0 }}>
              {state.items.map((r) => (
                <HistoryRow key={r.id} r={r} />
              ))}
            </ul>
            <div style={{ padding: 14, textAlign: 'center' }}>
              {state.items.length < state.total ? (
                <button onClick={() => void onLoadMore()} disabled={loadingMore}>
                  {loadingMore
                    ? 'Loading…'
                    : `Load more (${state.total - state.items.length} more)`}
                </button>
              ) : (
                <span className="muted" style={{ fontSize: 11 }}>
                  {state.total} recording{state.total === 1 ? '' : 's'}
                </span>
              )}
            </div>
          </>
        )}
      </main>
    </div>
  );
}

function HistoryRow({ r }: { r: InboxItemDTO }) {
  return (
    <Row id={r.id} focused={false}>
      <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginBottom: 2 }}>
        <div style={{ flex: 1, minWidth: 0 }}>
          <Title r={r} />
        </div>
        <StatusBadge status={r.status} />
      </div>
      <MetaLine r={r} />
      <OutputTargetPicker r={r} />
      <OutputLinks r={r} />
      {RERUNNABLE.has(r.status) && (
        <div className="row">
          <FullRerunButton r={r} />
        </div>
      )}
    </Row>
  );
}

createRoot(document.getElementById('root')!).render(<History />);

import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClientDTO } from '../shared/api.js';
import { MAX_ACCOUNT_CONTEXT_CHARS } from '../../shared/summaryInput.js';
import {
  editorStyle,
  footerStyle,
  paneStyle,
  promptsPaneBodyStyle,
  sidebarStyle,
  textareaStyle,
} from './ui.jsx';

const PLACEHOLDER = `Programmes and systems: …
Glossary (term — meaning): …
Key people (name — role): …
Current priorities and open issues: …`;

/**
 * Account context per client: a short brief added to every summary for
 * that client's meetings (shared/summaryInput.ts), so prompts can stay
 * per meeting type while each account's programmes, terms and people are
 * still understood and spelled right.
 */
export function ClientsPane() {
  const [clients, setClients] = useState<ClientDTO[]>([]);
  const [selectedId, setSelectedId] = useState('');
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);

  useEffect(() => {
    void window.distill.clients.list().then((list) => {
      const real = list.filter((c) => c.id !== 'unclassified');
      setClients(real);
      if (real[0]) {
        setSelectedId(real[0].id);
        setDraft(real[0].context);
      }
    });
  }, []);

  const selected = useMemo(() => clients.find((c) => c.id === selectedId), [clients, selectedId]);
  const dirty = selected !== undefined && draft !== selected.context;

  const switchTo = useCallback(
    (id: string) => {
      if (dirty && !confirm('Discard unsaved changes to this account context?')) return;
      const c = clients.find((x) => x.id === id);
      setSelectedId(id);
      setDraft(c?.context ?? '');
      setMessage(null);
    },
    [clients, dirty],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    setSaving(true);
    setMessage(null);
    try {
      const saved = await window.distill.clients.setContext(selected.id, draft);
      setClients((prev) => prev.map((c) => (c.id === saved.id ? saved : c)));
      setDraft(saved.context);
      setMessage('Saved. Applies to summaries written from now on.');
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, draft]);

  return (
    <div style={paneStyle}>
      <main style={promptsPaneBodyStyle}>
        <aside style={sidebarStyle}>
          <div className="muted" style={{ fontSize: 10, fontWeight: 600, textTransform: 'uppercase', marginBottom: 6 }}>
            Clients
          </div>
          {clients.map((c) => (
            <button
              key={c.id}
              onClick={() => switchTo(c.id)}
              style={{
                textAlign: 'left',
                border: 'none',
                padding: '6px 8px',
                borderRadius: 4,
                cursor: 'pointer',
                background: c.id === selectedId ? 'var(--row-hover)' : 'transparent',
                fontWeight: c.id === selectedId ? 500 : 400,
              }}
            >
              <div>{c.name}</div>
              <div className="muted" style={{ fontSize: 10 }}>
                {c.context.trim() ? `${c.context.trim().length} characters` : 'No account context'}
              </div>
            </button>
          ))}
          {clients.length === 0 && (
            <div className="muted" style={{ fontSize: 11 }}>
              No clients yet. Add one from the tag sheet.
            </div>
          )}
        </aside>
        <section style={editorStyle}>
          {selected ? (
            <>
              <div style={{ fontSize: 13, fontWeight: 500, marginBottom: 6 }}>{selected.name} — account context</div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
                Added to every summary of this client's meetings as background: programmes, terms, people and
                priorities, so they are understood and spelled right. Never reported as said in the meeting. Keep it
                short; prompts handle the structure.
              </div>
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setMessage(null);
                }}
                placeholder={PLACEHOLDER}
                style={textareaStyle}
                spellCheck
              />
              <div
                className="muted"
                style={{ fontSize: 11, marginTop: 4, color: draft.length > MAX_ACCOUNT_CONTEXT_CHARS ? 'var(--danger)' : undefined }}
              >
                {draft.trim().length} / {MAX_ACCOUNT_CONTEXT_CHARS} characters
              </div>
            </>
          ) : null}
        </section>
      </main>
      <footer style={footerStyle}>
        {message && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            {message}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => window.close()}>Close</button>
          <button
            className="primary"
            onClick={() => void onSave()}
            disabled={!dirty || saving || draft.length > MAX_ACCOUNT_CONTEXT_CHARS}
          >
            {saving ? 'Saving…' : 'Save context'}
          </button>
        </div>
      </footer>
    </div>
  );
}

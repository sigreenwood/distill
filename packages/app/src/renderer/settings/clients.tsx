import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type { ClientDTO, MeetingTypeDTO } from '../shared/api.js';
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
  const [newName, setNewName] = useState('');
  const [promptDirty, setPromptDirty] = useState(false);

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
  const contextDirty = selected !== undefined && draft !== selected.context;
  const dirty = contextDirty || promptDirty;

  const switchTo = useCallback(
    (id: string) => {
      if (dirty && !confirm('Discard unsaved changes for this organisation?')) return;
      const c = clients.find((x) => x.id === id);
      setPromptDirty(false);
      setSelectedId(id);
      setDraft(c?.context ?? '');
      setMessage(null);
    },
    [clients, dirty],
  );

  // A client is also an organisation the user belongs to (a club or
  // committee), not only a customer account: its notes file under its own
  // folder, and its account context carries its people and terms.
  const onAdd = useCallback(async () => {
    const name = newName.trim();
    if (!name) return;
    if (dirty && !confirm('Discard unsaved changes for this organisation?')) return;
    try {
      const created = await window.distill.clients.add({ name });
      setClients((prev) => [...prev, created]);
      setPromptDirty(false);
      setSelectedId(created.id);
      setDraft(created.context);
      setNewName('');
      setMessage(`Added ${created.name}.`);
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    }
  }, [newName, dirty]);

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
          <div style={{ display: 'flex', gap: 4, marginTop: 10 }}>
            <input
              type="text"
              value={newName}
              placeholder="New client or organisation"
              onChange={(e) => setNewName(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onAdd();
              }}
              style={{ flex: 1, minWidth: 0, fontSize: 11 }}
            />
            <button onClick={() => void onAdd()} disabled={!newName.trim()} style={{ fontSize: 11 }}>
              Add
            </button>
          </div>
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
              <OrganisationPrompts key={selected.id} client={selected} onDirtyChange={setPromptDirty} onSaved={saved => {
                setClients(prev => prev.map(c => c.id === saved.id ? saved : c));
              }} />
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
            disabled={!contextDirty || saving || draft.length > MAX_ACCOUNT_CONTEXT_CHARS}
          >
            {saving ? 'Saving…' : 'Save context'}
          </button>
        </div>
      </footer>
    </div>
  );
}


function OrganisationPrompts({ client, onSaved, onDirtyChange }: { client: ClientDTO; onSaved: (client: ClientDTO) => void; onDirtyChange: (dirty: boolean) => void }) {
  const [types, setTypes] = useState<MeetingTypeDTO[]>([]);
  const [ids, setIds] = useState<string[] | null>(client.meetingTypeIds);
  const [busy, setBusy] = useState(false);
  const [message, setMessage] = useState('');
  useEffect(() => {
    void window.distill.meetingTypes.list().then(setTypes).catch(e => setMessage(String(e)));
  }, []);
  const dirty = JSON.stringify(ids) !== JSON.stringify(client.meetingTypeIds);
  useEffect(() => onDirtyChange(dirty), [dirty, onDirtyChange]);
  const save = async () => {
    setBusy(true);
    setMessage('');
    try {
      const saved = await window.distill.clients.setMeetingTypes(client.id, ids);
      onSaved(saved);
      setMessage('Prompt choices saved.');
    } catch (e) { setMessage(e instanceof Error ? e.message : String(e)); }
    finally { setBusy(false); }
  };
  const missing = (ids ?? []).filter(id => !types.some(t => t.id === id));
  return (
    <fieldset disabled={busy} style={{ margin: '8px 0 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}>
      <legend>Meeting prompts for {client.name}</legend>
      <label style={{ display: 'block', marginBottom: 6 }}>
        <input type="checkbox" checked={ids === null} onChange={e => {
          setIds(e.target.checked ? null : types.filter(t => !t.retired).map(t => t.id));
          setMessage('');
        }} /> All active prompts
      </label>
      {ids !== null && (
        <div style={{ maxHeight: 150, overflowY: 'auto' }}>
          {types.filter(t => !t.retired || ids.includes(t.id)).map(t => (
            <label key={t.id} style={{ display: 'block', marginBottom: 4 }}>
              <input type="checkbox" checked={ids.includes(t.id)} onChange={e => {
                setIds(e.target.checked ? [...ids, t.id] : ids.filter(id => id !== t.id));
                setMessage('');
              }} /> {t.name}{t.retired ? ' (retired)' : ''}
            </label>
          ))}
          {missing.map(id => <div key={id} className="muted">{id === 'club-agm' ? 'Club · AGM' : id === 'club-committee' ? 'Club · Committee meeting' : id} — add this prompt in Settings → Prompts.</div>)}
          {ids.length === 0 && <div role="status">No prompts selected. Meetings for this organisation cannot be processed until a prompt is enabled.</div>}
        </div>
      )}
      <div style={{ display: 'flex', gap: 8, alignItems: 'center', marginTop: 8 }}>
        <button disabled={!dirty || busy} onClick={() => void save()}>{busy ? 'Saving…' : 'Save prompt choices'}</button>
        <span role="status">{message}</span>
      </div>
    </fieldset>
  );
}

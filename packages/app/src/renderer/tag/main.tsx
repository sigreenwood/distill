import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientDTO, MeetingTypeDTO } from '../shared/api.js';

type LoadState =
  | { kind: 'loading' }
  | { kind: 'ready'; clients: ClientDTO[]; meetingTypes: MeetingTypeDTO[] }
  | { kind: 'error'; message: string };

type AddClientState =
  | { open: false }
  | { open: true; name: string; saving?: boolean; error?: string | null };

type AddMeetingTypeState =
  | { open: false }
  | { open: true; name: string; prompt: string; saving?: boolean; error?: string | null };

function Tag() {
  const recordingId = useMemo(() => window.distill.tag.getSheetRecordingId(), []);
  const [state, setState] = useState<LoadState>({ kind: 'loading' });
  const [selectedClientId, setSelectedClientId] = useState('');
  const [selectedMeetingTypeId, setSelectedMeetingTypeId] = useState('');
  const [addClient, setAddClient] = useState<AddClientState>({ open: false });
  const [addMeetingType, setAddMeetingType] = useState<AddMeetingTypeState>({ open: false });
  const [saving, setSaving] = useState(false);
  const [saveError, setSaveError] = useState<string | null>(null);

  useEffect(() => {
    (async () => {
      try {
        const [clients, meetingTypes] = await Promise.all([
          window.distill.clients.list(),
          window.distill.meetingTypes.list(),
        ]);
        setState({ kind: 'ready', clients, meetingTypes });
        if (clients[0]) setSelectedClientId(clients[0].id);
        if (meetingTypes[0]) setSelectedMeetingTypeId(meetingTypes[0].id);
      } catch (e) {
        setState({ kind: 'error', message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        window.close();
      } else if ((e.metaKey || e.ctrlKey) && e.key === 'Enter') {
        void onSave();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [selectedClientId, selectedMeetingTypeId, recordingId]);

  const onAddClient = useCallback(async () => {
    if (!addClient.open) return;
    const name = addClient.name.trim();
    if (!name) {
      setAddClient({ ...addClient, error: 'Name required' });
      return;
    }
    setAddClient({ ...addClient, saving: true, error: null });
    try {
      const created = await window.distill.clients.add({ name });
      setState((prev) =>
        prev.kind === 'ready'
          ? {
              ...prev,
              clients: [...prev.clients, created].sort(
                (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
              ),
            }
          : prev,
      );
      setSelectedClientId(created.id);
      setAddClient({ open: false });
    } catch (e) {
      setAddClient({ ...addClient, saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [addClient]);

  const onAddMeetingType = useCallback(async () => {
    if (!addMeetingType.open) return;
    const name = addMeetingType.name.trim();
    const prompt = addMeetingType.prompt.trim();
    if (!name) {
      setAddMeetingType({ ...addMeetingType, error: 'Name required' });
      return;
    }
    if (!prompt) {
      setAddMeetingType({ ...addMeetingType, error: 'Prompt required' });
      return;
    }
    setAddMeetingType({ ...addMeetingType, saving: true, error: null });
    try {
      const created = await window.distill.meetingTypes.add({ name, prompt });
      setState((prev) =>
        prev.kind === 'ready'
          ? {
              ...prev,
              meetingTypes: [...prev.meetingTypes, created].sort(
                (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
              ),
            }
          : prev,
      );
      setSelectedMeetingTypeId(created.id);
      setAddMeetingType({ open: false });
    } catch (e) {
      setAddMeetingType({
        ...addMeetingType,
        saving: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [addMeetingType]);

  const onSave = useCallback(async () => {
    if (!recordingId || !selectedClientId || !selectedMeetingTypeId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await window.distill.tag.save({
        recordingId,
        clientId: selectedClientId,
        meetingTypeId: selectedMeetingTypeId,
      });
      window.close();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [recordingId, selectedClientId, selectedMeetingTypeId]);

  if (!recordingId) {
    return wrap(
      <div style={{ padding: 24 }}>
        Missing recording id. This window should be opened from the inbox.
        <div style={{ marginTop: 12 }}>
          <button onClick={() => window.close()}>Close</button>
        </div>
      </div>,
    );
  }
  if (state.kind === 'loading') {
    return wrap(<div style={{ padding: 24, color: 'var(--fg-muted)' }}>Loading…</div>);
  }
  if (state.kind === 'error') {
    return wrap(
      <div style={{ padding: 24 }}>
        <div>Could not load clients or meeting types.</div>
        <div
          className="muted"
          style={{ fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11, marginTop: 8 }}
        >
          {state.message}
        </div>
      </div>,
    );
  }

  const { clients, meetingTypes } = state;
  return wrap(
    <div style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 14 }}>
      <div>
        <label>Client</label>
        {addClient.open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              type="text"
              autoFocus
              placeholder="New client name"
              value={addClient.name}
              onChange={(e) => setAddClient({ ...addClient, name: e.target.value })}
              onKeyDown={(e) => {
                if (e.key === 'Enter') void onAddClient();
                if (e.key === 'Escape') setAddClient({ open: false });
                e.stopPropagation();
              }}
            />
            {addClient.error && (
              <div style={{ color: 'var(--danger)', fontSize: 11 }}>{addClient.error}</div>
            )}
            <div className="row">
              <button className="primary" onClick={() => void onAddClient()} disabled={addClient.saving}>
                {addClient.saving ? 'Adding…' : 'Add'}
              </button>
              <button onClick={() => setAddClient({ open: false })}>Cancel</button>
            </div>
          </div>
        ) : (
          <select
            value={selectedClientId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__add__') {
                setAddClient({ open: true, name: '', saving: false, error: null });
              } else {
                setSelectedClientId(v);
              }
            }}
          >
            {clients.map((c) => (
              <option key={c.id} value={c.id}>
                {c.name}
              </option>
            ))}
            <option disabled>────────────</option>
            <option value="__add__">+ Add new client…</option>
          </select>
        )}
      </div>
      <div>
        <label>Meeting type</label>
        {addMeetingType.open ? (
          <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
            <input
              type="text"
              autoFocus
              placeholder="Meeting type name"
              value={addMeetingType.name}
              onChange={(e) => setAddMeetingType({ ...addMeetingType, name: e.target.value })}
            />
            <label style={{ marginTop: 4 }}>Prompt</label>
            <textarea
              placeholder="Paste the system prompt here"
              value={addMeetingType.prompt}
              onChange={(e) => setAddMeetingType({ ...addMeetingType, prompt: e.target.value })}
            />
            {addMeetingType.error && (
              <div style={{ color: 'var(--danger)', fontSize: 11 }}>{addMeetingType.error}</div>
            )}
            <div className="row">
              <button
                className="primary"
                onClick={() => void onAddMeetingType()}
                disabled={addMeetingType.saving}
              >
                {addMeetingType.saving ? 'Adding…' : 'Add'}
              </button>
              <button onClick={() => setAddMeetingType({ open: false })}>Cancel</button>
            </div>
          </div>
        ) : (
          <select
            value={selectedMeetingTypeId}
            onChange={(e) => {
              const v = e.target.value;
              if (v === '__add__') {
                setAddMeetingType({ open: true, name: '', prompt: '', saving: false, error: null });
              } else {
                setSelectedMeetingTypeId(v);
              }
            }}
          >
            {meetingTypes.map((m) => (
              <option key={m.id} value={m.id}>
                {m.name}
              </option>
            ))}
            <option disabled>────────────</option>
            <option value="__add__">+ Add new meeting type…</option>
          </select>
        )}
      </div>
      {saveError && (
        <div style={{ color: 'var(--danger)', fontSize: 12, marginTop: -6 }}>{saveError}</div>
      )}
      <div className="row" style={{ justifyContent: 'flex-end', marginTop: 'auto' }}>
        <button onClick={() => window.close()}>Cancel</button>
        <button
          className="primary"
          onClick={() => void onSave()}
          disabled={
            saving || !selectedClientId || !selectedMeetingTypeId || addClient.open || addMeetingType.open
          }
        >
          {saving ? 'Starting…' : 'Process'}
        </button>
      </div>
    </div>,
  );
}

function wrap(children: React.ReactNode) {
  return (
    <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
      <header
        style={{
          padding: '10px 14px',
          borderBottom: '1px solid var(--border)',
          fontWeight: 600,
        }}
      >
        Process recording
      </header>
      <main style={{ flexGrow: 1, overflow: 'auto', display: 'flex', flexDirection: 'column' }}>
        {children}
      </main>
    </div>
  );
}

const root = createRoot(document.getElementById('root')!);
root.render(
  <React.StrictMode>
    <Tag />
  </React.StrictMode>,
);

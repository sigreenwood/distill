import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import type { ClientDTO, FrequentAttendee, MeetingTypeDTO } from '../shared/api.js';
import type { MeetingTypeSuggestion } from '../../shared/meetingTypeSuggestion.js';
import { attendeeKey, parseAttendeesText, type Attendee } from '../../shared/attendees.js';

function mergeAttendees(existing: Attendee[], parsed: Attendee[]): Attendee[] {
  const merged = [...existing];
  for (const a of parsed) {
    const key = a.email ? a.email.toLowerCase() : a.name.trim().toLowerCase();
    const dupe = merged.some((m) => (m.email ? m.email.toLowerCase() : m.name.trim().toLowerCase()) === key);
    if (!dupe) merged.push(a);
  }
  return merged;
}

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
  const [attendeePaste, setAttendeePaste] = useState('');
  const [attendees, setAttendees] = useState<Attendee[]>([]);
  // Suggestions are shown, never applied automatically — a wrong guess
  // that silently changed the selection could send a recording through
  // the wrong pipeline (wrong client, or the wrong summarise prompt)
  // with nothing to notice. The user always clicks "Use this" (or just
  // picks directly), which is also what stops the suggestion from
  // recomputing itself out from under a deliberate choice.
  const [clientTouched, setClientTouched] = useState(false);
  const [clientSuggestion, setClientSuggestion] = useState<{ id: string; name: string; label?: string } | null>(null);
  // The Outlook meeting this recording overlapped, if a calendar printout
  // was imported: offered as suggestions, never applied unasked.
  const [calendar, setCalendar] = useState<Awaited<ReturnType<typeof window.distill.tag.calendarContext>>>(null);
  const [calendarOfferDismissed, setCalendarOfferDismissed] = useState(false);
  const [meetingTypeTouched, setMeetingTypeTouched] = useState(false);
  const [meetingTypeSuggestion, setMeetingTypeSuggestion] = useState<MeetingTypeSuggestion | null>(null);
  const [clipboardOffer, setClipboardOffer] = useState<Attendee[]>([]);
  const [frequent, setFrequent] = useState<FrequentAttendee[]>([]);
  const [addClient, setAddClient] = useState<AddClientState>({ open: false });
  const [addMeetingType, setAddMeetingType] = useState<AddMeetingTypeState>({ open: false });
  const [urgent, setUrgent] = useState(false);
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
      setClientTouched(true);
      setClientSuggestion(null);
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
      setMeetingTypeTouched(true);
      setMeetingTypeSuggestion(null);
      setAddMeetingType({ open: false });
    } catch (e) {
      setAddMeetingType({
        ...addMeetingType,
        saving: false,
        error: e instanceof Error ? e.message : String(e),
      });
    }
  }, [addMeetingType]);

  useEffect(() => {
    if (!recordingId) return;
    void window.distill.tag
      .calendarContext(recordingId)
      .then(setCalendar)
      .catch(() => setCalendar(null));
  }, [recordingId]);

  // Offer attendees already on the clipboard, e.g. copied from the invite
  // just before opening this sheet. Offered, never added unasked.
  useEffect(() => {
    void window.distill.tag
      .clipboardAttendees()
      .then(setClipboardOffer)
      .catch(() => setClipboardOffer([]));
  }, []);

  useEffect(() => {
    if (!selectedClientId) return;
    let cancelled = false;
    void window.distill.tag
      .frequentAttendees(selectedClientId)
      .then((list) => {
        if (!cancelled) setFrequent(list);
      })
      .catch(() => {
        if (!cancelled) setFrequent([]);
      });
    return () => {
      cancelled = true;
    };
  }, [selectedClientId]);

  // Work out which client the attendees' email domains point to, until
  // the user has made their own choice — shown as a suggestion to click,
  // never applied to selectedClientId on its own.
  useEffect(() => {
    if (!clientTouched && calendar?.account) {
      // The meeting title or invitees name the account — stronger than
      // the domain history below, which needs past tagged meetings.
      setClientSuggestion({ id: calendar.account.id, name: calendar.account.name, label: calendar.account.reason });
      return;
    }
    if (clientTouched || state.kind !== 'ready' || attendees.length === 0) {
      setClientSuggestion(null);
      return;
    }
    let cancelled = false;
    const clients = state.clients;
    void window.distill.tag
      .suggestClient(attendees)
      .then((id) => {
        if (cancelled) return;
        const client = id ? clients.find((c) => c.id === id) : undefined;
        setClientSuggestion(client ? { id: client.id, name: client.name } : null);
      })
      .catch(() => {
        if (!cancelled) setClientSuggestion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [attendees, clientTouched, state, calendar]);

  // Same idea for meeting type, but re-fires whenever the signals it
  // reasons over change (attendees pasted/added, client picked) since a
  // local Ollama call isn't free the way the pure client heuristic is.
  // Silently does nothing with fewer than two meeting types to choose
  // between (see suggestMeetingType's own guard) or on any failure —
  // this is advisory, never something Process should wait on or fail for,
  // and never applied to selectedMeetingTypeId without the user clicking it.
  useEffect(() => {
    if (meetingTypeTouched || state.kind !== 'ready' || !recordingId || state.meetingTypes.length < 2) {
      setMeetingTypeSuggestion(null);
      return;
    }
    let cancelled = false;
    const typeIds = new Set(state.meetingTypes.map((m) => m.id));
    void window.distill.tag
      .suggestMeetingType({ recordingId, clientId: selectedClientId || undefined, attendees })
      .then((suggestion) => {
        if (cancelled) return;
        setMeetingTypeSuggestion(suggestion && typeIds.has(suggestion.meetingTypeId) ? suggestion : null);
      })
      .catch(() => {
        if (!cancelled) setMeetingTypeSuggestion(null);
      });
    return () => {
      cancelled = true;
    };
  }, [recordingId, attendees, selectedClientId, meetingTypeTouched, state]);

  const addedKeys = useMemo(() => new Set(attendees.map(attendeeKey)), [attendees]);
  const clipboardNew = clipboardOffer.filter((a) => !addedKeys.has(attendeeKey(a)));
  const calendarNew = calendarOfferDismissed ? [] : (calendar?.attendees ?? []).filter((a) => !addedKeys.has(attendeeKey(a)));
  const frequentNew = frequent.filter((a) => !addedKeys.has(attendeeKey(a)));

  const onAddAttendees = useCallback((toAdd: Attendee[]) => {
    setAttendees((prev) =>
      mergeAttendees(
        prev,
        toAdd.map(({ name, email, company }) => ({ name, email, company })),
      ),
    );
  }, []);

  const onParseAttendees = useCallback(() => {
    const parsed = parseAttendeesText(attendeePaste);
    if (parsed.length === 0) return;
    setAttendees((prev) => mergeAttendees(prev, parsed));
    setAttendeePaste('');
  }, [attendeePaste]);

  const onRemoveAttendee = useCallback((index: number) => {
    setAttendees((prev) => prev.filter((_, i) => i !== index));
  }, []);

  const onRenameAttendee = useCallback((index: number, name: string) => {
    setAttendees((prev) => prev.map((a, i) => (i === index ? { ...a, name } : a)));
  }, []);

  const onSave = useCallback(async () => {
    if (!recordingId || !selectedClientId || !selectedMeetingTypeId) return;
    setSaving(true);
    setSaveError(null);
    try {
      // Anything still sitting unparsed in the paste box (pasted, then
      // saved without clicking Parse) gets folded in here rather than
      // silently dropped.
      const finalAttendees = mergeAttendees(attendees, parseAttendeesText(attendeePaste));
      await window.distill.tag.save({
        recordingId,
        clientId: selectedClientId,
        meetingTypeId: selectedMeetingTypeId,
        ...(finalAttendees.length > 0 ? { attendees: finalAttendees } : {}),
        ...(urgent ? { urgent: true } : {}),
      });
      window.close();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [recordingId, selectedClientId, selectedMeetingTypeId, attendees, attendeePaste, urgent]);

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
  }, [onSave]);

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
        {calendar && (
          <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
            📅 Calendar: <strong>{calendar.subject}</strong>
            {calendar.alternative ? ` (or “${calendar.alternative}”, which overlapped as much)` : ''}
          </div>
        )}
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
                setClientTouched(true);
                setClientSuggestion(null);
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
        {clientSuggestion && clientSuggestion.id !== selectedClientId && !addClient.open && (
          <div
            className="row"
            style={{
              marginTop: 4,
              padding: '4px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 10,
              alignItems: 'center',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }} className="muted">
              {clientSuggestion.label ? (
                <>
                  Suggested: <strong>{clientSuggestion.name}</strong> — {clientSuggestion.label}
                </>
              ) : (
                <>
                  Suggested from attendees' email domains: <strong>{clientSuggestion.name}</strong>
                </>
              )}
            </span>
            <button
              style={{ fontSize: 10, padding: '2px 8px' }}
              onClick={() => {
                setSelectedClientId(clientSuggestion.id);
                setClientTouched(true);
                setClientSuggestion(null);
              }}
            >
              Use this
            </button>
          </div>
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
                setMeetingTypeTouched(true);
                setMeetingTypeSuggestion(null);
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
        {meetingTypeSuggestion &&
          meetingTypeSuggestion.meetingTypeId !== selectedMeetingTypeId &&
          !addMeetingType.open &&
          (() => {
            const suggestedType = meetingTypes.find((m) => m.id === meetingTypeSuggestion.meetingTypeId);
            if (!suggestedType) return null;
            return (
              <div
                className="row"
                style={{
                  marginTop: 4,
                  padding: '4px 8px',
                  border: '1px solid var(--border)',
                  borderRadius: 4,
                  fontSize: 10,
                  alignItems: 'center',
                }}
              >
                <span style={{ flex: 1, minWidth: 0 }} className="muted">
                  Suggested ({meetingTypeSuggestion.confidence} confidence): <strong>{suggestedType.name}</strong>
                  {meetingTypeSuggestion.reason ? ` — ${meetingTypeSuggestion.reason}` : ''}
                </span>
                <button
                  style={{ fontSize: 10, padding: '2px 8px' }}
                  onClick={() => {
                    setSelectedMeetingTypeId(meetingTypeSuggestion.meetingTypeId);
                    setMeetingTypeTouched(true);
                    setMeetingTypeSuggestion(null);
                  }}
                >
                  Use this
                </button>
              </div>
            );
          })()}
      </div>
      <div>
        <label>Attendees (optional)</label>
        <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
          Paste the invite's attendee list — names, bare emails, or Outlook's
          "Name &lt;email&gt;" format all work. Used to help Whisper spell names
          correctly and to give the summary a roster to reference.
        </div>
        {calendarNew.length > 0 && (
          <div
            className="row"
            style={{
              marginBottom: 6,
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 11,
              alignItems: 'center',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }} className="ellipsis">
              Calendar invite has {calendarNew.length} {calendarNew.length === 1 ? 'person' : 'people'}:{' '}
              {calendarNew.map((a) => a.name).join(', ')}
            </span>
            <button className="primary" onClick={() => onAddAttendees(calendarNew)}>
              Add
            </button>
            <button onClick={() => setCalendarOfferDismissed(true)} title="Dismiss">
              ×
            </button>
          </div>
        )}
        {clipboardNew.length > 0 && (
          <div
            className="row"
            style={{
              marginBottom: 6,
              padding: '6px 8px',
              border: '1px solid var(--border)',
              borderRadius: 4,
              fontSize: 11,
              alignItems: 'center',
            }}
          >
            <span style={{ flex: 1, minWidth: 0 }} className="ellipsis">
              Clipboard has {clipboardNew.length} attendee{clipboardNew.length === 1 ? '' : 's'}:{' '}
              {clipboardNew.map((a) => a.name).join(', ')}
            </span>
            <button className="primary" onClick={() => onAddAttendees(clipboardNew)}>
              Add
            </button>
            <button onClick={() => setClipboardOffer([])} title="Dismiss">
              ×
            </button>
          </div>
        )}
        <textarea
          placeholder="Simon Greenwood <greenwood.simon@teradata.com>; jane.doe@acme.com"
          value={attendeePaste}
          onChange={(e) => setAttendeePaste(e.target.value)}
          style={{ minHeight: 50 }}
          onKeyDown={(e) => e.stopPropagation()}
        />
        <div className="row" style={{ marginTop: 6 }}>
          <button onClick={onParseAttendees} disabled={attendeePaste.trim().length === 0}>
            Parse
          </button>
        </div>
        {attendees.length > 0 && (
          <ul style={{ listStyle: 'none', margin: '8px 0 0', padding: 0 }}>
            {attendees.map((a, i) => (
              <li
                key={`${a.email ?? a.name}-${i}`}
                style={{ display: 'flex', alignItems: 'center', gap: 6, marginBottom: 4 }}
              >
                <input
                  type="text"
                  value={a.name}
                  onChange={(e) => onRenameAttendee(i, e.target.value)}
                  style={{ flex: 1 }}
                />
                {(a.email || a.company) && (
                  <span
                    className="muted"
                    style={{ fontSize: 10, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                    title={[a.email, a.company].filter(Boolean).join(' · ')}
                  >
                    {[a.email, a.company].filter(Boolean).join(' · ')}
                  </span>
                )}
                <button
                  onClick={() => onRemoveAttendee(i)}
                  title="Remove"
                  style={{ padding: '2px 8px', fontSize: 12 }}
                >
                  ×
                </button>
              </li>
            ))}
          </ul>
        )}
        {frequentNew.length > 0 && (
          <div style={{ marginTop: 8 }}>
            <div className="muted" style={{ fontSize: 10, marginBottom: 4 }}>
              From past{' '}
              {state.kind === 'ready'
                ? (state.clients.find((c) => c.id === selectedClientId)?.name ?? '')
                : ''}{' '}
              meetings:
            </div>
            <div style={{ display: 'flex', flexWrap: 'wrap', gap: 4 }}>
              {frequentNew.map((a) => (
                <button
                  key={attendeeKey(a)}
                  onClick={() => onAddAttendees([a])}
                  title={[a.email, a.company, `${a.meetings} meeting${a.meetings === 1 ? '' : 's'}`]
                    .filter(Boolean)
                    .join(' · ')}
                  style={{ fontSize: 11, padding: '2px 8px' }}
                >
                  + {a.name}
                </button>
              ))}
            </div>
          </div>
        )}
      </div>
      <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, cursor: 'pointer' }}>
        <input type="checkbox" checked={urgent} onChange={(e) => setUrgent(e.target.checked)} />
        Urgent — process as soon as possible
      </label>
      <div className="muted" style={{ fontSize: 10, marginTop: -8 }}>
        Only matters if Settings → General has processing limited to idle time or an overnight window;
        otherwise everything already starts right away.
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

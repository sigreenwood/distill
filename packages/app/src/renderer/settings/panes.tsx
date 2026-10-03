import React, { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  GeneralDTO,
  MeetingTypeDTO,
  SuggestionView,
  ModelSuggestionDTO,
  OutputsDTO,
  PerformanceDTO,
  PlaudStatusDTO,
  SourcesDTO,
  SystemInfoDTO,
  VocabularyBudgetDTO,
  VocabularyFileDTO,
  VocabularyScopeDTO,
} from '../shared/api.js';
import type { ProcessingSchedule } from '../../shared/processingSchedule.js';
import {
  KEEPALIVE_PRESETS,
  WHISPER_MODEL_PRESETS,
  DestinationCard,
  FolderField,
  ModifiedBadge,
  TranscriptToggle,
  addButtonStyle,
  deleteButtonStyle,
  editorHeaderStyle,
  editorStyle,
  errorBoxStyle,
  fieldLabelStyle,
  footerStyle,
  formatBytes,
  formatRelative,
  helpCodeStyle,
  hintStyle,
  infoBoxStyle,
  inputStyle,
  modelMatches,
  notesListStyle,
  paneBodyStyle,
  paneStyle,
  promptsPaneBodyStyle,
  replacementHeaderStyle,
  sectionHeadingStyle,
  sidebarItemStyle,
  sidebarLabelStyle,
  sidebarMetaStyle,
  sidebarStyle,
  tableRowStyle,
  tableStyle,
  termCountBadgeStyle,
  textareaStyle,
  warningBoxStyle,
  aboutFooterStyle,
  aboutHeadingStyle,
  aboutLeadStyle,
  aboutOrderedListStyle,
  aboutSectionStyle,
  aboutSmallTextStyle,
  aboutSubheadingStyle,
  aboutUnorderedListStyle,
  aboutVersionStyle,
} from './ui.jsx';

// --- Outputs ---------------------------------------------------------------

export function OutputsPane(props: { initial: OutputsDTO; onSaved: (next: OutputsDTO) => void }) {
  const [outputs, setOutputs] = useState<OutputsDTO>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const updateOutputs = useCallback((patch: Partial<OutputsDTO>) => {
    setOutputs((prev) => ({ ...prev, ...patch }));
    setSavedAt(null);
  }, []);

  const browseFor = useCallback(async (current: string, apply: (next: string) => void) => {
    try {
      const chosen = await window.distill.settings.browseFolder(current);
      if (chosen) apply(chosen);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    }
  }, []);

  const nothingEnabled =
    !outputs.markdown.enabled && !outputs.html.enabled && !outputs.appleNotes.enabled;

  const onSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      await window.distill.settings.saveOutputs(outputs);
      setSavedAt(Date.now());
      props.onSaved(outputs);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [outputs, props]);

  return (
    <div style={paneStyle}>
      <main style={paneBodyStyle}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          Summaries can be written to any combination of the three destinations below. Tick the ones
          you want; each file destination has its own folder.
        </p>
        <DestinationCard
          title="Markdown file"
          description="Plain .md with YAML frontmatter. Good for Obsidian, text editors, git."
          enabled={outputs.markdown.enabled}
          onToggle={(v) => updateOutputs({ markdown: { ...outputs.markdown, enabled: v } })}
        >
          {outputs.markdown.enabled && (
            <>
              <FolderField
                label="Folder"
                value={outputs.markdown.dir}
                onChange={(v) => updateOutputs({ markdown: { ...outputs.markdown, dir: v } })}
                onBrowse={() =>
                  void browseFor(outputs.markdown.dir, (next) =>
                    updateOutputs({ markdown: { ...outputs.markdown, dir: next } }),
                  )
                }
              />
              <TranscriptToggle
                checked={outputs.markdown.includeTranscript}
                onChange={(v) =>
                  updateOutputs({ markdown: { ...outputs.markdown, includeTranscript: v } })
                }
              />
            </>
          )}
        </DestinationCard>
        <DestinationCard
          title="HTML file"
          description="Self-contained .html with basic styling. Good for emailing or archiving."
          enabled={outputs.html.enabled}
          onToggle={(v) => updateOutputs({ html: { ...outputs.html, enabled: v } })}
        >
          {outputs.html.enabled && (
            <>
              <FolderField
                label="Folder"
                value={outputs.html.dir}
                onChange={(v) => updateOutputs({ html: { ...outputs.html, dir: v } })}
                onBrowse={() =>
                  void browseFor(outputs.html.dir, (next) =>
                    updateOutputs({ html: { ...outputs.html, dir: next } }),
                  )
                }
              />
              <TranscriptToggle
                checked={outputs.html.includeTranscript}
                onChange={(v) => updateOutputs({ html: { ...outputs.html, includeTranscript: v } })}
              />
            </>
          )}
        </DestinationCard>
        <DestinationCard
          title="Apple Notes"
          description="Notes are organised as {Parent folder} → {Client name} → Note."
          enabled={outputs.appleNotes.enabled}
          onToggle={(v) => updateOutputs({ appleNotes: { ...outputs.appleNotes, enabled: v } })}
        >
          {outputs.appleNotes.enabled && (
            <>
              <div style={{ marginTop: 10 }}>
                <label style={fieldLabelStyle}>Parent folder in Notes</label>
                <input
                  type="text"
                  value={outputs.appleNotes.parentFolder}
                  onChange={(e) =>
                    updateOutputs({
                      appleNotes: { ...outputs.appleNotes, parentFolder: e.target.value },
                    })
                  }
                  style={inputStyle}
                  placeholder="distill"
                />
                <div className="muted" style={hintStyle}>
                  Created automatically in your default Notes account if it doesn't exist. Requires
                  Automation permission for Notes.app the first time you save a summary.
                </div>
              </div>
              <TranscriptToggle
                checked={outputs.appleNotes.includeTranscript}
                onChange={(v) =>
                  updateOutputs({ appleNotes: { ...outputs.appleNotes, includeTranscript: v } })
                }
              />
            </>
          )}
        </DestinationCard>
        {nothingEnabled && (
          <div style={warningBoxStyle}>
            At least one destination must be enabled, otherwise summaries have nowhere to land.
          </div>
        )}
        {error && (
          <div role="alert" style={errorBoxStyle}>
            {error}
          </div>
        )}
      </main>
      <footer style={footerStyle}>
        {savedAt && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            Saved.
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => window.close()}>Close</button>
          <button className="primary" onClick={() => void onSave()} disabled={saving || nothingEnabled}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

// --- Prompts ---------------------------------------------------------------

export function PromptsPane(props: {
  initial: MeetingTypeDTO[];
  onChanged: (next: MeetingTypeDTO[]) => void;
}) {
  const [prompts, setPrompts] = useState<MeetingTypeDTO[]>(props.initial);
  const [selectedId, setSelectedId] = useState<string>(props.initial[0]?.id ?? '');
  const [draft, setDraft] = useState<string>(props.initial[0]?.prompt ?? '');
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);
  const [creating, setCreating] = useState<{ name: string; prompt: string } | null>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSaving, setCreateSaving] = useState(false);
  // Suggested meeting types (resources/prompts/suggested-meeting-types.md):
  // previewed read-only, added only on "Add meeting type".
  const [suggestions, setSuggestions] = useState<SuggestionView[]>([]);
  const [previewing, setPreviewing] = useState<SuggestionView | null>(null);
  // "When to use" for the selected type: what automatic matching reads.
  const [descDraft, setDescDraft] = useState<string>(props.initial[0]?.description ?? '');
  const [suggestionBusy, setSuggestionBusy] = useState(false);

  useEffect(() => {
    void window.distill.promptSuggestions
      .list()
      .then(setSuggestions)
      .catch(() => setSuggestions([]));
  }, []);

  const onAcceptSuggestion = useCallback(async () => {
    if (!previewing) return;
    setSuggestionBusy(true);
    try {
      const created = await window.distill.promptSuggestions.accept(previewing.key);
      const next = prompts.some((p) => p.id === created.id)
        ? prompts.map((p) => (p.id === created.id ? created : p))
        : [...prompts, created];
      setPrompts(next);
      props.onChanged(next);
      setSuggestions((prev) => prev.filter((x) => x.id !== previewing.id));
      setPreviewing(null);
      setSelectedId(created.id);
      setDraft(created.prompt);
      setDescDraft(created.description);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSuggestionBusy(false);
    }
  }, [previewing, prompts, props]);

  const onDismissSuggestion = useCallback(async () => {
    if (!previewing) return;
    setSuggestionBusy(true);
    try {
      await window.distill.promptSuggestions.dismiss(previewing.key);
      setSuggestions((prev) => prev.filter((x) => x.key !== previewing.key));
      setPreviewing(null);
    } finally {
      setSuggestionBusy(false);
    }
  }, [previewing]);

  const selected = useMemo(() => prompts.find((p) => p.id === selectedId), [prompts, selectedId]);

  const switchTo = useCallback(
    (id: string) => {
      const p = prompts.find((x) => x.id === id);
      if (!p) return;
      setSelectedId(id);
      setDraft(p.prompt);
      setDescDraft(p.description);
      setError(null);
      setSavedAt(null);
      setCreating(null);
      setCreateError(null);
      setPreviewing(null);
    },
    [prompts],
  );

  const openCreate = useCallback(() => {
    setCreating({ name: '', prompt: '' });
    setCreateError(null);
  }, []);

  const onCreate = useCallback(async () => {
    if (!creating) return;
    const name = creating.name.trim();
    const prompt = creating.prompt.trim();
    if (name.length === 0) {
      setCreateError('Name required.');
      return;
    }
    if (prompt.length === 0) {
      setCreateError('Prompt cannot be empty.');
      return;
    }
    setCreateError(null);
    setCreateSaving(true);
    try {
      const created = await window.distill.meetingTypes.add({ name, prompt });
      const next = [...prompts, created].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name),
      );
      setPrompts(next);
      props.onChanged(next);
      setSelectedId(created.id);
      setDraft(created.prompt);
      setCreating(null);
      setSavedAt(Date.now());
    } catch (e) {
      setCreateError(e instanceof Error ? e.message : String(e));
    } finally {
      setCreateSaving(false);
    }
  }, [creating, prompts, props]);

  const applyUpdatedPrompt = useCallback(
    (updated: MeetingTypeDTO) => {
      const next = prompts.map((p) => (p.id === updated.id ? updated : p));
      setPrompts(next);
      props.onChanged(next);
      if (updated.id === selectedId) setDraft(updated.prompt);
    },
    [prompts, props, selectedId],
  );

  const promptDirty = selected ? draft !== selected.prompt : false;
  const descDirty = selected ? descDraft.trim() !== selected.description.trim() : false;
  const isDirty = promptDirty || descDirty;

  const onSave = useCallback(async () => {
    if (!selected) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError('Prompt cannot be empty.');
      return;
    }
    setError(null);
    setSaving(true);
    try {
      let updated = selected;
      if (promptDirty) updated = await window.distill.settings.savePrompt({ id: selected.id, prompt: draft });
      if (descDirty) updated = await window.distill.meetingTypes.updateMeta(selected.id, { description: descDraft });
      applyUpdatedPrompt(updated);
      setDescDraft(updated.description);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, draft, descDraft, promptDirty, descDirty, applyUpdatedPrompt]);

  // Retired types stay for past recordings but are no longer offered in
  // the pickers or chosen by automatic matching.
  const onToggleRetired = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await window.distill.meetingTypes.updateMeta(selected.id, { retired: !selected.retired });
      applyUpdatedPrompt(updated);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, applyUpdatedPrompt]);

  const onRevert = useCallback(async () => {
    if (!selected || !selected.is_builtin) return;
    setError(null);
    setSaving(true);
    try {
      const updated = await window.distill.settings.revertPromptToBuiltin(selected.id);
      applyUpdatedPrompt(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, applyUpdatedPrompt]);

  const onDelete = useCallback(async () => {
    if (!selected || selected.is_builtin) return;
    const confirmed = window.confirm(
      `Delete “${selected.name}”? This can't be undone.\n\nAny existing recordings tagged with this prompt will be detached — their summaries on disk and inbox history are kept, but the meeting type will show as blank for those rows.`,
    );
    if (!confirmed) return;
    setError(null);
    setSaving(true);
    try {
      await window.distill.meetingTypes.delete(selected.id);
      const next = prompts.filter((p) => p.id !== selected.id);
      setPrompts(next);
      props.onChanged(next);
      const fallback = next[0];
      if (fallback) {
        setSelectedId(fallback.id);
        setDraft(fallback.prompt);
      } else {
        setSelectedId('');
        setDraft('');
      }
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, prompts, props]);

  const onImport = useCallback(async () => {
    setError(null);
    setImportMessage(null);
    setImporting(true);
    try {
      const result = await window.distill.settings.importPrompts();
      if (result === null) return;
      setPrompts(result.prompts);
      props.onChanged(result.prompts);
      const stillSelected = result.prompts.find((p) => p.id === selectedId);
      const next = stillSelected ?? result.prompts[0];
      if (next) {
        setSelectedId(next.id);
        setDraft(next.prompt);
      } else {
        setSelectedId('');
        setDraft('');
      }
      setSavedAt(null);
      setImportMessage(
        `Imported ${result.created + result.updated} prompt${
          result.created + result.updated === 1 ? '' : 's'
        } (${result.created} new, ${result.updated} updated).`,
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [props, selectedId]);

  return (
    <div style={paneStyle}>
      <main style={promptsPaneBodyStyle}>
        <aside style={sidebarStyle}>
          <div className="muted" style={sidebarLabelStyle}>
            Meeting types
          </div>
          {prompts.map((p) => (
            <button
              key={p.id}
              onClick={() => switchTo(p.id)}
              style={{
                ...sidebarItemStyle,
                background: p.id === selectedId && !creating && !previewing ? 'var(--row-hover)' : 'transparent',
                fontWeight: p.id === selectedId && !creating && !previewing ? 500 : 400,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', opacity: p.retired ? 0.55 : 1 }}>{p.name}</span>
                {p.is_modified && <ModifiedBadge />}
              </div>
              <div className="muted" style={sidebarMetaStyle}>
                {p.retired ? 'Retired · ' : ''}
                {p.is_builtin ? 'Built-in' : 'User'} · {formatRelative(p.updated_at)}
              </div>
            </button>
          ))}
          <button
            onClick={openCreate}
            style={{
              ...addButtonStyle,
              alignSelf: 'stretch',
              marginTop: 8,
              textAlign: 'center',
              background: creating ? 'var(--row-hover)' : 'transparent',
              fontWeight: creating ? 500 : 400,
            }}
            title="Create a new meeting type"
          >
            + New prompt…
          </button>
          {suggestions.length > 0 && (
            <>
              <div className="muted" style={{ ...sidebarLabelStyle, marginTop: 16 }}>
                Suggested
              </div>
              {suggestions.map((sug) => (
                <button
                  key={sug.id}
                  onClick={() => {
                    setPreviewing(sug);
                    setCreating(null);
                    setError(null);
                  }}
                  title={sug.useFor}
                  style={{
                    ...sidebarItemStyle,
                    background: previewing?.id === sug.id ? 'var(--row-hover)' : 'transparent',
                    fontWeight: previewing?.id === sug.id ? 500 : 400,
                  }}
                >
                  <div style={{ overflow: 'hidden', textOverflow: 'ellipsis' }}>{sug.name}</div>
                  <div className="muted" style={sidebarMetaStyle}>
                    {sug.kind === 'update' ? 'Update available' : 'Suggestion'}
                  </div>
                </button>
              ))}
            </>
          )}
        </aside>
        <section style={editorStyle}>
          {previewing ? (
            <>
              <div style={editorHeaderStyle}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{previewing.name}</div>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {previewing.kind === 'update' ? 'update to a type you already have' : 'suggested meeting type'}
                </span>
              </div>
              {previewing.kind === 'update' && (
                <div style={{ fontSize: 12, marginBottom: 8 }}>
                  Applying this replaces the name, description and prompt of your “{previewing.currentName}”, including
                  any edits you made to it. Its past summaries are unchanged.
                </div>
              )}
              <div style={{ fontSize: 12, marginBottom: 8 }}>
                <strong>Use for:</strong> {previewing.useFor}
              </div>
              <textarea value={previewing.prompt} readOnly style={textareaStyle} spellCheck={false} />
              <div className="muted" style={hintStyle}>
                Adding it creates an ordinary meeting type you can edit or delete. The classifiers then
                consider it for new recordings; existing summaries are unchanged.
              </div>
              {error && (
                <div role="alert" style={errorBoxStyle}>
                  {error}
                </div>
              )}
            </>
          ) : creating ? (
            <>
              <div style={editorHeaderStyle}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>New meeting type</div>
              </div>
              <label style={fieldLabelStyle}>Name</label>
              <input
                type="text"
                autoFocus
                value={creating.name}
                onChange={(e) => {
                  setCreating({ ...creating, name: e.target.value });
                  setCreateError(null);
                }}
                style={{ ...inputStyle, marginBottom: 10 }}
                placeholder="e.g. Internal one-to-one"
                disabled={createSaving}
              />
              <label style={fieldLabelStyle}>Prompt</label>
              <textarea
                value={creating.prompt}
                onChange={(e) => {
                  setCreating({ ...creating, prompt: e.target.value });
                  setCreateError(null);
                }}
                style={textareaStyle}
                spellCheck={false}
                placeholder="Paste the system prompt for this meeting type…"
                disabled={createSaving}
              />
              <div className="muted" style={hintStyle}>
                The prompt is what Ollama uses as the system message when this meeting type is
                selected. Tip: copy an existing prompt as a starting point, then edit.
              </div>
              {createError && (
                <div role="alert" style={errorBoxStyle}>
                  {createError}
                </div>
              )}
            </>
          ) : selected ? (
            <>
              <div style={editorHeaderStyle}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{selected.name}</div>
                {selected.is_modified && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>modified from default</span>
                )}
                {selected.retired && <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>retired</span>}
              </div>
              <label style={fieldLabelStyle}>When to use</label>
              <textarea
                value={descDraft}
                onChange={(e) => {
                  setDescDraft(e.target.value);
                  setSavedAt(null);
                }}
                style={{ ...textareaStyle, minHeight: 54, flex: 'none', marginBottom: 6 }}
                placeholder="e.g. Weekly calls with the customer present about progress and commitments (HSBC / Teradata catch-up, AIB weekly sync)"
              />
              <div className="muted" style={{ ...hintStyle, marginTop: 0, marginBottom: 10 }}>
                Automatic matching reads this instead of the prompt. Typical meeting titles help.
              </div>
              <label style={fieldLabelStyle}>Prompt</label>
              <textarea
                value={draft}
                onChange={(e) => {
                  setDraft(e.target.value);
                  setSavedAt(null);
                }}
                style={textareaStyle}
                spellCheck={false}
              />
              <div className="muted" style={hintStyle}>
                In-flight summaries keep the prompt they started with. Changes apply to new summaries
                only.
              </div>
              {error && (
                <div role="alert" style={errorBoxStyle}>
                  {error}
                </div>
              )}
            </>
          ) : (
            <div className="muted" style={{ padding: 24, fontSize: 12 }}>
              No meeting types configured.
            </div>
          )}
        </section>
      </main>
      <footer style={footerStyle}>
        {savedAt && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            Saved.
          </span>
        )}
        {importMessage && !savedAt && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            {importMessage}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {previewing ? (
            <>
              <button onClick={() => void onDismissSuggestion()} disabled={suggestionBusy} title="Hide this suggestion">
                Dismiss
              </button>
              <button className="primary" onClick={() => void onAcceptSuggestion()} disabled={suggestionBusy}>
                {suggestionBusy ? 'Applying…' : previewing.kind === 'update' ? 'Apply update' : 'Add meeting type'}
              </button>
            </>
          ) : creating ? (
            <>
              <button
                onClick={() => {
                  setCreating(null);
                  setCreateError(null);
                }}
                disabled={createSaving}
              >
                Cancel
              </button>
              <button
                className="primary"
                onClick={() => void onCreate()}
                disabled={
                  createSaving || creating.name.trim().length === 0 || creating.prompt.trim().length === 0
                }
              >
                {createSaving ? 'Adding…' : 'Add prompt'}
              </button>
            </>
          ) : (
            <>
              {selected?.is_builtin && selected.is_modified && (
                <button
                  onClick={() => void onRevert()}
                  disabled={saving || importing}
                  title="Reset this prompt to the version shipped in PROMPTS.md"
                >
                  Revert to default
                </button>
              )}
              {selected && (
                <button
                  onClick={() => void onToggleRetired()}
                  disabled={saving || importing}
                  title={
                    selected.retired
                      ? 'Offer this type again in the pickers and automatic matching'
                      : 'Stop offering this type; past recordings keep it'
                  }
                >
                  {selected.retired ? 'Restore' : 'Retire'}
                </button>
              )}
              {selected && !selected.is_builtin && (
                <button
                  onClick={() => void onDelete()}
                  disabled={saving || importing}
                  title="Delete this user-created prompt"
                  style={{ color: 'var(--danger)' }}
                >
                  Delete prompt
                </button>
              )}
              <button
                onClick={() => void onImport()}
                disabled={saving || importing}
                title="Import prompts from a markdown file. Existing prompts (matched by id) are updated; new ids are added as user-created prompts."
              >
                {importing ? 'Importing…' : 'Import…'}
              </button>
              <button onClick={() => window.close()}>Close</button>
              <button
                className="primary"
                onClick={() => void onSave()}
                disabled={saving || importing || !isDirty || !selected}
              >
                {saving ? 'Saving…' : 'Save prompt'}
              </button>
            </>
          )}
        </div>
      </footer>
    </div>
  );
}

// --- Vocabulary ------------------------------------------------------------

interface ReplacementDraft {
  from: string;
  to: string;
  /** Comma-separated in the editor; split on save. */
  requiresContext: string;
}

/**
 * Whisper's initial_prompt is capped, and terms past the cap are ignored
 * silently — there is no error, the transcript is simply no better than it
 * would have been. The count is the merged total across every scope that
 * applies, because that is what actually reaches Whisper.
 */
function WhisperBudgetMeter({ budget }: { budget: VocabularyBudgetDTO }) {
  const remaining = budget.limit - budget.used;
  const over = budget.dropped.length > 0;
  const pct = Math.min(100, Math.round((budget.used / budget.limit) * 100));
  const tight = !over && remaining <= 80;
  const colour = over ? 'var(--danger, #b91c1c)' : tight ? 'var(--warn, #b45309)' : 'var(--accent, #2563eb)';

  return (
    <div
      style={{
        marginBottom: 8,
        padding: '6px 8px',
        border: '1px solid var(--border)',
        borderRadius: 4,
        background: 'var(--bg-subtle, transparent)',
      }}
    >
      <div style={{ display: 'flex', alignItems: 'baseline', gap: 6, fontSize: 11 }}>
        <span style={{ fontWeight: 500 }}>Whisper prompt</span>
        <span style={{ color: colour, fontVariantNumeric: 'tabular-nums' }}>
          {budget.used} / {budget.limit} characters
        </span>
        <span className="muted" style={{ fontVariantNumeric: 'tabular-nums' }}>
          {over ? 'limit reached' : `${remaining} remaining`}
        </span>
        <span className="muted" style={{ marginLeft: 'auto' }}>
          {budget.hintsUsed} of {budget.hintsAvailable} terms in use
        </span>
      </div>
      <div
        role="progressbar"
        aria-valuenow={budget.used}
        aria-valuemin={0}
        aria-valuemax={budget.limit}
        aria-label="Whisper prompt characters used"
        style={{
          marginTop: 4,
          height: 4,
          borderRadius: 2,
          background: 'var(--border)',
          overflow: 'hidden',
        }}
      >
        <div style={{ width: `${pct}%`, height: '100%', background: colour }} />
      </div>
      <div className="muted" style={{ fontSize: 10, marginTop: 4, lineHeight: 1.4 }}>
        {over ? (
          <>
            <strong style={{ color: 'var(--danger, #b91c1c)' }}>
              {budget.dropped.length} term{budget.dropped.length === 1 ? '' : 's'} ignored:
            </strong>{' '}
            {budget.dropped.slice(0, 8).join(', ')}
            {budget.dropped.length > 8 ? `, +${budget.dropped.length - 8} more` : ''}. All scopes
            merge into one prompt; the least specific terms are dropped first.
          </>
        ) : (
          <>
            All scopes merge into one capped prompt. Terms beyond {budget.limit} characters are
            silently ignored by Whisper.
          </>
        )}
      </div>
    </div>
  );
}

export function VocabularyPane(props: {
  initialScopes: VocabularyScopeDTO[];
  onScopeSaved: (updated: VocabularyScopeDTO) => void;
}) {
  const [scopes, setScopes] = useState<VocabularyScopeDTO[]>(props.initialScopes);
  const [selectedId, setSelectedId] = useState<string>(props.initialScopes[0]?.id ?? '');
  const [file, setFile] = useState<VocabularyFileDTO | null>(null);
  const [hints, setHints] = useState<string[]>([]);
  const [replacements, setReplacements] = useState<ReplacementDraft[]>([]);
  const [loadingScope, setLoadingScope] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);
  const [budget, setBudget] = useState<VocabularyBudgetDTO | null>(null);

  const selected = useMemo(() => scopes.find((s) => s.id === selectedId), [scopes, selectedId]);

  // The scopes all merge into one capped prompt, so the number that matters
  // is the merged total — not this scope's own size. Main recomputes it from
  // the unsaved hints using the same code that builds the real prompt.
  useEffect(() => {
    if (!selectedId || loadingScope) return;
    let cancelled = false;
    const timer = setTimeout(() => {
      void window.distill.settings
        .previewVocabularyBudget({ scopeId: selectedId, hints })
        .then((b) => {
          if (!cancelled) setBudget(b);
        })
        .catch(() => {
          if (!cancelled) setBudget(null);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [selectedId, hints, loadingScope]);

  useEffect(() => {
    if (!selectedId) return;
    let cancelled = false;
    setLoadingScope(true);
    setError(null);
    setSavedAt(null);
    void (async () => {
      try {
        const loaded = await window.distill.settings.loadVocabulary(selectedId);
        if (cancelled) return;
        setFile(loaded);
        setHints([...loaded.whisperHints]);
        setReplacements(
          loaded.replacements.map((r) => ({
            from: r.from,
            to: r.to,
            requiresContext: r.requiresContext?.join(', ') ?? '',
          })),
        );
      } catch (e) {
        if (cancelled) return;
        setError(e instanceof Error ? e.message : String(e));
        setFile(null);
        setHints([]);
        setReplacements([]);
      } finally {
        if (!cancelled) setLoadingScope(false);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [selectedId]);

  const markDirty = useCallback(() => setSavedAt(null), []);

  const addHint = useCallback(() => {
    setHints((h) => [...h, '']);
    markDirty();
  }, [markDirty]);

  const updateHint = useCallback(
    (index: number, value: string) => {
      setHints((h) => h.map((x, i) => (i === index ? value : x)));
      markDirty();
    },
    [markDirty],
  );

  const deleteHint = useCallback(
    (index: number) => {
      setHints((h) => h.filter((_, i) => i !== index));
      markDirty();
    },
    [markDirty],
  );

  const addReplacement = useCallback(() => {
    setReplacements((r) => [...r, { from: '', to: '', requiresContext: '' }]);
    markDirty();
  }, [markDirty]);

  const updateReplacement = useCallback(
    (index: number, patch: Partial<ReplacementDraft>) => {
      setReplacements((r) => r.map((x, i) => (i === index ? { ...x, ...patch } : x)));
      markDirty();
    },
    [markDirty],
  );

  const deleteReplacement = useCallback(
    (index: number) => {
      setReplacements((r) => r.filter((_, i) => i !== index));
      markDirty();
    },
    [markDirty],
  );

  const onSave = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setSaving(true);
    try {
      const payload: VocabularyFileDTO = {
        whisperHints: hints,
        replacements: replacements.map((r) => ({
          from: r.from,
          to: r.to,
          requiresContext:
            r.requiresContext.trim().length > 0
              ? r.requiresContext
                  .split(',')
                  .map((s) => s.trim())
                  .filter((s) => s.length > 0)
              : undefined,
        })),
        // Notes are preserved by main from the on-disk file. Not sent
        // from the renderer.
      };
      const updated = await window.distill.settings.saveVocabulary({
        scopeId: selected.id,
        file: payload,
      });
      setScopes((prev) => prev.map((s) => (s.id === updated.id ? updated : s)));
      props.onScopeSaved(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, hints, replacements, props]);

  const onImport = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setImporting(true);
    try {
      const merged = await window.distill.settings.importVocabulary(selected.id);
      if (merged === null) return;
      setFile(merged);
      setHints([...merged.whisperHints]);
      setReplacements(
        merged.replacements.map((r) => ({
          from: r.from,
          to: r.to,
          requiresContext: r.requiresContext?.join(', ') ?? '',
        })),
      );
      const updatedSummary: VocabularyScopeDTO = {
        ...selected,
        termCount: merged.whisperHints.length + merged.replacements.length,
      };
      setScopes((prev) => prev.map((s) => (s.id === updatedSummary.id ? updatedSummary : s)));
      props.onScopeSaved(updatedSummary);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [selected, props]);

  const onExport = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setExportedPath(null);
    setExporting(true);
    try {
      const result = await window.distill.settings.exportVocabulary(selected.id);
      if (result === null) return;
      setExportedPath(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [selected]);

  const builtins = scopes.filter((s) => s.builtin);
  const clientScopes = scopes.filter((s) => !s.builtin);
  const droppedSet = useMemo(
    () => new Set((budget?.dropped ?? []).map((d) => d.toLowerCase())),
    [budget],
  );

  return (
    <div style={paneStyle}>
      <main style={promptsPaneBodyStyle}>
        <aside style={sidebarStyle}>
          <div className="muted" style={sidebarLabelStyle}>
            Built-in packs
          </div>
          {builtins.map((s) => (
            <ScopeSidebarItem
              key={s.id}
              scope={s}
              active={s.id === selectedId}
              onClick={() => setSelectedId(s.id)}
            />
          ))}
          {clientScopes.length > 0 && (
            <>
              <div className="muted" style={{ ...sidebarLabelStyle, marginTop: 12 }}>
                Per-client
              </div>
              {clientScopes.map((s) => (
                <ScopeSidebarItem
                  key={s.id}
                  scope={s}
                  active={s.id === selectedId}
                  onClick={() => setSelectedId(s.id)}
                />
              ))}
            </>
          )}
        </aside>
        <section style={editorStyle}>
          {!selected ? (
            <div className="muted" style={{ padding: 24, fontSize: 12 }}>
              No vocabulary scopes available.
            </div>
          ) : loadingScope ? (
            <div className="muted" style={{ padding: 12, fontSize: 12 }}>
              Loading “{selected.label}”…
            </div>
          ) : (
            <>
              <div style={editorHeaderStyle}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{selected.label}</div>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {selected.builtin ? 'Always applied' : `Client scope · ${selected.label}`}
                </span>
                <button
                  onClick={() => setHelpOpen((v) => !v)}
                  style={{
                    marginLeft: 'auto',
                    fontSize: 11,
                    padding: '2px 8px',
                    background: 'transparent',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    color: 'var(--fg-muted)',
                    cursor: 'pointer',
                  }}
                  title="Show / hide the JSON schema and a worked example for this editor."
                  aria-expanded={helpOpen}
                >
                  {helpOpen ? 'Hide help' : 'Show help'}
                </button>
              </div>
              {helpOpen && <VocabularyHelpPanel />}
              <div style={sectionHeadingStyle}>Whisper hints</div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Terms Whisper should recognise. Written into the initial_prompt at transcription time.
              </div>
              {budget && <WhisperBudgetMeter budget={budget} />}
              <div style={tableStyle}>
                {hints.length === 0 && (
                  <div className="muted" style={{ padding: '4px 2px', fontSize: 11 }}>
                    No hints yet.
                  </div>
                )}
                {hints.map((h, i) => {
                  const overflowed = droppedSet.has(h.trim().toLowerCase());
                  return (
                    <div key={i} style={tableRowStyle}>
                      <input
                        type="text"
                        value={h}
                        onChange={(e) => updateHint(i, e.target.value)}
                        style={{
                          ...inputStyle,
                          flex: 1,
                          ...(overflowed ? { borderColor: 'var(--warn, #b45309)' } : null),
                        }}
                        placeholder="e.g. Acme Corp"
                      />
                      {overflowed && (
                        <span
                          style={{ fontSize: 10, color: 'var(--warn, #b45309)', whiteSpace: 'nowrap' }}
                          title="Past the 800-character limit — this term is not sent to Whisper at all."
                        >
                          over limit
                        </span>
                      )}
                      <button
                        onClick={() => deleteHint(i)}
                        style={deleteButtonStyle}
                        title="Remove this hint"
                        aria-label="Remove hint"
                      >
                        ✕
                      </button>
                    </div>
                  );
                })}
                <button onClick={addHint} style={addButtonStyle}>
                  + Add hint
                </button>
              </div>
              <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>Replacement rules</div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Post-transcription rewrites. Context words (comma-separated) are optional — when set,
                the rule only fires if one of those words appears elsewhere in the transcript.
              </div>
              <div style={tableStyle}>
                {replacements.length === 0 && (
                  <div className="muted" style={{ padding: '4px 2px', fontSize: 11 }}>
                    No replacement rules yet.
                  </div>
                )}
                {replacements.length > 0 && (
                  <div style={replacementHeaderStyle}>
                    <span style={{ flex: 2 }}>From</span>
                    <span style={{ flex: 2 }}>To</span>
                    <span style={{ flex: 3 }}>Context (csv, optional)</span>
                    <span style={{ width: 28 }} />
                  </div>
                )}
                {replacements.map((r, i) => (
                  <div key={i} style={tableRowStyle}>
                    <input
                      type="text"
                      value={r.from}
                      onChange={(e) => updateReplacement(i, { from: e.target.value })}
                      style={{ ...inputStyle, flex: 2 }}
                      placeholder="akmee"
                    />
                    <input
                      type="text"
                      value={r.to}
                      onChange={(e) => updateReplacement(i, { to: e.target.value })}
                      style={{ ...inputStyle, flex: 2 }}
                      placeholder="Acme"
                    />
                    <input
                      type="text"
                      value={r.requiresContext}
                      onChange={(e) => updateReplacement(i, { requiresContext: e.target.value })}
                      style={{ ...inputStyle, flex: 3 }}
                      placeholder="marketing, campaign"
                    />
                    <button
                      onClick={() => deleteReplacement(i)}
                      style={deleteButtonStyle}
                      title="Remove this rule"
                      aria-label="Remove replacement"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button onClick={addReplacement} style={addButtonStyle}>
                  + Add rule
                </button>
              </div>
              {file?.notes && file.notes.length > 0 && (
                <>
                  <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>Notes</div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                    Preserved from the JSON file on disk. Edit the file directly to change these.
                  </div>
                  <ul style={notesListStyle}>
                    {file.notes.map((n, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>
                        {n}
                      </li>
                    ))}
                  </ul>
                </>
              )}
              {error && (
                <div role="alert" style={errorBoxStyle}>
                  {error}
                </div>
              )}
            </>
          )}
        </section>
      </main>
      <footer style={footerStyle}>
        {savedAt && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            Saved.
          </span>
        )}
        {exportedPath && !savedAt && (
          <span
            className="muted"
            style={{
              fontSize: 11,
              overflow: 'hidden',
              textOverflow: 'ellipsis',
              whiteSpace: 'nowrap',
              maxWidth: 360,
            }}
            aria-live="polite"
            title={exportedPath}
          >
            Exported to {exportedPath}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button
            onClick={() => void onImport()}
            disabled={importing || saving || exporting || loadingScope || !selected}
            title="Import a vocabulary file (JSON or markdown table) and merge it into this scope. Existing entries are kept; conflicts (same `from` value) are overwritten by the imported version."
          >
            {importing ? 'Importing…' : 'Import…'}
          </button>
          <button
            onClick={() => void onExport()}
            disabled={exporting || saving || importing || loadingScope || !selected}
            title="Export this scope's saved contents to a JSON file. Uses the on-disk file, NOT any unsaved edits in the editor."
          >
            {exporting ? 'Exporting…' : 'Export…'}
          </button>
          <button onClick={() => window.close()}>Close</button>
          <button
            className="primary"
            onClick={() => void onSave()}
            disabled={saving || importing || exporting || loadingScope || !selected}
          >
            {saving ? 'Saving…' : 'Save scope'}
          </button>
        </div>
      </footer>
    </div>
  );
}

function ScopeSidebarItem(props: { scope: VocabularyScopeDTO; active: boolean; onClick: () => void }) {
  return (
    <button
      onClick={props.onClick}
      style={{
        ...sidebarItemStyle,
        background: props.active ? 'var(--row-hover)' : 'transparent',
        fontWeight: props.active ? 500 : 400,
      }}
    >
      <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
        <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
          {props.scope.label}
        </span>
        <span style={termCountBadgeStyle}>{props.scope.termCount}</span>
      </div>
    </button>
  );
}

function VocabularyHelpPanel() {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 6,
        padding: 12,
        marginBottom: 14,
        fontSize: 11,
        lineHeight: 1.5,
        background: 'var(--row-hover)',
      }}
    >
      <div style={{ marginBottom: 8 }}>
        <strong>Whisper hints</strong> bias the transcriber toward recognising specific terms. Use the
        spelling and capitalisation you want in the transcript. Examples: <code>Acme Corp</code>,{' '}
        <code>Falcon</code>, <code>QBR</code>, <code>Karen Velasquez</code>.
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong>Replacement rules</strong> rewrite likely mistranscriptions after Whisper finishes.
        Each rule has a <code>from</code> (what Whisper outputs incorrectly) and a <code>to</code>{' '}
        (what we want it to be). Matched case-insensitively at word boundaries.
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong>Context (optional)</strong> gates a replacement rule on other words appearing in the
        transcript. Use for homophones: e.g. <code>sim</code> → <code>CIM</code> only fires when{' '}
        <code>marketing</code> or <code>campaign</code> is also in the transcript, so phone-sim
        mentions stay untouched.
      </div>
      <div style={{ ...sectionHeadingStyle, marginTop: 12 }}>JSON schema</div>
      <pre style={helpCodeStyle}>{`{
  "$description": "Optional human-readable description.",
  "$version": 1,
  "whisperHints": ["Acme Corp", "Falcon", "QBR"],
  "replacements": [
    { "from": "acmee", "to": "Acme" },
    { "from": "sim", "to": "CIM", "requiresContext": ["marketing", "campaign"] }
  ],
  "notes": ["Optional free-text notes for humans."]
}`}</pre>
      <div style={{ ...sectionHeadingStyle, marginTop: 12 }}>Worked example</div>
      <div style={{ marginBottom: 6 }}>
        Imagine you work at Acme Corp on the Falcon database. Whisper regularly mishears{' '}
        <code>Acme</code> as <code>acne</code> and <code>Falcon</code> as <code>fall come</code>.
      </div>
      <pre style={helpCodeStyle}>{`{
  "$description": "Vocabulary for Acme Corp meetings.",
  "$version": 1,
  "whisperHints": [
    "Acme Corp", "Falcon", "Phoenix", "Karen Velasquez", "QBR"
  ],
  "replacements": [
    { "from": "acne", "to": "Acme" },
    { "from": "fall come", "to": "Falcon" },
    { "from": "sim", "to": "CIM", "requiresContext": ["customer", "marketing"] }
  ],
  "notes": [
    "CIM is a homophone of sim card; the requiresContext on the sim rule prevents it firing when the speaker means a literal SIM."
  ]
}`}</pre>
      <div style={{ marginTop: 10 }}>
        Save this JSON to a file and use the <strong>Import…</strong> button below to merge it into
        this scope. Existing entries are kept; conflicts (same <code>from</code> value) are
        overwritten by the imported version.
      </div>
      <div style={{ marginTop: 6 }}>
        Tip: if generating these by hand is tedious, paste your domain notes into ChatGPT / Claude
        with the prompt in <code>VOCABULARY_GENERATION_PROMPT.md</code> (bundled in the app's
        resources directory) and ask it to produce a JSON file in this shape.
      </div>
      <div style={{ ...sectionHeadingStyle, marginTop: 12 }}>Markdown table format</div>
      <div style={{ marginBottom: 6 }}>
        Replacement rules can also be imported from a markdown file containing one or more GFM tables
        with the columns <strong>Heard as</strong>, <strong>Should be</strong>, and (optionally){' '}
        <strong>Context cue</strong>. Other tables in the same file (acronym glossaries, narrative
        tables) are skipped. Hints and notes don't come through this format — import a JSON file for
        those.
      </div>
      <pre style={helpCodeStyle}>{`# My team's vocabulary

| Heard as | Should be | Context cue |
|---|---|---|
| akmee | Acme | |
| fall come | Falcon | |
| sim | CIM | marketing, campaign |
`}</pre>
    </section>
  );
}

// --- General ---------------------------------------------------------------

export function GeneralPane(props: { initial: GeneralDTO; onSaved: (next: GeneralDTO) => void }) {
  const initialEnabled = props.initial.audioRetentionDays !== null;
  const initialDays = props.initial.audioRetentionDays ?? 14;
  const [enabled, setEnabled] = useState(initialEnabled);
  const [daysText, setDaysText] = useState(String(initialDays));
  const [dismissText, setDismissText] = useState(String(props.initial.autoDismissCompleteMinutes));
  const [launchAtLogin, setLaunchAtLogin] = useState(props.initial.launchAtLogin);
  const [schedule, setSchedule] = useState<ProcessingSchedule>(props.initial.processingSchedule);
  const [autoFile, setAutoFile] = useState(props.initial.autoFileHighConfidence);
  const [minText, setMinText] = useState(String(props.initial.minRecordingMinutes));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Whole minutes, 0–120; anything else leaves Save disabled, like the other fields.
  const minMinutes = /^\d+$/.test(minText.trim()) && Number(minText) <= 120 ? Number(minText) : NaN;

  const computed = useMemo<GeneralDTO | null>(() => {
    if (Number.isNaN(minMinutes)) return null;
    const base = {
      launchAtLogin,
      launchAtLoginAvailable: props.initial.launchAtLoginAvailable,
      processingSchedule: schedule,
      autoFileHighConfidence: autoFile,
      minRecordingMinutes: minMinutes,
    };
    const dismissTrimmed = dismissText.trim();
    const dismissParsed = Number(dismissTrimmed);
    if (
      dismissTrimmed.length === 0 ||
      !Number.isFinite(dismissParsed) ||
      !Number.isInteger(dismissParsed) ||
      dismissParsed < 0
    ) {
      return null;
    }
    if (!enabled) return { ...base, audioRetentionDays: null, autoDismissCompleteMinutes: dismissParsed };
    const trimmed = daysText.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return null;
    }
    return { ...base, audioRetentionDays: parsed, autoDismissCompleteMinutes: dismissParsed };
  }, [enabled, daysText, dismissText, launchAtLogin, schedule, autoFile, minMinutes, props.initial.launchAtLoginAvailable]);

  const isDirty = useMemo(() => {
    if (!computed) return false;
    return (
      computed.audioRetentionDays !== props.initial.audioRetentionDays ||
      computed.autoDismissCompleteMinutes !== props.initial.autoDismissCompleteMinutes ||
      computed.launchAtLogin !== props.initial.launchAtLogin ||
      computed.processingSchedule.mode !== props.initial.processingSchedule.mode ||
      computed.processingSchedule.idleMinutes !== props.initial.processingSchedule.idleMinutes ||
      computed.processingSchedule.overnightStart !== props.initial.processingSchedule.overnightStart ||
      computed.processingSchedule.overnightEnd !== props.initial.processingSchedule.overnightEnd ||
      computed.autoFileHighConfidence !== props.initial.autoFileHighConfidence ||
      computed.minRecordingMinutes !== props.initial.minRecordingMinutes
    );
  }, [
    computed,
    props.initial.audioRetentionDays,
    props.initial.autoDismissCompleteMinutes,
    props.initial.launchAtLogin,
    props.initial.processingSchedule,
  ]);

  const onSave = useCallback(async () => {
    if (!computed) return;
    setError(null);
    setSaving(true);
    try {
      // Trust the returned state over the form: macOS is the authority on
      // the login item and may not have applied what was asked.
      const applied = await window.distill.settings.saveGeneral(computed);
      setLaunchAtLogin(applied.launchAtLogin);
      props.onSaved(applied);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      // A rejected save means the login item did not change, so put the
      // checkbox back rather than leaving it showing a state macOS refused.
      setLaunchAtLogin(props.initial.launchAtLogin);
    } finally {
      setSaving(false);
    }
  }, [computed, props]);

  return (
    <div style={paneStyle}>
      <main style={paneBodyStyle}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          App-level settings that aren't tied to a specific output destination, prompt, or vocabulary
          scope.
        </p>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Startup</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            distill lives in the menu bar and polls for new recordings in the background, so it only
            does its job while it is running.
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              cursor: props.initial.launchAtLoginAvailable ? 'pointer' : 'default',
              opacity: props.initial.launchAtLoginAvailable ? 1 : 0.55,
            }}
          >
            <input
              type="checkbox"
              checked={launchAtLogin}
              disabled={!props.initial.launchAtLoginAvailable}
              onChange={(e) => setLaunchAtLogin(e.target.checked)}
            />
            Start distill when I log in
          </label>
          <div className="muted" style={{ fontSize: 10, marginTop: 6, lineHeight: 1.4 }}>
            {props.initial.launchAtLoginAvailable ? (
              <>
                macOS owns this setting — it also appears under System Settings › General › Login
                Items, and turning it off there turns it off here.
              </>
            ) : (
              <>
                Unavailable in a development build: the login item would point at the Electron binary
                rather than at distill. Works in an installed copy.
              </>
            )}
          </div>
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Recent list</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            A completed recording moves to Inbox's "Recent" section, then automatically drops to
            Hidden once it's been there this long — the outputs aren't touched, only the row's
            visibility. Use 0 to turn off auto-hiding.
          </div>
          <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
            <input
              type="number"
              min={0}
              step={1}
              value={dismissText}
              onChange={(e) => {
                setDismissText(e.target.value);
                setSavedAt(null);
              }}
              style={{ ...inputStyle, width: 80 }}
            />
            <span style={{ fontSize: 12 }}>minutes after a summary completes</span>
          </div>
          <div className="muted" style={{ ...hintStyle, marginTop: 10 }}>
            {dismissText.trim() === '0'
              ? 'Auto-hide is off — completed recordings stay in Recent until you hide them yourself.'
              : `Recordings move to Hidden ${dismissText || 'N'} minute(s) after completing. Find them again from the Hidden section, or in History.`}
          </div>
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Audio retention</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            Imported audio (Teams recordings, voice memos, anything dragged in) is kept on disk after
            a summary lands. This setting controls how long. Plaud-sourced recordings are never
            auto-deleted — they can be re-fetched from the Plaud cloud, so deleting locally is cheap.
            Local imports are unique on disk, so the default is conservative.
          </div>
          <label
            style={{
              display: 'flex',
              alignItems: 'center',
              gap: 8,
              fontSize: 12,
              cursor: 'pointer',
              marginBottom: 8,
            }}
          >
            <input
              type="checkbox"
              checked={enabled}
              onChange={(e) => {
                setEnabled(e.target.checked);
                setSavedAt(null);
              }}
            />
            <span>Auto-delete imported audio after a set period</span>
          </label>
          {enabled && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8, marginLeft: 24 }}>
              <input
                type="number"
                min={0}
                step={1}
                value={daysText}
                onChange={(e) => {
                  setDaysText(e.target.value);
                  setSavedAt(null);
                }}
                style={{ ...inputStyle, width: 80 }}
              />
              <span style={{ fontSize: 12 }}>days after the summary is written</span>
            </div>
          )}
          <div className="muted" style={{ ...hintStyle, marginTop: 10, marginLeft: enabled ? 24 : 0 }}>
            {enabled
              ? daysText.trim() === '0'
                ? 'Audio is deleted as soon as the row reaches “complete”.'
                : `Audio is deleted ${daysText || 'N'} day(s) after the most recent successful output write.`
              : 'Audio is kept indefinitely. You can sweep manually by deleting files in ~/Library/Application Support/distill/audio/.'}
          </div>
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Short recordings</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12, marginBottom: 4 }}>
            Skip recordings shorter than
            <input
              type="number"
              min={0}
              max={120}
              step={1}
              value={minText}
              onChange={(e) => setMinText(e.target.value)}
              style={{ width: 56 }}
            />
            minutes
          </label>
          <div className="muted" style={{ fontSize: 11, marginBottom: 14 }}>
            New Plaud recordings shorter than this go to Hidden instead of the inbox, and Queue all hides them rather
            than processing them. 0 keeps everything. Files you drag in are never skipped; bring a recording back from
            Hidden if you need it.
          </div>
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Automatic filing</div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'flex-start', fontSize: 12 }}>
            <input type="checkbox" checked={autoFile} onChange={(e) => setAutoFile(e.target.checked)} />
            <span>
              File "Queue all" recordings without waiting in Ready to file when the match is high-confidence.
              <span className="muted" style={{ display: 'block', fontSize: 11, marginTop: 4 }}>
                Only when the classifier is highly confident, names a client, the calendar (if it names an account)
                agrees, and the meeting type is still in use. Everything else still waits for you. Rows filed this way
                say "Filed automatically".
              </span>
            </span>
          </label>
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Processing schedule</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            When tagging a recording starts it. This only delays the next recording claimed — anything
            already running finishes normally. Mark a specific recording "Urgent" (from the tag sheet or
            its Inbox row) to have it start immediately regardless of this setting.
          </div>
          <select
            value={schedule.mode}
            onChange={(e) => {
              setSchedule({ ...schedule, mode: e.target.value as ProcessingSchedule['mode'] });
              setSavedAt(null);
            }}
            style={{ ...inputStyle, width: '100%', marginBottom: schedule.mode === 'immediate' ? 0 : 10 }}
          >
            <option value="immediate">Process as soon as tagged</option>
            <option value="idle">Only when the Mac has been idle</option>
            <option value="overnight">Only during an overnight window</option>
          </select>
          {schedule.mode === 'idle' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="number"
                min={1}
                step={1}
                value={schedule.idleMinutes}
                onChange={(e) => {
                  const n = Number(e.target.value);
                  setSchedule({ ...schedule, idleMinutes: Number.isFinite(n) && n > 0 ? Math.floor(n) : schedule.idleMinutes });
                  setSavedAt(null);
                }}
                style={{ ...inputStyle, width: 80 }}
              />
              <span style={{ fontSize: 12 }}>minutes of no keyboard/mouse activity</span>
            </div>
          )}
          {schedule.mode === 'overnight' && (
            <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
              <input
                type="time"
                value={schedule.overnightStart}
                onChange={(e) => {
                  setSchedule({ ...schedule, overnightStart: e.target.value });
                  setSavedAt(null);
                }}
                style={inputStyle}
              />
              <span style={{ fontSize: 12 }}>to</span>
              <input
                type="time"
                value={schedule.overnightEnd}
                onChange={(e) => {
                  setSchedule({ ...schedule, overnightEnd: e.target.value });
                  setSavedAt(null);
                }}
                style={inputStyle}
              />
              <span style={{ fontSize: 12 }}>local time, can cross midnight</span>
            </div>
          )}
        </section>
        {error && (
          <div role="alert" style={errorBoxStyle}>
            {error}
          </div>
        )}
      </main>
      <footer style={footerStyle}>
        {savedAt && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            Saved.
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => window.close()}>Close</button>
          <button className="primary" onClick={() => void onSave()} disabled={saving || !isDirty || !computed}>
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

// --- Performance -----------------------------------------------------------

export function PerformancePane(props: {
  initial: PerformanceDTO;
  onSaved: (next: PerformanceDTO) => void;
  suggestion?: ModelSuggestionDTO | null;
}) {
  const [draft, setDraft] = useState<PerformanceDTO>(props.initial);
  const [models, setModels] = useState<{ name: string; sizeBytes?: number }[] | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [installingParakeet, setInstallingParakeet] = useState(false);
  const [parakeetInstallLog, setParakeetInstallLog] = useState<string[]>([]);
  const [parakeetInstallError, setParakeetInstallError] = useState<string | null>(null);

  useEffect(() => {
    return window.distill.onParakeetInstallProgress((p) => {
      if (p.log) {
        setParakeetInstallLog((prev) => [...prev.slice(-199), p.log!.text]);
      }
    });
  }, []);

  const onInstallParakeet = useCallback(async () => {
    setInstallingParakeet(true);
    setParakeetInstallError(null);
    setParakeetInstallLog([]);
    try {
      const result = await window.distill.settings.installParakeet();
      if (result.ok) {
        setDraft((prev) => ({ ...prev, parakeetInstalled: true }));
      } else {
        setParakeetInstallError(result.error);
      }
    } catch (e) {
      setParakeetInstallError(e instanceof Error ? e.message : String(e));
    } finally {
      setInstallingParakeet(false);
    }
  }, []);

  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    setOllamaError(null);
    try {
      const result = await window.distill.settings.listOllamaModels();
      if (result.ok) {
        setModels(result.models);
      } else {
        setModels(null);
        setOllamaError(`Ollama is unreachable: ${result.detail}`);
      }
    } catch (e) {
      setModels(null);
      setOllamaError(e instanceof Error ? e.message : String(e));
    } finally {
      setLoadingModels(false);
    }
  }, []);

  useEffect(() => {
    void refreshModels();
  }, [refreshModels]);

  const isDirty =
    draft.ollamaModel !== props.initial.ollamaModel ||
    draft.ollamaKeepAlive !== props.initial.ollamaKeepAlive ||
    draft.adaptiveContextWindow !== props.initial.adaptiveContextWindow ||
    draft.whisperModel !== props.initial.whisperModel ||
    draft.transcriptionEngine !== props.initial.transcriptionEngine;
  const ollamaUnreachable = ollamaError !== null;
  const parakeetNotReady = draft.transcriptionEngine === 'parakeet' && !draft.parakeetInstalled;
  const canSave = !saving && isDirty && !ollamaUnreachable && !parakeetNotReady;

  const onSave = useCallback(async () => {
    setError(null);
    setSaving(true);
    try {
      await window.distill.settings.savePerformance(draft);
      props.onSaved(draft);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [draft, props]);

  return (
    <div style={paneStyle}>
      <main style={paneBodyStyle}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          Pipeline model choices. In-flight steps keep the values they started with; changes here
          apply to subsequent runs.
        </p>
        {props.suggestion && (
          <ModelSuggestionBanner
            suggestion={props.suggestion}
            onPulled={() => void refreshModels()}
          />
        )}
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div
            style={{
              display: 'flex',
              alignItems: 'baseline',
              justifyContent: 'space-between',
              gap: 8,
              marginBottom: 4,
            }}
          >
            <div style={{ fontWeight: 500, fontSize: 13 }}>Ollama model</div>
            <button
              onClick={() => void refreshModels()}
              disabled={loadingModels}
              style={{ fontSize: 11 }}
              title="Re-fetch the list from Ollama"
            >
              {loadingModels ? 'Refreshing…' : 'Refresh'}
            </button>
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            Pulled live from your local Ollama (<code>/api/tags</code>). Pull new models from a
            terminal with <code>ollama pull &lt;name&gt;</code>; they appear here after Refresh.
          </div>
          {ollamaUnreachable ? (
            <div role="alert" style={{ ...errorBoxStyle, marginTop: 0, marginBottom: 6 }}>
              {ollamaError}
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                Start Ollama and click Refresh. The current saved model is still in effect:{' '}
                <strong>{props.initial.ollamaModel}</strong>.
              </div>
            </div>
          ) : models === null ? (
            <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>
              Loading…
            </div>
          ) : models.length === 0 ? (
            <div style={{ ...errorBoxStyle, marginTop: 0, marginBottom: 6 }}>
              Ollama is running but no models are pulled. From a terminal:
              <code style={{ display: 'block', marginTop: 6 }}>ollama pull qwen2.5:32b</code>
            </div>
          ) : (
            <select
              value={draft.ollamaModel}
              onChange={(e) => {
                setDraft({ ...draft, ollamaModel: e.target.value });
                setSavedAt(null);
              }}
              style={{ ...inputStyle, width: '100%' }}
            >
              {!models.some((m) => modelMatches(m.name, draft.ollamaModel)) && (
                <option value={draft.ollamaModel}>{draft.ollamaModel} — not installed locally</option>
              )}
              {models.map((m) => (
                <option key={m.name} value={m.name}>
                  {m.name} — {formatBytes(m.sizeBytes)}
                </option>
              ))}
            </select>
          )}
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Ollama keep-alive</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            How long Ollama keeps the model loaded after a summary finishes. Lower values free unified
            memory sooner; higher values let back-to-back summaries skip the load cost.
          </div>
          <select
            value={draft.ollamaKeepAlive}
            onChange={(e) => {
              setDraft({ ...draft, ollamaKeepAlive: e.target.value });
              setSavedAt(null);
            }}
            style={{ ...inputStyle, width: '100%' }}
          >
            {KEEPALIVE_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Adaptive context sizing</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            Sizes each summary's context window to that meeting's actual length instead of always
            allocating the full configured ceiling — a short meeting uses less memory, a long one still
            gets up to the same limit. Turn off to always request the full configured context window,
            for one predictable number instead of a variable one.
          </div>
          <label style={{ display: 'flex', gap: 8, alignItems: 'center', fontSize: 12 }}>
            <input
              type="checkbox"
              checked={draft.adaptiveContextWindow}
              onChange={(e) => {
                setDraft({ ...draft, adaptiveContextWindow: e.target.checked });
                setSavedAt(null);
              }}
            />
            Size context to each meeting
          </label>
        </section>
        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Transcription engine</div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            What actually turns audio into text.
          </div>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, marginBottom: 6 }}>
            <input
              type="radio"
              name="transcriptionEngine"
              checked={draft.transcriptionEngine === 'whisper'}
              onChange={() => {
                setDraft({ ...draft, transcriptionEngine: 'whisper' });
                setSavedAt(null);
              }}
            />
            Whisper (MLX)
          </label>
          <label style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 12 }}>
            <input
              type="radio"
              name="transcriptionEngine"
              checked={draft.transcriptionEngine === 'parakeet'}
              onChange={() => {
                setDraft({ ...draft, transcriptionEngine: 'parakeet' });
                setSavedAt(null);
              }}
            />
            Parakeet (MLX) — experimental
          </label>
          {draft.transcriptionEngine === 'parakeet' && (
            <>
              <div style={warningBoxStyle}>
                Parakeet is experimental. It does not support vocabulary-based name biasing — your
                Vocabulary hints and pasted meeting attendees will not influence transcription.
                Find-and-replace rules still apply afterward. This will improve if NVIDIA's upstream
                word-boosting work for Parakeet lands in the MLX port.
              </div>
              {!draft.parakeetInstalled ? (
                <div style={{ marginTop: 10 }}>
                  <button onClick={() => void onInstallParakeet()} disabled={installingParakeet}>
                    {installingParakeet ? 'Installing…' : 'Install Parakeet MLX'}
                  </button>
                  {parakeetInstallError && (
                    <div style={{ color: 'var(--danger)', fontSize: 11, marginTop: 6 }}>
                      {parakeetInstallError}
                    </div>
                  )}
                  {parakeetInstallLog.length > 0 && (
                    <pre
                      style={{
                        marginTop: 6,
                        maxHeight: 100,
                        overflowY: 'auto',
                        fontSize: 10,
                        padding: 8,
                        background: 'var(--row-hover)',
                        borderRadius: 4,
                      }}
                    >
                      {parakeetInstallLog.join('\n')}
                    </pre>
                  )}
                </div>
              ) : (
                <div className="muted" style={{ ...hintStyle, marginTop: 10 }}>
                  Parakeet MLX is installed ({draft.parakeetModel}).
                </div>
              )}
            </>
          )}
        </section>
        {draft.transcriptionEngine === 'whisper' && (
          <section
            style={{
              border: '1px solid var(--border)',
              borderRadius: 8,
              padding: 12,
              marginBottom: 12,
            }}
          >
            <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>Whisper model</div>
            <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
              Larger models give better transcription, especially on names and technical terms, but use
              more RAM and CPU. The vocabulary system compensates somewhat for smaller models.
            </div>
            <select
              value={draft.whisperModel}
              onChange={(e) => {
                setDraft({ ...draft, whisperModel: e.target.value });
                setSavedAt(null);
              }}
              style={{ ...inputStyle, width: '100%' }}
            >
              {!WHISPER_MODEL_PRESETS.some((p) => p.value === draft.whisperModel) && (
                <option value={draft.whisperModel}>{draft.whisperModel} — custom</option>
              )}
              {WHISPER_MODEL_PRESETS.map((p) => (
                <option key={p.value} value={p.value}>
                  {p.label}
                </option>
              ))}
            </select>
            {!WHISPER_MODEL_PRESETS.some((p) => p.value === draft.whisperModel) && (
              <div className="muted" style={{ ...hintStyle, marginTop: 6 }}>
                Your config currently points at a custom Whisper model. Saving will switch to the picked
                preset.
              </div>
            )}
          </section>
        )}
        {error && (
          <div role="alert" style={errorBoxStyle}>
            {error}
          </div>
        )}
      </main>
      <footer style={footerStyle}>
        {savedAt && (
          <span className="muted" style={{ fontSize: 11 }} aria-live="polite">
            Saved.
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          <button onClick={() => window.close()}>Close</button>
          <button
            className="primary"
            onClick={() => void onSave()}
            disabled={!canSave}
            title={
              ollamaUnreachable
                ? 'Ollama is unreachable — start Ollama and refresh before saving'
                : parakeetNotReady
                  ? 'Install Parakeet MLX before switching to it'
                  : undefined
            }
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

/**
 * Banner shown when the weekly background check found a newer generation
 * of the configured model family. Download happens only on explicit
 * click, streaming progress from Ollama; after a successful pull the
 * model list refreshes so the user can select it and Save.
 */
function ModelSuggestionBanner(props: { suggestion: ModelSuggestionDTO; onPulled: () => void }) {
  const s = props.suggestion;
  const [dismissed, setDismissed] = useState(false);
  const [pulling, setPulling] = useState(false);
  const [pullStatus, setPullStatus] = useState<string | null>(null);
  const [pullPercent, setPullPercent] = useState<number | null>(null);
  const [pullError, setPullError] = useState<string | null>(null);
  const [pulledOk, setPulledOk] = useState(false);

  useEffect(() => {
    return window.distill.onModelPullProgress((p) => {
      if (p.model !== s.suggestedModel) return;
      setPullStatus(p.status);
      setPullPercent(p.percent);
    });
  }, [s.suggestedModel]);

  const onDismiss = useCallback(() => {
    setDismissed(true);
    void window.distill.settings.dismissModelSuggestion();
  }, []);

  const onDownload = useCallback(async () => {
    setPulling(true);
    setPullError(null);
    setPullStatus('starting…');
    try {
      const result = await window.distill.settings.pullModel(s.suggestedModel);
      if (result.ok) {
        setPulledOk(true);
        props.onPulled();
      } else {
        setPullError(result.error);
      }
    } catch (e) {
      setPullError(e instanceof Error ? e.message : String(e));
    } finally {
      setPulling(false);
    }
  }, [s.suggestedModel, props]);

  if (dismissed) return null;

  return (
    <section style={{ ...infoBoxStyle, marginTop: 0, marginBottom: 12 }} role="status">
      <div style={{ fontWeight: 500, marginBottom: 4 }}>
        {s.newFamily} is available — a newer generation of your summarisation model
      </div>
      <div className="muted" style={{ fontSize: 11, marginBottom: 8 }}>
        You're on <code>{s.currentModel}</code>. <code>{s.suggestedModel}</code> keeps the same size
        tier on this Mac. Downloading doesn't switch anything — after the pull finishes, pick it in
        the list below and Save. Your current model stays installed for easy rollback.
      </div>
      {pulledOk ? (
        <div style={{ fontSize: 12 }}>
          Downloaded. Select <strong>{s.suggestedModel}</strong> in the model list below and press
          Save to switch.
        </div>
      ) : pulling ? (
        <div style={{ display: 'flex', alignItems: 'center', gap: 8, fontSize: 11 }}>
          <span className="muted" style={{ minWidth: 140 }}>
            {pullStatus ?? 'Downloading…'}
            {pullPercent !== null ? ` ${pullPercent}%` : ''}
          </span>
          <div
            style={{
              flex: 1,
              height: 4,
              borderRadius: 2,
              overflow: 'hidden',
              background: 'var(--border)',
            }}
          >
            <div
              style={{
                width: pullPercent === null ? '100%' : `${pullPercent}%`,
                height: '100%',
                background: 'var(--accent)',
                opacity: pullPercent === null ? 0.6 : 1,
                transition: 'width 300ms linear',
              }}
            />
          </div>
        </div>
      ) : (
        <div style={{ display: 'flex', gap: 8 }}>
          <button className="primary" onClick={() => void onDownload()} style={{ fontSize: 12 }}>
            Download {s.suggestedModel}
          </button>
          <button onClick={onDismiss} style={{ fontSize: 12 }} title="Hide this suggestion for this model generation">
            Not now
          </button>
        </div>
      )}
      {pullError && (
        <div role="alert" style={{ ...errorBoxStyle, marginTop: 8 }}>
          {pullError}
        </div>
      )}
    </section>
  );
}

// --- About -----------------------------------------------------------------

export function AboutPane(props: { system?: SystemInfoDTO }) {
  return (
    <div style={paneStyle}>
      <main style={{ ...paneBodyStyle, maxWidth: 720 }}>
        <h2 style={aboutHeadingStyle}>distill</h2>
        <p className="muted" style={aboutLeadStyle}>
          A local-first meeting summariser. Pulls recordings from a Plaud device (or files you drag
          in), transcribes them on your Mac, summarises them with a local language model, and writes
          the result to Markdown / HTML / Apple Notes — all without sending your audio or transcripts
          to a third-party AI service.
        </p>
        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>How it works</h3>
          <ol style={aboutOrderedListStyle}>
            <li>
              <strong>Sync.</strong> Polls the Plaud cloud for new recordings, or accepts files you
              drop into the inbox (audio or video, ffmpeg extracts the audio track).
            </li>
            <li>
              <strong>Transcribe.</strong> Runs MLX Whisper locally on the audio. Your vocabulary
              packs (per-client and global) are baked into the prompt so technical terms come through
              correctly, and post-pass replacements fix known mistranscriptions.
            </li>
            <li>
              <strong>Summarise.</strong> Sends the transcript to your local Ollama instance with the
              meeting-type prompt of your choice. The summary stays on your machine.
            </li>
            <li>
              <strong>Write.</strong> Saves the summary (and optionally the transcript) to whichever
              destinations you have enabled. Idempotent per destination, so a retry only re-runs the
              parts that didn't land.
            </li>
          </ol>
        </section>
        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>Where your data goes</h3>
          <ul style={aboutUnorderedListStyle}>
            <li>
              <strong>Plaud cloud</strong> — distill talks to it to list and download your own
              recordings. Uses the credentials you sign in with under Sources. Your password is stored
              in macOS Keychain.
            </li>
            <li>
              <strong>Ollama</strong> — runs locally on your machine, by default at{' '}
              <code>localhost:11434</code>. Transcripts are sent to it for summarisation. Nothing
              leaves your Mac.
            </li>
            <li>
              <strong>Hugging Face</strong> — contacted once per Whisper model to download model
              weights the first time you use them. Subsequent transcriptions run entirely offline.
            </li>
            <li>
              <strong>Output destinations</strong> — Markdown / HTML files land in folders you
              configure (typically iCloud Drive or a local Documents subfolder); Apple Notes writes to
              your local Notes app. distill never uploads outputs anywhere on its own.
            </li>
          </ul>
        </section>
        {props.system && (
          <section style={aboutSectionStyle}>
            <h3 style={aboutSubheadingStyle}>Choosing a local model</h3>
            <p className="muted" style={{ ...aboutSmallTextStyle, marginBottom: 8 }}>
              The summarisation model shares this Mac's unified memory with macOS and the
              transcriber, so the right choice depends on RAM. This Mac has{' '}
              <strong>{props.system.totalRamGb}GB</strong> — recommended:{' '}
              <code>{props.system.recommendedModel}</code>. {props.system.recommendedReason}
            </p>
            <ul style={aboutUnorderedListStyle}>
              {props.system.recommendationTable.map((row) => (
                <li key={row.ram}>
                  <strong>{row.ram}</strong> — <code>{row.model}</code>
                </li>
              ))}
            </ul>
            <p className="muted" style={{ ...aboutSmallTextStyle, marginTop: 8 }}>
              distill checks weekly for a newer generation of your model family and suggests it in
              Settings → Performance. Nothing downloads or switches without your say-so.
            </p>
          </section>
        )}
        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>Built on</h3>
          <p className="muted" style={aboutSmallTextStyle}>
            Electron and React for the app shell. MLX Whisper for transcription. Ollama for local
            language-model inference. better-sqlite3 for the inbox database. Plaud's public API for
            recording sync.
          </p>
        </section>
        <footer style={aboutFooterStyle}>
          <button
            onClick={() => {
              void window.distill.app.openTipJar();
            }}
            style={{
              fontSize: 11,
              background: 'transparent',
              border: 'none',
              color: 'var(--accent, #3b82f6)',
              cursor: 'pointer',
              padding: 0,
              marginRight: 'auto',
              textDecoration: 'underline',
            }}
            title="Open the tip jar in your default browser"
          >
            Support development
          </button>
          <span className="muted" style={aboutVersionStyle}>
            distill {__APP_VERSION__}
          </span>
        </footer>
      </main>
    </div>
  );
}

// --- Sources ---------------------------------------------------------------

export function SourcesPane(props: { initial: SourcesDTO; onChanged: (next: SourcesDTO) => void }) {
  const [plaud, setPlaud] = useState<PlaudStatusDTO>(props.initial.plaud);
  const [recentChange, setRecentChange] = useState<'signed-in' | 'signed-out' | null>(null);

  const updatePlaud = useCallback(
    (next: PlaudStatusDTO) => {
      setPlaud(next);
      props.onChanged({ plaud: next });
    },
    [props],
  );

  return (
    <div style={paneStyle}>
      <main style={paneBodyStyle}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          Sources are where distill picks up recordings. Plaud is the first one supported; more can be
          added later. Each source has its own sign-in and sync settings.
        </p>
        <PlaudSourceCard
          status={plaud}
          onSignedIn={(next) => {
            updatePlaud(next);
            setRecentChange('signed-in');
          }}
          onSignedOut={() => {
            updatePlaud({ signedIn: false });
            setRecentChange('signed-out');
          }}
        />
        {recentChange && (
          <div style={infoBoxStyle} role="status">
            {recentChange === 'signed-in'
              ? 'Signed in. Quit and reopen distill to start syncing with this Plaud account.'
              : 'Signed out. Quit and reopen distill so the poller stops trying to use the old credentials.'}
          </div>
        )}
      </main>
    </div>
  );
}

function PlaudSourceCard(props: {
  status: PlaudStatusDTO;
  onSignedIn: (next: PlaudStatusDTO) => void;
  onSignedOut: () => void;
}) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [region, setRegion] = useState<'us' | 'eu'>('eu');
  const [signingIn, setSigningIn] = useState(false);
  const [signInError, setSignInError] = useState<string | null>(null);
  const [signingOut, setSigningOut] = useState(false);

  const onSignIn = useCallback(async () => {
    setSignInError(null);
    if (email.trim().length === 0 || password.length === 0) {
      setSignInError('Enter your email and password.');
      return;
    }
    setSigningIn(true);
    try {
      const next = await window.distill.sources.signInPlaud({
        email: email.trim(),
        password,
        region,
      });
      setEmail('');
      setPassword('');
      props.onSignedIn(next);
    } catch (e) {
      setSignInError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }, [email, password, region, props]);

  const onSignOut = useCallback(async () => {
    setSigningOut(true);
    try {
      await window.distill.sources.signOutPlaud();
      props.onSignedOut();
    } catch (e) {
      setSignInError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningOut(false);
    }
  }, [props]);

  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
      }}
    >
      <div
        style={{
          display: 'flex',
          alignItems: 'center',
          gap: 10,
          marginBottom: props.status.signedIn ? 6 : 10,
        }}
      >
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>Plaud</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {props.status.signedIn
              ? 'Polls api.plaud.ai for new recordings every few minutes.'
              : 'Sign in to your Plaud account to sync recordings.'}
          </div>
        </div>
      </div>
      {props.status.signedIn ? (
        <div
          style={{
            display: 'flex',
            alignItems: 'center',
            gap: 12,
            marginTop: 10,
            flexWrap: 'wrap',
          }}
        >
          <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
            <div className="muted" style={{ fontSize: 10, textTransform: 'uppercase', letterSpacing: 0.4 }}>
              Signed in as
            </div>
            <div style={{ fontSize: 12, fontWeight: 500 }}>{props.status.email}</div>
            <div className="muted" style={{ fontSize: 11 }}>
              Region: {props.status.region.toUpperCase()}
              {props.status.tokenExpiresAt !== null && (
                <> · token good until {new Date(props.status.tokenExpiresAt).toLocaleDateString()}</>
              )}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={() => void onSignOut()} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          {signInError && (
            <div role="alert" style={errorBoxStyle}>
              {signInError}
            </div>
          )}
        </div>
      ) : (
        <div style={{ display: 'flex', flexDirection: 'column', gap: 8, marginTop: 10 }}>
          <div>
            <label style={fieldLabelStyle}>Email</label>
            <input
              type="email"
              autoComplete="username"
              value={email}
              onChange={(e) => setEmail(e.target.value)}
              style={inputStyle}
              placeholder="you@example.com"
              disabled={signingIn}
            />
          </div>
          <div>
            <label style={fieldLabelStyle}>Password</label>
            <input
              type="password"
              autoComplete="current-password"
              value={password}
              onChange={(e) => setPassword(e.target.value)}
              onKeyDown={(e) => {
                if (e.key === 'Enter' && !signingIn) void onSignIn();
              }}
              style={inputStyle}
              disabled={signingIn}
            />
          </div>
          <div>
            <label style={fieldLabelStyle}>Region</label>
            <select
              value={region}
              onChange={(e) => setRegion(e.target.value as 'us' | 'eu')}
              style={{ ...inputStyle, width: '100%' }}
              disabled={signingIn}
            >
              <option value="eu">EU (api-euc1.plaud.ai)</option>
              <option value="us">US (api.plaud.ai)</option>
            </select>
          </div>
          <div className="muted" style={{ ...hintStyle, marginTop: 4 }}>
            Your password is stored in macOS Keychain (service:
            <code> distill.plaud</code>). Email and region live in
            <code> ~/.plaud/config.json</code>.
          </div>
          {signInError && (
            <div role="alert" style={errorBoxStyle}>
              {signInError}
            </div>
          )}
          <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
            <button
              className="primary"
              onClick={() => void onSignIn()}
              disabled={signingIn || email.trim().length === 0 || password.length === 0}
            >
              {signingIn ? 'Signing in…' : 'Sign in'}
            </button>
          </div>
        </div>
      )}
    </section>
  );
}

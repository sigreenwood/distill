import { useCallback, useEffect, useMemo, useState } from 'react';
import type {
  GeneralDTO,
  MeetingTypeDTO,
  OllamaModelDTO,
  OllamaModelsResult,
  OutputsDTO,
  PerformanceDTO,
  PlaudAccountStatus,
  SettingsDTO,
  SourcesDTO,
  VocabularyFileDTO,
  VocabularyReplacementDTO,
  VocabularyScopeSummaryDTO,
} from '../../shared/ipc-contract.js';
import {
  KEEPALIVE_PRESETS,
  WHISPER_MODEL_PRESETS,
} from '../../shared/ipc-contract.js';

/**
 * Settings window — Outputs, Prompts, Vocabulary, General, and
 * Performance tabs.
 *
 * Loads once on open (unified load, per DECISIONS.md §3). Each tab
 * owns its own save flow and dirty state — a save failure in one tab
 * doesn't block another. Tabs render into a single scrolling
 * container so the window shape stays consistent.
 */

type Tab = 'sources' | 'outputs' | 'prompts' | 'vocabulary' | 'general' | 'performance' | 'about';

/**
 * Read the initial tab selection from the URL hash. The main process's
 * `windows.ts::openSettings({ initialTab })` writes the hash before
 * loading the renderer; opening Settings without a hash falls back to
 * the default ('sources'). Hash values that don't map to a known tab
 * also fall back to 'sources' rather than throwing — worst case the
 * user sees the default tab instead of the requested one.
 */
function readTabFromHash(): Tab {
  const hash = window.location.hash.replace(/^#/, '');
  switch (hash) {
    case 'sources':
    case 'outputs':
    case 'prompts':
    case 'vocabulary':
    case 'general':
    case 'performance':
    case 'about':
      return hash;
    default:
      return 'sources';
  }
}

export function Settings(): JSX.Element {
  const [tab, setTab] = useState<Tab>(() => readTabFromHash());
  const [outputs, setOutputs] = useState<OutputsDTO | null>(null);
  const [prompts, setPrompts] = useState<MeetingTypeDTO[] | null>(null);
  const [vocabularyScopes, setVocabularyScopes] = useState<
    VocabularyScopeSummaryDTO[] | null
  >(null);
  const [general, setGeneral] = useState<GeneralDTO | null>(null);
  const [performance, setPerformance] = useState<PerformanceDTO | null>(null);
  const [sources, setSources] = useState<SourcesDTO | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);

  useEffect(() => {
    void (async () => {
      try {
        const s: SettingsDTO = await window.distill.settings.load();
        setOutputs(s.outputs);
        setPrompts(s.prompts);
        setVocabularyScopes(s.vocabularyScopes);
        setGeneral(s.general);
        setPerformance(s.performance);
        setSources(s.sources);
      } catch (e) {
        setLoadError(e instanceof Error ? e.message : String(e));
      }
    })();
  }, []);

  // Esc closes the window (consistent with the inbox).
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if (e.key === 'Escape') window.close();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  // React to URL-hash changes from the main process. When the inbox's
  // "Sign in again" button (or any other caller) invokes
  // `app.openSettings({ tab: 'sources' })` while Settings is already
  // open, windows.ts updates the URL hash. We pick that up here and
  // switch tabs to match.
  useEffect(() => {
    const onHashChange = (): void => {
      setTab(readTabFromHash());
    };
    window.addEventListener('hashchange', onHashChange);
    return () => window.removeEventListener('hashchange', onHashChange);
  }, []);

  if (loadError && (!outputs || !prompts || !vocabularyScopes || !general || !performance || !sources)) {
    return (
      <div style={shellStyle}>
        <div style={{ padding: 24, color: 'var(--danger)' }}>
          Could not load settings: {loadError}
        </div>
      </div>
    );
  }
  if (!outputs || !prompts || !vocabularyScopes || !general || !performance || !sources) {
    return (
      <div style={shellStyle}>
        <div style={{ padding: 24, color: 'var(--fg-muted)' }}>Loading…</div>
      </div>
    );
  }

  return (
    <div style={shellStyle}>
      <header style={headerStyle}>
        <div style={{ fontWeight: 600, fontSize: 14 }}>Settings</div>
      </header>

      <div style={tabBarStyle} role="tablist">
        <TabButton label="Sources" active={tab === 'sources'} onClick={() => setTab('sources')} />
        <TabButton label="Outputs" active={tab === 'outputs'} onClick={() => setTab('outputs')} />
        <TabButton label="Prompts" active={tab === 'prompts'} onClick={() => setTab('prompts')} />
        <TabButton label="Vocabulary" active={tab === 'vocabulary'} onClick={() => setTab('vocabulary')} />
        <TabButton label="General" active={tab === 'general'} onClick={() => setTab('general')} />
        <TabButton label="Performance" active={tab === 'performance'} onClick={() => setTab('performance')} />
        <TabButton label="About" active={tab === 'about'} onClick={() => setTab('about')} />
      </div>

      {/*
        All panes are always mounted, and we toggle visibility rather
        than conditionally rendering. This preserves each tab's edit
        state (draft text, dirty flags, savedAt) when the user
        switches tabs. Conditional render would unmount the inactive
        pane and blow its state away, which would be surprising if
        the user is mid-edit.
      */}
      <div style={{ display: tab === 'sources' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <SourcesPane initial={sources} onChanged={(next) => setSources(next)} />
      </div>
      <div style={{ display: tab === 'outputs' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <OutputsPane initial={outputs} onSaved={(next) => setOutputs(next)} />
      </div>
      <div style={{ display: tab === 'prompts' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <PromptsPane initial={prompts} onChanged={(next) => setPrompts(next)} />
      </div>
      <div style={{ display: tab === 'vocabulary' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <VocabularyPane
          initialScopes={vocabularyScopes}
          onScopeSaved={(updated) =>
            setVocabularyScopes((prev) =>
              prev ? prev.map((s) => (s.id === updated.id ? updated : s)) : prev,
            )
          }
        />
      </div>
      <div style={{ display: tab === 'general' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <GeneralPane initial={general} onSaved={(next) => setGeneral(next)} />
      </div>
      <div style={{ display: tab === 'performance' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <PerformancePane initial={performance} onSaved={(next) => setPerformance(next)} />
      </div>
      <div style={{ display: tab === 'about' ? 'flex' : 'none', flex: 1, minHeight: 0, flexDirection: 'column' }}>
        <AboutPane />
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Outputs tab
// ---------------------------------------------------------------------------

function OutputsPane(props: {
  initial: OutputsDTO;
  onSaved: (next: OutputsDTO) => void;
}): JSX.Element {
  const [outputs, setOutputs] = useState<OutputsDTO>(props.initial);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const updateOutputs = useCallback((patch: Partial<OutputsDTO>): void => {
    setOutputs((prev) => ({ ...prev, ...patch }));
    setSavedAt(null);
  }, []);

  const browseFor = useCallback(
    async (current: string, apply: (next: string) => void) => {
      try {
        const chosen = await window.distill.settings.browseFolder(current);
        if (chosen) apply(chosen);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    [],
  );

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
          Summaries can be written to any combination of the three destinations
          below. Tick the ones you want; each file destination has its own folder.
        </p>

        <DestinationCard
          title="Markdown file"
          description="Plain .md with YAML frontmatter. Good for Obsidian, text editors, git."
          enabled={outputs.markdown.enabled}
          onToggle={(v) =>
            updateOutputs({ markdown: { ...outputs.markdown, enabled: v } })
          }
        >
          {outputs.markdown.enabled && (
            <>
              <FolderField
                label="Folder"
                value={outputs.markdown.dir}
                onChange={(v) =>
                  updateOutputs({ markdown: { ...outputs.markdown, dir: v } })
                }
                onBrowse={() =>
                  void browseFor(outputs.markdown.dir, (next) =>
                    updateOutputs({ markdown: { ...outputs.markdown, dir: next } }),
                  )
                }
              />
              <TranscriptToggle
                checked={outputs.markdown.includeTranscript}
                onChange={(v) =>
                  updateOutputs({
                    markdown: { ...outputs.markdown, includeTranscript: v },
                  })
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
                onChange={(v) =>
                  updateOutputs({
                    html: { ...outputs.html, includeTranscript: v },
                  })
                }
              />
            </>
          )}
        </DestinationCard>

        <DestinationCard
          title="Apple Notes"
          description="Notes are organised as {Parent folder} → {Client name} → Note."
          enabled={outputs.appleNotes.enabled}
          onToggle={(v) =>
            updateOutputs({ appleNotes: { ...outputs.appleNotes, enabled: v } })
          }
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
                      appleNotes: {
                        ...outputs.appleNotes,
                        parentFolder: e.target.value,
                      },
                    })
                  }
                  style={inputStyle}
                  placeholder="distill"
                />
                <div className="muted" style={hintStyle}>
                  Created automatically in your default Notes account if it
                  doesn&apos;t exist. Requires Automation permission for Notes.app
                  the first time you save a summary.
                </div>
              </div>
              <TranscriptToggle
                checked={outputs.appleNotes.includeTranscript}
                onChange={(v) =>
                  updateOutputs({
                    appleNotes: {
                      ...outputs.appleNotes,
                      includeTranscript: v,
                    },
                  })
                }
              />
            </>
          )}
        </DestinationCard>

        {nothingEnabled && (
          <div style={warningBoxStyle}>
            At least one destination must be enabled, otherwise summaries have
            nowhere to land.
          </div>
        )}

        {error && <div role="alert" style={errorBoxStyle}>{error}</div>}
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
            disabled={saving || nothingEnabled}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Prompts tab
// ---------------------------------------------------------------------------

function PromptsPane(props: {
  initial: MeetingTypeDTO[];
  onChanged: (next: MeetingTypeDTO[]) => void;
}): JSX.Element {
  const [prompts, setPrompts] = useState<MeetingTypeDTO[]>(props.initial);
  const [selectedId, setSelectedId] = useState<string>(
    props.initial[0]?.id ?? '',
  );
  const [draft, setDraft] = useState<string>(
    props.initial[0]?.prompt ?? '',
  );
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Import-from-markdown state. Mirrors the (saving, savedAt) pair so
  // the footer can show "Imported N prompts (X new, Y updated)" inline
  // without confusing it with a regular save. Cleared whenever the
  // user does anything else.
  const [importing, setImporting] = useState(false);
  const [importMessage, setImportMessage] = useState<string | null>(null);

  // "Add new prompt" inline form state. When `creating` is non-null,
  // the right-hand pane shows the new-prompt form instead of the
  // editor for the currently-selected built-in/user prompt. We keep
  // both `selectedId` and `creating` so cancelling falls back to the
  // previously-selected prompt without a re-render flicker.
  type CreatingState = { name: string; prompt: string } | null;
  const [creating, setCreating] = useState<CreatingState>(null);
  const [createError, setCreateError] = useState<string | null>(null);
  const [createSaving, setCreateSaving] = useState(false);

  const selected = useMemo(
    () => prompts.find((p) => p.id === selectedId),
    [prompts, selectedId],
  );

  // When the user clicks a different prompt, replace the draft with its
  // stored text. Unsaved edits to the previous prompt are discarded —
  // we could prompt-to-save here, but for the typical single-user
  // workflow it's not worth the friction.
  const switchTo = useCallback(
    (id: string) => {
      const p = prompts.find((x) => x.id === id);
      if (!p) return;
      setSelectedId(id);
      setDraft(p.prompt);
      setError(null);
      setSavedAt(null);
      // Selecting an existing prompt leaves the create form (if it
      // was open). The user explicitly chose to look at something
      // else, so close the form rather than risk losing their typed
      // draft to a stale state.
      setCreating(null);
      setCreateError(null);
    },
    [prompts],
  );

  // Open the inline new-prompt form. Doesn't touch the selected
  // prompt; cancelling restores the previous editor view.
  const openCreate = useCallback(() => {
    setCreating({ name: '', prompt: '' });
    setCreateError(null);
  }, []);

  // Submit the new-prompt form. Calls the same IPC the tag sheet uses
  // (`meetingTypes.add`) so we get consistent server-side validation
  // and ordering. On success: append to the local list, select the
  // new prompt, close the form, propagate upward.
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

  // Apply a freshly-saved or reverted DTO into the local state, and
  // propagate it upward so a later tab-switch-back doesn't show stale.
  const applyUpdatedPrompt = useCallback(
    (updated: MeetingTypeDTO) => {
      const next = prompts.map((p) => (p.id === updated.id ? updated : p));
      setPrompts(next);
      props.onChanged(next);
      if (updated.id === selectedId) setDraft(updated.prompt);
    },
    [prompts, props, selectedId],
  );

  const isDirty = selected ? draft !== selected.prompt : false;

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
      const updated = await window.distill.settings.savePrompt({
        id: selected.id,
        prompt: draft,
      });
      applyUpdatedPrompt(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, draft, applyUpdatedPrompt]);

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

  // Delete a user-created prompt. Built-ins are filtered out at the
  // UI layer (button isn't rendered for them) AND at the IPC layer
  // (handler refuses), so it's safe even if a stale render somehow
  // exposed the button. Confirmation uses native confirm() — it's an
  // Electron app, the modal is fine, and a custom dialog isn't worth
  // the code for a rare destructive action.
  //
  // Wording is pessimistic-by-design: it always tells the user that
  // any historical recordings tagged with this prompt will have their
  // meeting type detached. We don't pre-flight a count over IPC just
  // to tighten the wording — (a) that's an extra round trip for a
  // rare action, (b) the count could drift between pre-flight and
  // delete on a busy app. The summary on disk and the prompt_snapshot
  // on the row are unaffected, so the data loss is genuinely small.
  //
  // After a successful delete, fall back to selecting the first
  // remaining prompt so the editor isn't empty.
  const onDelete = useCallback(async () => {
    if (!selected || selected.is_builtin) return;
    const confirmed = window.confirm(
      `Delete “${selected.name}”? This can't be undone.\n\n` +
        `Any existing recordings tagged with this prompt will be detached — ` +
        `their summaries on disk and inbox history are kept, but the meeting ` +
        `type will show as blank for those rows.`,
    );
    if (!confirmed) return;
    setError(null);
    setSaving(true);
    try {
      await window.distill.meetingTypes.delete(selected.id);
      const next = prompts.filter((p) => p.id !== selected.id);
      setPrompts(next);
      props.onChanged(next);
      // Pick the first remaining prompt to show in the editor. There's
      // always at least one because built-ins can't be deleted.
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

  // Import prompts from a markdown file. Main does the file picker +
  // read + parse + upsert all in one go and returns the full updated
  // meeting types list, plus per-action counts. We replace the
  // sidebar wholesale with what comes back so the user immediately
  // sees the new prompts (and any updates to existing prompts'
  // names) without a tab-switch refresh.
  //
  // Selection behaviour after import: keep the currently selected
  // prompt if it still exists in the returned list (with its updated
  // text); otherwise select the first imported prompt so the editor
  // isn't empty. This matches the delete-prompt fallback shape.
  //
  // Unsaved edits to the current prompt are silently discarded —
  // matching the existing scope-switch and create-cancel behaviour.
  const onImport = useCallback(async () => {
    setError(null);
    setImportMessage(null);
    setImporting(true);
    try {
      const result = await window.distill.settings.importPrompts();
      // null === user cancelled the file picker. Quiet no-op.
      if (result === null) return;

      setPrompts(result.prompts);
      props.onChanged(result.prompts);

      // Re-select the currently selected prompt if it survived the
      // import; otherwise fall back to the first prompt in the list.
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
          <div className="muted" style={sidebarLabelStyle}>Meeting types</div>
          {prompts.map((p) => (
            <button
              key={p.id}
              onClick={() => switchTo(p.id)}
              style={{
                ...sidebarItemStyle,
                background:
                  p.id === selectedId && !creating ? 'var(--row-hover)' : 'transparent',
                fontWeight: p.id === selectedId && !creating ? 500 : 400,
              }}
            >
              <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis' }}>
                  {p.name}
                </span>
                {p.is_modified && <ModifiedBadge />}
              </div>
              <div className="muted" style={sidebarMetaStyle}>
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
        </aside>

        <section style={editorStyle}>
          {creating ? (
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
                The prompt is what Ollama uses as the system message when
                this meeting type is selected. Tip: copy an existing
                prompt as a starting point, then edit.
              </div>
              {createError && <div role="alert" style={errorBoxStyle}>{createError}</div>}
            </>
          ) : selected ? (
            <>
              <div style={editorHeaderStyle}>
                <div style={{ fontSize: 13, fontWeight: 500 }}>{selected.name}</div>
                {selected.is_modified && (
                  <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                    modified from default
                  </span>
                )}
              </div>
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
                In-flight summaries keep the prompt they started with.
                Changes apply to new summaries only.
              </div>
              {error && <div role="alert" style={errorBoxStyle}>{error}</div>}
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
          <span
            className="muted"
            style={{ fontSize: 11 }}
            aria-live="polite"
          >
            {importMessage}
          </span>
        )}
        <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
          {creating ? (
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
                  createSaving ||
                  creating.name.trim().length === 0 ||
                  creating.prompt.trim().length === 0
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

// ---------------------------------------------------------------------------
// Vocabulary tab
// ---------------------------------------------------------------------------

type PendingReplacement = {
  from: string;
  to: string;
  /** Comma-separated — rendered in one input, parsed on save. */
  requiresContext: string;
};

function VocabularyPane(props: {
  initialScopes: VocabularyScopeSummaryDTO[];
  onScopeSaved: (updated: VocabularyScopeSummaryDTO) => void;
}): JSX.Element {
  const [scopes, setScopes] = useState<VocabularyScopeSummaryDTO[]>(
    props.initialScopes,
  );
  const [selectedId, setSelectedId] = useState<string>(
    props.initialScopes[0]?.id ?? '',
  );

  // Lazy-loaded per-scope content. Null while fetching; set once loaded.
  const [file, setFile] = useState<VocabularyFileDTO | null>(null);
  // Edit drafts — hints as a plain string[], replacements with csv context
  // (so the user types one cell, we parse on save).
  const [hints, setHints] = useState<string[]>([]);
  const [replacements, setReplacements] = useState<PendingReplacement[]>([]);

  const [loadingScope, setLoadingScope] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [importing, setImporting] = useState(false);
  const [exporting, setExporting] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);
  const [exportedPath, setExportedPath] = useState<string | null>(null);
  const [helpOpen, setHelpOpen] = useState(false);

  const selected = useMemo(
    () => scopes.find((s) => s.id === selectedId),
    [scopes, selectedId],
  );

  // Load the file contents whenever the selected scope changes. Discards
  // any unsaved draft of the previous scope, matching the Prompts tab.
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

  // Hint editing
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

  // Replacement editing
  const addReplacement = useCallback(() => {
    setReplacements((r) => [...r, { from: '', to: '', requiresContext: '' }]);
    markDirty();
  }, [markDirty]);
  const updateReplacement = useCallback(
    (index: number, patch: Partial<PendingReplacement>) => {
      setReplacements((r) =>
        r.map((x, i) => (i === index ? { ...x, ...patch } : x)),
      );
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
        replacements: replacements.map(
          (r): VocabularyReplacementDTO => ({
            from: r.from,
            to: r.to,
            requiresContext:
              r.requiresContext.trim().length > 0
                ? r.requiresContext
                    .split(',')
                    .map((s) => s.trim())
                    .filter((s) => s.length > 0)
                : undefined,
          }),
        ),
        // Notes are preserved by main from the on-disk file. Not sent
        // from the renderer.
      };
      const updated = await window.distill.settings.saveVocabulary({
        scopeId: selected.id,
        file: payload,
      });
      setScopes((prev) =>
        prev.map((s) => (s.id === updated.id ? updated : s)),
      );
      props.onScopeSaved(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, hints, replacements, props]);

  // Import a JSON vocabulary file from disk into the selected scope.
  // Main does the file picker + read + validate + merge + write all
  // in one go and returns the merged DTO; here we just need to
  // refresh the editor state with what came back.
  //
  // Term-count badge: we recompute it locally from the merged file
  // (hints + replacements) rather than asking main for an updated
  // VocabularyScopeSummaryDTO. The IPC return type is the file, not
  // the summary, so we'd need a second round-trip. Local recompute
  // matches what countVocabularyTerms does on the main side.
  //
  // Unsaved edits to the current scope are silently discarded —
  // matching the existing scope-switch behaviour. If this turns out
  // to be surprising in practice we can add a confirm() prompt, but
  // for now consistency with switchTo wins.
  const onImport = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setImporting(true);
    try {
      const merged = await window.distill.settings.importVocabulary(selected.id);
      // null === user cancelled the file picker. Quiet no-op.
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
      // Recompute the sidebar term count from the merged file.
      const updatedSummary: VocabularyScopeSummaryDTO = {
        ...selected,
        termCount:
          merged.whisperHints.length + merged.replacements.length,
      };
      setScopes((prev) =>
        prev.map((s) => (s.id === updatedSummary.id ? updatedSummary : s)),
      );
      props.onScopeSaved(updatedSummary);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [selected, props]);

  // Export the on-disk file for the selected scope to a user-chosen
  // location. Main does the file picker + serialise + write; the
  // renderer just kicks it off and surfaces success / error.
  //
  // Important: export reads the on-disk file, NOT the current editor
  // draft. If the user has unsaved edits and exports, those edits
  // won't be in the exported file. The footer hints at this with a
  // "saved." badge after a successful save — export will pick up
  // whatever is most recently saved.
  const onExport = useCallback(async () => {
    if (!selected) return;
    setError(null);
    setExportedPath(null);
    setExporting(true);
    try {
      const result = await window.distill.settings.exportVocabulary(selected.id);
      // null === user cancelled. Quiet no-op.
      if (result === null) return;
      setExportedPath(result.path);
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setExporting(false);
    }
  }, [selected]);

  // Group scopes into built-ins and clients for the sidebar layout.
  const builtins = scopes.filter((s) => s.builtin);
  const clientScopes = scopes.filter((s) => !s.builtin);

  return (
    <div style={paneStyle}>
      <main style={promptsPaneBodyStyle}>
        <aside style={sidebarStyle}>
          <div className="muted" style={sidebarLabelStyle}>Built-in packs</div>
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
              <div
                className="muted"
                style={{ ...sidebarLabelStyle, marginTop: 12 }}
              >
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
                <div style={{ fontSize: 13, fontWeight: 500 }}>
                  {selected.label}
                </div>
                <span style={{ fontSize: 11, color: 'var(--fg-muted)' }}>
                  {selected.builtin
                    ? 'Always applied'
                    : `Client scope · ${selected.label}`}
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

              {/* Hints */}
              <div style={sectionHeadingStyle}>Whisper hints</div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Terms Whisper should recognise. Written into the
                initial_prompt at transcription time.
              </div>
              <div style={tableStyle}>
                {hints.length === 0 && (
                  <div className="muted" style={{ padding: '4px 2px', fontSize: 11 }}>
                    No hints yet.
                  </div>
                )}
                {hints.map((h, i) => (
                  <div key={i} style={tableRowStyle}>
                    <input
                      type="text"
                      value={h}
                      onChange={(e) => updateHint(i, e.target.value)}
                      style={{ ...inputStyle, flex: 1 }}
                      placeholder="e.g. Acme Corp"
                    />
                    <button
                      onClick={() => deleteHint(i)}
                      style={deleteButtonStyle}
                      title="Remove this hint"
                      aria-label="Remove hint"
                    >
                      ✕
                    </button>
                  </div>
                ))}
                <button onClick={addHint} style={addButtonStyle}>
                  + Add hint
                </button>
              </div>

              {/* Replacements */}
              <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>
                Replacement rules
              </div>
              <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                Post-transcription rewrites. Context words (comma-separated)
                are optional — when set, the rule only fires if one of those
                words appears elsewhere in the transcript.
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
                      onChange={(e) =>
                        updateReplacement(i, { requiresContext: e.target.value })
                      }
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

              {/* Notes (read-only) */}
              {file?.notes && file.notes.length > 0 && (
                <>
                  <div style={{ ...sectionHeadingStyle, marginTop: 16 }}>
                    Notes
                  </div>
                  <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
                    Preserved from the JSON file on disk. Edit the file
                    directly to change these.
                  </div>
                  <ul style={notesListStyle}>
                    {file.notes.map((n, i) => (
                      <li key={i} style={{ marginBottom: 4 }}>{n}</li>
                    ))}
                  </ul>
                </>
              )}

              {error && <div role="alert" style={errorBoxStyle}>{error}</div>}
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
            style={{ fontSize: 11, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: 360 }}
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

function ScopeSidebarItem(props: {
  scope: VocabularyScopeSummaryDTO;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
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

/**
 * Inline help panel for the Vocabulary editor. Shows the JSON schema
 * and a worked example so users understand what whisperHints and
 * replacements actually do, what shape an importable JSON file takes,
 * and how `requiresContext` gates context-dependent rules.
 *
 * Toggleable from the editor header so the help doesn't take up
 * permanent space in an editor that's mostly used by people who
 * already know the format.
 *
 * Content here mirrors VOCABULARY_GENERATION_PROMPT.md (the doc that
 * ships in the .pkg). The doc has more depth (LLM-prompt template,
 * iteration tips); this panel is the inline quick reference.
 */
function VocabularyHelpPanel(): JSX.Element {
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
        <strong>Whisper hints</strong> bias the transcriber toward
        recognising specific terms. Use the spelling and capitalisation
        you want in the transcript. Examples: <code>Acme Corp</code>,{' '}
        <code>Falcon</code>, <code>QBR</code>, <code>Karen Velasquez</code>.
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong>Replacement rules</strong> rewrite likely
        mistranscriptions after Whisper finishes. Each rule has a{' '}
        <code>from</code> (what Whisper outputs incorrectly) and a{' '}
        <code>to</code> (what we want it to be). Matched
        case-insensitively at word boundaries.
      </div>
      <div style={{ marginBottom: 8 }}>
        <strong>Context (optional)</strong> gates a replacement rule on
        other words appearing in the transcript. Use for homophones:
        e.g. <code>sim</code> &rarr; <code>CIM</code> only fires when{' '}
        <code>marketing</code> or <code>campaign</code> is also in the
        transcript, so phone-sim mentions stay untouched.
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
        Imagine you work at Acme Corp on the Falcon database. Whisper
        regularly mishears <code>Acme</code> as <code>acne</code> and{' '}
        <code>Falcon</code> as <code>fall come</code>.
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
        Save this JSON to a file and use the <strong>Import…</strong>{' '}
        button below to merge it into this scope. Existing entries are
        kept; conflicts (same <code>from</code> value) are overwritten
        by the imported version.
      </div>
      <div style={{ marginTop: 6 }}>
        Tip: if generating these by hand is tedious, paste your domain
        notes into ChatGPT / Claude with the prompt in{' '}
        <code>VOCABULARY_GENERATION_PROMPT.md</code> (bundled in the
        app's resources directory) and ask it to produce a JSON file
        in this shape.
      </div>

      <div style={{ ...sectionHeadingStyle, marginTop: 12 }}>
        Markdown table format
      </div>
      <div style={{ marginBottom: 6 }}>
        Replacement rules can also be imported from a markdown file
        containing one or more GFM tables with the columns{' '}
        <strong>Heard as</strong>, <strong>Should be</strong>, and
        (optionally) <strong>Context cue</strong>. Other tables in the
        same file (acronym glossaries, narrative tables) are skipped.
        Hints and notes don't come through this format — import a
        JSON file for those.
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

// ---------------------------------------------------------------------------
// General tab
// ---------------------------------------------------------------------------

/**
 * The General pane edits one field today — audioRetentionDays — with
 * the tri-state semantics of the underlying config field surfaced as
 * a checkbox plus a number input. Sketch:
 *
 *   [ ] Auto-delete imported audio after [ N ] days
 *
 * Off  = checkbox cleared          → audioRetentionDays = null
 * 0    = checked, days = 0         → delete immediately on completion
 * N>0  = checked, days = N         → delete N days post-write
 *
 * The checkbox model maps cleanly onto the user's mental question:
 * "do I want this to ever delete?" The number then answers "how soon?".
 */
function GeneralPane(props: {
  initial: GeneralDTO;
  onSaved: (next: GeneralDTO) => void;
}): JSX.Element {
  // Two derived UI controls map to one tri-state value. We keep the
  // "days" string in state separately so the user can clear the field
  // mid-edit without us snapping it back to 0 on every keystroke.
  const initialEnabled = props.initial.audioRetentionDays !== null;
  const initialDays = props.initial.audioRetentionDays ?? 14;
  const [enabled, setEnabled] = useState<boolean>(initialEnabled);
  const [daysText, setDaysText] = useState<string>(String(initialDays));
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Re-derive the persisted DTO from current UI state. Returns null on
  // invalid input (so the Save button can be disabled cleanly without
  // a separate validation pass).
  const computed = useMemo<GeneralDTO | null>(() => {
    if (!enabled) return { audioRetentionDays: null };
    const trimmed = daysText.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return null;
    }
    return { audioRetentionDays: parsed };
  }, [enabled, daysText]);

  const isDirty = useMemo(() => {
    if (!computed) return false;
    return computed.audioRetentionDays !== props.initial.audioRetentionDays;
  }, [computed, props.initial.audioRetentionDays]);

  const onSave = useCallback(async () => {
    if (!computed) return;
    setError(null);
    setSaving(true);
    try {
      await window.distill.settings.saveGeneral(computed);
      props.onSaved(computed);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [computed, props]);

  return (
    <div style={paneStyle}>
      <main style={paneBodyStyle}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          App-level settings that aren&apos;t tied to a specific output
          destination, prompt, or vocabulary scope.
        </p>

        <section
          style={{
            border: '1px solid var(--border)',
            borderRadius: 8,
            padding: 12,
            marginBottom: 12,
          }}
        >
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>
            Audio retention
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            Imported audio (Teams recordings, voice memos, anything dragged
            in) is kept on disk after a summary lands. This setting controls
            how long. Plaud-sourced recordings are never auto-deleted — they
            can be re-fetched from the Plaud cloud, so deleting locally is
            cheap. Local imports are unique on disk, so the default is
            conservative.
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
            <div
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                marginLeft: 24,
              }}
            >
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

        {error && <div role="alert" style={errorBoxStyle}>{error}</div>}
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
            disabled={saving || !isDirty || !computed}
          >
            {saving ? 'Saving…' : 'Save'}
          </button>
        </div>
      </footer>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Performance tab
// ---------------------------------------------------------------------------

/**
 * The Performance pane edits three values that affect how the
 * pipeline uses local resources: which Ollama model summarises, how
 * long Ollama keeps the model resident, and which MLX Whisper model
 * transcribes. The Ollama list comes live from /api/tags; the
 * Whisper list is curated (mistyped HF ids silently download the
 * wrong model). See BACKLOG “Audio retention cleanup” → Performance
 * pane for the design rationale.
 *
 * Save semantics: in-flight pipeline steps keep the values they
 * started with. New values apply to subsequent runs. (`doSummarise`
 * and `doTranscribe` both call `getConfig()` fresh at step start.)
 */
function PerformancePane(props: {
  initial: PerformanceDTO;
  onSaved: (next: PerformanceDTO) => void;
}): JSX.Element {
  const [draft, setDraft] = useState<PerformanceDTO>(props.initial);
  const [models, setModels] = useState<OllamaModelDTO[] | null>(null);
  const [ollamaError, setOllamaError] = useState<string | null>(null);
  const [loadingModels, setLoadingModels] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  // Fetch the live model list when the pane mounts. We don't refresh
  // on every tab-switch — the Settings window is short-lived enough
  // that one fetch on open is plenty. The user can close-and-reopen
  // if a new model has been pulled.
  const refreshModels = useCallback(async () => {
    setLoadingModels(true);
    setOllamaError(null);
    try {
      const result: OllamaModelsResult = await window.distill.settings.listOllamaModels();
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
    draft.whisperModel !== props.initial.whisperModel;

  // The picker is disabled when Ollama is unreachable so the user
  // can't accidentally save a stale-or-empty model id; per the
  // design call, save is also blocked in that state. The user can
  // start Ollama and click Refresh to re-enable everything.
  const ollamaUnreachable = ollamaError !== null;
  const canSave = !saving && isDirty && !ollamaUnreachable;

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
          Pipeline model choices. In-flight steps keep the values they
          started with; changes here apply to subsequent runs.
        </p>

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
            Pulled live from your local Ollama (<code>/api/tags</code>). Pull
            new models from a terminal with <code>ollama pull &lt;name&gt;</code>;
            they appear here after Refresh.
          </div>

          {ollamaUnreachable ? (
            <div
              role="alert"
              style={{
                ...errorBoxStyle,
                marginTop: 0,
                marginBottom: 6,
              }}
            >
              {ollamaError}
              <div className="muted" style={{ fontSize: 11, marginTop: 6 }}>
                Start Ollama and click Refresh. The current saved model
                is still in effect: <strong>{props.initial.ollamaModel}</strong>.
              </div>
            </div>
          ) : models === null ? (
            <div className="muted" style={{ fontSize: 12, padding: '4px 0' }}>
              Loading…
            </div>
          ) : models.length === 0 ? (
            <div
              style={{
                ...errorBoxStyle,
                marginTop: 0,
                marginBottom: 6,
              }}
            >
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
              {/*
                If the saved model is missing from the live list (pulled
                model deleted, name typo, etc.) we still surface it as a
                warning option so the user knows what's currently saved.
              */}
              {!models.some((m) => modelMatches(m.name, draft.ollamaModel)) && (
                <option value={draft.ollamaModel}>
                  {draft.ollamaModel} — not installed locally
                </option>
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
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>
            Ollama keep-alive
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            How long Ollama keeps the model loaded after a summary
            finishes. Lower values free unified memory sooner; higher
            values let back-to-back summaries skip the load cost.
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
          <div style={{ fontWeight: 500, fontSize: 13, marginBottom: 4 }}>
            Whisper model
          </div>
          <div className="muted" style={{ fontSize: 11, marginBottom: 10 }}>
            Larger models give better transcription, especially on names
            and technical terms, but use more RAM and CPU. The vocabulary
            system compensates somewhat for smaller models.
          </div>
          <select
            value={draft.whisperModel}
            onChange={(e) => {
              setDraft({ ...draft, whisperModel: e.target.value });
              setSavedAt(null);
            }}
            style={{ ...inputStyle, width: '100%' }}
          >
            {/*
              If the saved value isn't in the curated list (e.g. a
              user hand-edited config.json with a custom HF id), we
              still surface it so they can see what they have without
              losing the value when the dropdown defaults to the
              first preset.
            */}
            {!WHISPER_MODEL_PRESETS.some((p) => p.value === draft.whisperModel) && (
              <option value={draft.whisperModel}>
                {draft.whisperModel} — custom
              </option>
            )}
            {WHISPER_MODEL_PRESETS.map((p) => (
              <option key={p.value} value={p.value}>
                {p.label}
              </option>
            ))}
          </select>
          {!WHISPER_MODEL_PRESETS.some((p) => p.value === draft.whisperModel) && (
            <div className="muted" style={{ ...hintStyle, marginTop: 6 }}>
              Your config currently points at a custom Whisper model.
              Saving will switch to the picked preset.
            </div>
          )}
        </section>

        {error && <div role="alert" style={errorBoxStyle}>{error}</div>}
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
 * Tolerant comparison for Ollama model names. Ollama's /api/tags often
 * returns names with a `:latest` suffix even when the user pulled the
 * model without one. Match either form so the dropdown finds the saved
 * value cleanly.
 */
function modelMatches(name: string, target: string): boolean {
  if (name === target) return true;
  if (name === `${target}:latest`) return true;
  if (`${name}:latest` === target) return true;
  return false;
}

/**
 * Format a byte count as 'GB' / 'MB'. Ollama model sizes are always
 * in the GB range so we stay simple — no need for KB or B.
 */
function formatBytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return '?';
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}

// ---------------------------------------------------------------------------
// About tab
// ---------------------------------------------------------------------------

/**
 * The About pane is read-only and unstructured — just a plain prose
 * description of what distill is, what it talks to, and how the
 * pipeline runs. Three sections, each terse:
 *
 *   1. What it does (one paragraph anyone can read to a colleague)
 *   2. How the pipeline works (four pipeline stages, one line each)
 *   3. Where data goes (every external touch point, named honestly)
 *
 * Plus a small footer with the version (injected at build time from
 * package.json via Vite's `define`) and credit to the libraries doing
 * the heavy lifting.
 *
 * Deliberately not included: marketing copy, mission statement, a
 * credits wall, license text. About pages get bigger over time;
 * this one is meant to stay short.
 */
function AboutPane(): JSX.Element {
  return (
    <div style={paneStyle}>
      <main style={{ ...paneBodyStyle, maxWidth: 720 }}>
        <h2 style={aboutHeadingStyle}>distill</h2>
        <p className="muted" style={aboutLeadStyle}>
          A local-first meeting summariser. Pulls recordings from a Plaud
          device (or files you drag in), transcribes them on your Mac,
          summarises them with a local language model, and writes the
          result to Markdown / HTML / Apple Notes — all without sending
          your audio or transcripts to a third-party AI service.
        </p>

        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>How it works</h3>
          <ol style={aboutOrderedListStyle}>
            <li>
              <strong>Sync.</strong> Polls the Plaud cloud for new
              recordings, or accepts files you drop into the inbox
              (audio or video, ffmpeg extracts the audio track).
            </li>
            <li>
              <strong>Transcribe.</strong> Runs MLX Whisper locally on
              the audio. Your vocabulary packs (per-client and global)
              are baked into the prompt so technical terms come through
              correctly, and post-pass replacements fix known
              mistranscriptions.
            </li>
            <li>
              <strong>Summarise.</strong> Sends the transcript to your
              local Ollama instance with the meeting-type prompt of
              your choice. The summary stays on your machine.
            </li>
            <li>
              <strong>Write.</strong> Saves the summary (and optionally
              the transcript) to whichever destinations you have
              enabled. Idempotent per destination, so a retry only
              re-runs the parts that didn&apos;t land.
            </li>
          </ol>
        </section>

        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>Where your data goes</h3>
          <ul style={aboutUnorderedListStyle}>
            <li>
              <strong>Plaud cloud</strong> — distill talks to it to
              list and download your own recordings. Uses the
              credentials you sign in with under Sources. Your
              password is stored in macOS Keychain.
            </li>
            <li>
              <strong>Ollama</strong> — runs locally on your machine,
              by default at <code>localhost:11434</code>. Transcripts
              are sent to it for summarisation. Nothing leaves your
              Mac.
            </li>
            <li>
              <strong>Hugging Face</strong> — contacted once per
              Whisper model to download model weights the first time
              you use them. Subsequent transcriptions run entirely
              offline.
            </li>
            <li>
              <strong>Output destinations</strong> — Markdown / HTML
              files land in folders you configure (typically iCloud
              Drive or a local Documents subfolder); Apple Notes
              writes to your local Notes app. distill never uploads
              outputs anywhere on its own.
            </li>
          </ul>
        </section>

        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>Choosing a local model</h3>
          <p style={aboutSmallTextStyle}>
            distill summarises your meetings using a language model
            running locally via Ollama. The model never sees the
            internet. Bigger models write better summaries but need
            more memory and take longer to run, so the right pick
            depends on the Mac you have.
          </p>
          <p className="muted" style={{ ...aboutSmallTextStyle, marginTop: 8 }}>
            All recommendations below are 4-bit quantised builds
            (the default Ollama tags). Numbers are rough estimates
            from community benchmarks rather than measured on your
            machine. The local-model landscape moves fast and Apple
            ships new silicon roughly once a year, so the model
            names and hardware tiers below are very likely out of
            date by the time you are reading this. Treat everything
            as a starting point, not gospel.
          </p>

          <h4 style={aboutInlineHeadingStyle}>16 GB Macs</h4>
          <p style={aboutSmallTextStyle}>
            Stick to 7-9B models. <code>llama3.1:8b</code> or{' '}
            <code>mistral:7b</code> are solid defaults.{' '}
            <code>qwen3.5:8b</code> is worth trying if you want a
            touch more reasoning quality. <code>gemma4:e4b</code> is
            the current Google option in this class. Anything bigger
            leaves little headroom for everything else you have open.
          </p>

          <h4 style={aboutInlineHeadingStyle}>24 GB Macs</h4>
          <p style={aboutSmallTextStyle}>
            <code>qwen3.5:14b</code> is the sweet spot. Sits
            comfortably in memory and is noticeably better at
            structured summaries than a 7-9B. If you want faster runs
            and don&apos;t mind slightly thinner output, drop back to
            a 7-9B.
          </p>

          <h4 style={aboutInlineHeadingStyle}>48 GB and above</h4>
          <p style={aboutSmallTextStyle}>
            <code>qwen3.5:32b</code> or <code>gemma4:31b</code> are
            where the quality jump becomes obvious. With 64 GB or
            more, <code>llama3.3:70b</code> produces summaries close
            to what you&apos;d get from a hosted frontier model.
            Slower, but for important meetings the wait is usually
            worth it.
          </p>

          <h4 style={aboutInlineHeadingStyle}>Apple Silicon notes</h4>
          <p style={aboutSmallTextStyle}>
            M-series Macs share memory between CPU and GPU, so the
            unified memory total is what matters. The other big
            factor is memory bandwidth, since that is what feeds
            tokens to the GPU.
          </p>
          <p style={{ ...aboutSmallTextStyle, marginTop: 6 }}>
            Roughly: M1 sits at 68 GB/s, M2 at 100 GB/s, M3 at 100
            GB/s, M4 at 120 GB/s, M5 at 153 GB/s. Pro variants run
            200 to 307 GB/s, Max variants 400 to 614 GB/s, and the
            Ultra chips hit 800 GB/s and beyond. M1 still works fine
            for 7-8B models but feels slow on anything 14B and up.
            M5 base is meaningfully faster than M4 base on the same
            model thanks to the bandwidth bump and Neural
            Accelerators in every GPU core.
          </p>

          <h4 style={aboutInlineHeadingStyle}>
            Rough performance for a 30 minute meeting
          </h4>
          <p style={aboutSmallTextStyle}>
            Estimated end-to-end time for transcribing a 30 minute
            recording with MLX Whisper and then summarising the
            transcript. RAM figures are peak usage during
            summarisation.
          </p>

          <table style={aboutTableStyle}>
            <thead>
              <tr>
                <th style={aboutTableHeaderCellStyle}>Hardware</th>
                <th style={aboutTableHeaderCellStyle}>Model</th>
                <th style={{ ...aboutTableHeaderCellStyle, textAlign: 'right' }}>Time</th>
                <th style={{ ...aboutTableHeaderCellStyle, textAlign: 'right' }}>RAM</th>
                <th style={aboutTableHeaderCellStyle}>Quality</th>
              </tr>
            </thead>
            <tbody>
              <tr>
                <td style={aboutTableCellStyle}>M1, 16 GB</td>
                <td style={aboutTableCodeCellStyle}>llama3.1:8b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>8-12 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~6 GB</td>
                <td style={aboutTableCellStyle}>Good</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M2, 16 GB</td>
                <td style={aboutTableCodeCellStyle}>qwen3.5:8b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>5-8 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~6 GB</td>
                <td style={aboutTableCellStyle}>Good</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M3, 16 GB</td>
                <td style={aboutTableCodeCellStyle}>gemma4:e4b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>4-7 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~5 GB</td>
                <td style={aboutTableCellStyle}>Good</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M2 Pro, 24 GB</td>
                <td style={aboutTableCodeCellStyle}>qwen3.5:14b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>6-10 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~10 GB</td>
                <td style={aboutTableCellStyle}>Very good</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M4, 24 GB</td>
                <td style={aboutTableCodeCellStyle}>qwen3.5:14b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>5-7 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~10 GB</td>
                <td style={aboutTableCellStyle}>Very good</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M5, 24 GB</td>
                <td style={aboutTableCodeCellStyle}>qwen3.5:14b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>4-6 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~10 GB</td>
                <td style={aboutTableCellStyle}>Very good</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M3 Max, 48 GB</td>
                <td style={aboutTableCodeCellStyle}>qwen3.5:32b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>8-12 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~22 GB</td>
                <td style={aboutTableCellStyle}>Excellent</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M4 Max, 64 GB</td>
                <td style={aboutTableCodeCellStyle}>llama3.3:70b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>12-20 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~42 GB</td>
                <td style={aboutTableCellStyle}>Frontier-class</td>
              </tr>
              <tr>
                <td style={aboutTableCellStyle}>M5 Max, 64 GB+</td>
                <td style={aboutTableCodeCellStyle}>llama3.3:70b</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>8-14 min</td>
                <td style={{ ...aboutTableCellStyle, textAlign: 'right' }}>~42 GB</td>
                <td style={aboutTableCellStyle}>Frontier-class</td>
              </tr>
            </tbody>
          </table>

          <p className="muted" style={{ ...aboutSmallTextStyle, marginTop: 8 }}>
            Times include both transcription and summarisation.
            Transcription alone is roughly 2-4 minutes on most
            M-series Macs (M1 closer to 4-6). Your numbers will vary
            with audio length, speaker count, what else is running,
            and thermal state.
          </p>
        </section>

        <section style={aboutSectionStyle}>
          <h3 style={aboutSubheadingStyle}>Built on</h3>
          <p className="muted" style={aboutSmallTextStyle}>
            Electron and React for the app shell. MLX Whisper for
            transcription. Ollama for local language-model inference.
            better-sqlite3 for the inbox database. Plaud&apos;s public
            API for recording sync.
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

// ---------------------------------------------------------------------------
// Sources tab
// ---------------------------------------------------------------------------

/**
 * The Sources pane is list-shaped: today there's one entry (Plaud);
 * future sources slot in as additional entries without a UI rewrite.
 * Sign-in and sign-out happen via dedicated IPC channels rather than
 * the unified settings save, because they involve a network round-trip
 * and the UI needs to react to success / failure individually.
 *
 * After a successful sign-in or sign-out, the running poller and
 * pipeline worker still hold the connection state they were
 * constructed with at app launch. The main process surfaces a
 * "restart to apply" notification on every credential change; this
 * pane shows the same hint inline once the user has completed the
 * action so they don't have to remember the toast.
 */
function SourcesPane(props: {
  initial: SourcesDTO;
  onChanged: (next: SourcesDTO) => void;
}): JSX.Element {
  const [plaud, setPlaud] = useState<PlaudAccountStatus>(props.initial.plaud);

  // True for one render cycle after sign-in or sign-out so we can
  // surface the "restart distill" reminder inline. Cleared when the
  // user navigates away or signs in again.
  const [recentChange, setRecentChange] = useState<
    'signed-in' | 'signed-out' | null
  >(null);

  const updatePlaud = useCallback(
    (next: PlaudAccountStatus) => {
      setPlaud(next);
      props.onChanged({ plaud: next });
    },
    [props],
  );

  return (
    <div style={paneStyle}>
      <main style={paneBodyStyle}>
        <p className="muted" style={{ fontSize: 12, marginTop: 0, marginBottom: 16 }}>
          Sources are where distill picks up recordings. Plaud is the
          first one supported; more can be added later. Each source has
          its own sign-in and sync settings.
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

/**
 * A single source entry. Today this is hard-coded for Plaud; when
 * the second source lands it can become a generic SourceCard with
 * an embedded source-specific sign-in form.
 */
function PlaudSourceCard(props: {
  status: PlaudAccountStatus;
  onSignedIn: (next: PlaudAccountStatus) => void;
  onSignedOut: () => void;
}): JSX.Element {
  // Sign-in form state. Shown when status.signedIn === false.
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
      // Clear the form and let the parent know.
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
      // Sign-out is best-effort and rarely fails; surface it inline
      // anyway so the user knows something went wrong.
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
                <>
                  {' · token good until '}
                  {new Date(props.status.tokenExpiresAt).toLocaleDateString()}
                </>
              )}
            </div>
          </div>
          <div style={{ marginLeft: 'auto', display: 'flex', gap: 8 }}>
            <button onClick={() => void onSignOut()} disabled={signingOut}>
              {signingOut ? 'Signing out…' : 'Sign out'}
            </button>
          </div>
          {signInError && <div role="alert" style={errorBoxStyle}>{signInError}</div>}
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
          {signInError && <div role="alert" style={errorBoxStyle}>{signInError}</div>}
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

// ---------------------------------------------------------------------------
// Sub-components and helpers
// ---------------------------------------------------------------------------

function TabButton(props: {
  label: string;
  active: boolean;
  onClick: () => void;
}): JSX.Element {
  return (
    <button
      role="tab"
      aria-selected={props.active}
      onClick={props.onClick}
      style={{
        ...tabButtonStyle,
        borderBottomColor: props.active ? 'var(--accent, #3b82f6)' : 'transparent',
        color: props.active ? 'var(--fg)' : 'var(--fg-muted)',
        fontWeight: props.active ? 500 : 400,
      }}
    >
      {props.label}
    </button>
  );
}

function ModifiedBadge(): JSX.Element {
  return (
    <span
      style={{
        fontSize: 9,
        padding: '1px 5px',
        borderRadius: 3,
        background: 'var(--accent, #3b82f6)',
        color: 'white',
        textTransform: 'uppercase',
        letterSpacing: 0.3,
        fontWeight: 600,
      }}
      title="Prompt has been edited from the default"
    >
      mod
    </span>
  );
}

function DestinationCard(props: {
  title: string;
  description: string;
  enabled: boolean;
  onToggle: (v: boolean) => void;
  children?: React.ReactNode;
}): JSX.Element {
  return (
    <section
      style={{
        border: '1px solid var(--border)',
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        background: props.enabled ? 'var(--bg)' : 'var(--row-hover)',
      }}
    >
      <label style={{ display: 'flex', gap: 10, cursor: 'pointer' }}>
        <input
          type="checkbox"
          checked={props.enabled}
          onChange={(e) => props.onToggle(e.target.checked)}
          style={{ marginTop: 2 }}
        />
        <div style={{ flex: 1 }}>
          <div style={{ fontWeight: 500, fontSize: 13 }}>{props.title}</div>
          <div className="muted" style={{ fontSize: 11, marginTop: 2 }}>
            {props.description}
          </div>
        </div>
      </label>
      {props.children}
    </section>
  );
}

function FolderField(props: {
  label: string;
  value: string;
  onChange: (v: string) => void;
  onBrowse: () => void;
}): JSX.Element {
  return (
    <div style={{ marginTop: 10 }}>
      <label style={fieldLabelStyle}>{props.label}</label>
      <div style={{ display: 'flex', gap: 6 }}>
        <input
          type="text"
          value={props.value}
          onChange={(e) => props.onChange(e.target.value)}
          style={{ ...inputStyle, flex: 1 }}
          placeholder="~/Documents/distill"
        />
        <button onClick={props.onBrowse}>Browse…</button>
      </div>
    </div>
  );
}

function TranscriptToggle(props: {
  checked: boolean;
  onChange: (v: boolean) => void;
}): JSX.Element {
  return (
    <label
      style={{
        display: 'flex',
        alignItems: 'center',
        gap: 8,
        marginTop: 10,
        fontSize: 12,
        cursor: 'pointer',
      }}
    >
      <input
        type="checkbox"
        checked={props.checked}
        onChange={(e) => props.onChange(e.target.checked)}
      />
      <span>Embed full transcript below the summary</span>
    </label>
  );
}

/**
 * Human-friendly relative time: "2m ago", "3h ago", "yesterday",
 * "12 Apr". Used in the prompts sidebar to show when each prompt was
 * last touched. Not exact — purely for at-a-glance orientation.
 */
function formatRelative(epochMs: number): string {
  const diff = Date.now() - epochMs;
  if (diff < 60_000) return 'just now';
  const mins = Math.floor(diff / 60_000);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return 'yesterday';
  if (days < 7) return `${days}d ago`;
  // Fall through to a short date for older entries.
  const d = new Date(epochMs);
  return d.toLocaleDateString(undefined, { day: 'numeric', month: 'short' });
}

// ---------------------------------------------------------------------------
// Styles (co-located for simplicity since this is a small window)
// ---------------------------------------------------------------------------

const shellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--bg)',
  color: 'var(--fg)',
};

const headerStyle: React.CSSProperties = {
  padding: '12px 20px',
  borderBottom: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const tabBarStyle: React.CSSProperties = {
  display: 'flex',
  gap: 0,
  borderBottom: '1px solid var(--border)',
  padding: '0 12px',
};

const tabButtonStyle: React.CSSProperties = {
  padding: '10px 16px',
  fontSize: 12,
  background: 'transparent',
  border: 'none',
  borderBottom: '2px solid transparent',
  cursor: 'pointer',
  marginBottom: -1,
};

const paneStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  flex: 1,
  minHeight: 0,
};

const paneBodyStyle: React.CSSProperties = {
  padding: '14px 20px',
  overflowY: 'auto',
  flex: 1,
};

const promptsPaneBodyStyle: React.CSSProperties = {
  display: 'flex',
  flex: 1,
  minHeight: 0,
};

const sidebarStyle: React.CSSProperties = {
  width: 220,
  borderRight: '1px solid var(--border)',
  overflowY: 'auto',
  padding: '10px 8px',
  display: 'flex',
  flexDirection: 'column',
  gap: 2,
};

const sidebarLabelStyle: React.CSSProperties = {
  fontSize: 10,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  padding: '4px 8px 8px',
};

const sidebarItemStyle: React.CSSProperties = {
  textAlign: 'left',
  padding: '8px 10px',
  border: 'none',
  borderRadius: 4,
  cursor: 'pointer',
  fontSize: 12,
  color: 'var(--fg)',
  lineHeight: 1.3,
};

const sidebarMetaStyle: React.CSSProperties = {
  fontSize: 10,
  marginTop: 2,
};

const editorStyle: React.CSSProperties = {
  flex: 1,
  padding: '14px 20px',
  display: 'flex',
  flexDirection: 'column',
  minHeight: 0,
  overflowY: 'auto',
};

const editorHeaderStyle: React.CSSProperties = {
  display: 'flex',
  alignItems: 'baseline',
  gap: 10,
  marginBottom: 10,
};

const textareaStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 240,
  padding: 10,
  fontSize: 12,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  background: 'var(--input-bg, var(--row-hover))',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 6,
  resize: 'none',
  lineHeight: 1.5,
  whiteSpace: 'pre',
};

const fieldLabelStyle: React.CSSProperties = {
  display: 'block',
  fontSize: 11,
  color: 'var(--fg-muted)',
  marginBottom: 4,
};

const hintStyle: React.CSSProperties = {
  fontSize: 10,
  marginTop: 4,
  fontStyle: 'italic',
};

const warningBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: 'rgba(220, 38, 38, 0.08)',
  color: 'var(--danger)',
  fontSize: 12,
  borderRadius: 6,
};

const errorBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: 'rgba(220, 38, 38, 0.08)',
  color: 'var(--danger)',
  fontSize: 12,
  borderRadius: 6,
  whiteSpace: 'pre-wrap',
};

const infoBoxStyle: React.CSSProperties = {
  marginTop: 16,
  padding: '10px 12px',
  background: 'rgba(59, 130, 246, 0.08)',
  color: 'var(--fg)',
  fontSize: 12,
  borderRadius: 6,
  borderLeft: '3px solid var(--accent, #3b82f6)',
};

const footerStyle: React.CSSProperties = {
  padding: '12px 20px',
  borderTop: '1px solid var(--border)',
  display: 'flex',
  alignItems: 'center',
  gap: 8,
};

const inputStyle: React.CSSProperties = {
  padding: '6px 8px',
  fontSize: 12,
  background: 'var(--input-bg, var(--row-hover))',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  width: '100%',
  boxSizing: 'border-box',
};

// Vocabulary tab-specific styles

const sectionHeadingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
  marginTop: 4,
  marginBottom: 4,
};

const tableStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  gap: 4,
  marginBottom: 4,
};

const tableRowStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  alignItems: 'center',
};

const replacementHeaderStyle: React.CSSProperties = {
  display: 'flex',
  gap: 6,
  fontSize: 10,
  color: 'var(--fg-muted)',
  textTransform: 'uppercase',
  letterSpacing: 0.3,
  padding: '0 2px 2px',
};

const deleteButtonStyle: React.CSSProperties = {
  width: 28,
  height: 28,
  padding: 0,
  fontSize: 12,
  lineHeight: 1,
  background: 'transparent',
  border: '1px solid var(--border)',
  borderRadius: 4,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
  flex: 'none',
};

const addButtonStyle: React.CSSProperties = {
  alignSelf: 'flex-start',
  marginTop: 4,
  padding: '4px 10px',
  fontSize: 11,
  background: 'transparent',
  border: '1px dashed var(--border)',
  borderRadius: 4,
  color: 'var(--fg-muted)',
  cursor: 'pointer',
};

const notesListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 11,
  color: 'var(--fg-muted)',
  lineHeight: 1.4,
};

const termCountBadgeStyle: React.CSSProperties = {
  fontSize: 10,
  padding: '1px 6px',
  borderRadius: 8,
  background: 'var(--row-hover)',
  color: 'var(--fg-muted)',
  minWidth: 20,
  textAlign: 'center',
};

const helpCodeStyle: React.CSSProperties = {
  margin: '4px 0',
  padding: 10,
  fontSize: 10,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  background: 'var(--bg)',
  color: 'var(--fg)',
  border: '1px solid var(--border)',
  borderRadius: 4,
  whiteSpace: 'pre',
  overflowX: 'auto',
  lineHeight: 1.5,
};

// About tab styles. Kept separate from the form-style panes — About
// is closer to a docs page than a settings form, so it gets its own
// typography rather than shoehorning into inputStyle / fieldLabelStyle.

const aboutHeadingStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  marginTop: 0,
  marginBottom: 6,
  letterSpacing: -0.2,
};

const aboutLeadStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  marginTop: 0,
  marginBottom: 18,
  color: 'var(--fg)',
};

const aboutSectionStyle: React.CSSProperties = {
  marginBottom: 18,
};

const aboutSubheadingStyle: React.CSSProperties = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
  marginTop: 0,
  marginBottom: 8,
};

const aboutOrderedListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.55,
};

const aboutUnorderedListStyle: React.CSSProperties = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.55,
};

const aboutSmallTextStyle: React.CSSProperties = {
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0,
};

const aboutFooterStyle: React.CSSProperties = {
  marginTop: 24,
  paddingTop: 12,
  borderTop: '1px solid var(--border)',
  display: 'flex',
  justifyContent: 'flex-end',
};

const aboutVersionStyle: React.CSSProperties = {
  fontSize: 11,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
};

// Inline subheadings inside an aboutSection — used by the
// "Choosing a local model" section to break a long block of prose
// into 16/24/48 GB tiers without promoting them to top-level
// h3-equivalents (which would compete visually with the main
// section headings).

const aboutInlineHeadingStyle: React.CSSProperties = {
  fontSize: 12,
  fontWeight: 600,
  marginTop: 14,
  marginBottom: 4,
  color: 'var(--fg)',
};

const aboutTableStyle: React.CSSProperties = {
  width: '100%',
  borderCollapse: 'collapse',
  fontSize: 11,
  marginTop: 8,
};

const aboutTableHeaderCellStyle: React.CSSProperties = {
  textAlign: 'left',
  fontWeight: 600,
  color: 'var(--fg-muted)',
  borderBottom: '1px solid var(--border)',
  padding: '6px 6px',
  whiteSpace: 'nowrap',
};

const aboutTableCellStyle: React.CSSProperties = {
  padding: '6px 6px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--fg)',
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
};

const aboutTableCodeCellStyle: React.CSSProperties = {
  padding: '6px 6px',
  borderBottom: '1px solid var(--border)',
  color: 'var(--fg)',
  verticalAlign: 'top',
  whiteSpace: 'nowrap',
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  fontSize: 10,
};

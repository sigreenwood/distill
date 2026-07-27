import { r as reactExports, j as jsxRuntimeExports, c as createRoot } from "./styles-DDvpJv-I.js";
const KEEPALIVE_PRESETS = [
  { value: "0", label: "Off (unload immediately)" },
  { value: "5m", label: "5 minutes" },
  { value: "30m", label: "30 minutes" },
  { value: "1h", label: "1 hour" },
  { value: "24h", label: "24 hours" }
];
const WHISPER_MODEL_PRESETS = [
  { value: "mlx-community/whisper-large-v3-mlx", label: "Large v3 (best quality, slowest)" },
  { value: "mlx-community/whisper-medium-mlx", label: "Medium" },
  { value: "mlx-community/whisper-small-mlx", label: "Small" },
  { value: "mlx-community/whisper-base-mlx", label: "Base" },
  { value: "mlx-community/whisper-tiny-mlx", label: "Tiny (fastest, lowest quality)" }
];
function readTabFromHash() {
  const hash = window.location.hash.replace(/^#/, "");
  switch (hash) {
    case "sources":
    case "outputs":
    case "prompts":
    case "vocabulary":
    case "general":
    case "performance":
    case "about":
      return hash;
    default:
      return "sources";
  }
}
function Settings() {
  const [tab, setTab] = reactExports.useState(() => readTabFromHash());
  const [outputs, setOutputs] = reactExports.useState(null);
  const [prompts, setPrompts] = reactExports.useState(null);
  const [vocabularyScopes, setVocabularyScopes] = reactExports.useState(null);
  const [general, setGeneral] = reactExports.useState(null);
  const [performance, setPerformance] = reactExports.useState(null);
  const [sources, setSources] = reactExports.useState(null);
  const [loadError, setLoadError] = reactExports.useState(null);
  reactExports.useEffect(() => {
    void (async () => {
      try {
        const s = await window.distill.settings.load();
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
  reactExports.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") window.close();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
  reactExports.useEffect(() => {
    const onHashChange = () => {
      setTab(readTabFromHash());
    };
    window.addEventListener("hashchange", onHashChange);
    return () => window.removeEventListener("hashchange", onHashChange);
  }, []);
  if (loadError && (!outputs || !prompts || !vocabularyScopes || !general || !performance || !sources)) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: shellStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { padding: 24, color: "var(--danger)" }, children: [
      "Could not load settings: ",
      loadError
    ] }) });
  }
  if (!outputs || !prompts || !vocabularyScopes || !general || !performance || !sources) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: shellStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 24, color: "var(--fg-muted)" }, children: "Loading…" }) });
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: shellStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("header", { style: headerStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 600, fontSize: 14 }, children: "Settings" }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: tabBarStyle, role: "tablist", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "Sources", active: tab === "sources", onClick: () => setTab("sources") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "Outputs", active: tab === "outputs", onClick: () => setTab("outputs") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "Prompts", active: tab === "prompts", onClick: () => setTab("prompts") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "Vocabulary", active: tab === "vocabulary", onClick: () => setTab("vocabulary") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "General", active: tab === "general", onClick: () => setTab("general") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "Performance", active: tab === "performance", onClick: () => setTab("performance") }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(TabButton, { label: "About", active: tab === "about", onClick: () => setTab("about") })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "sources" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(SourcesPane, { initial: sources, onChanged: (next) => setSources(next) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "outputs" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(OutputsPane, { initial: outputs, onSaved: (next) => setOutputs(next) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "prompts" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(PromptsPane, { initial: prompts, onChanged: (next) => setPrompts(next) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "vocabulary" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
      VocabularyPane,
      {
        initialScopes: vocabularyScopes,
        onScopeSaved: (updated) => setVocabularyScopes(
          (prev) => prev ? prev.map((s) => s.id === updated.id ? updated : s) : prev
        )
      }
    ) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "general" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(GeneralPane, { initial: general, onSaved: (next) => setGeneral(next) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "performance" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(PerformancePane, { initial: performance, onSaved: (next) => setPerformance(next) }) }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: tab === "about" ? "flex" : "none", flex: 1, minHeight: 0, flexDirection: "column" }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(AboutPane, {}) })
  ] });
}
function OutputsPane(props) {
  const [outputs, setOutputs] = reactExports.useState(props.initial);
  const [error, setError] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const [savedAt, setSavedAt] = reactExports.useState(null);
  const updateOutputs = reactExports.useCallback((patch) => {
    setOutputs((prev) => ({ ...prev, ...patch }));
    setSavedAt(null);
  }, []);
  const browseFor = reactExports.useCallback(
    async (current, apply) => {
      try {
        const chosen = await window.distill.settings.browseFolder(current);
        if (chosen) apply(chosen);
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e));
      }
    },
    []
  );
  const nothingEnabled = !outputs.markdown.enabled && !outputs.html.enabled && !outputs.appleNotes.enabled;
  const onSave = reactExports.useCallback(async () => {
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
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: paneStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: paneBodyStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", style: { fontSize: 12, marginTop: 0, marginBottom: 16 }, children: "Summaries can be written to any combination of the three destinations below. Tick the ones you want; each file destination has its own folder." }),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        DestinationCard,
        {
          title: "Markdown file",
          description: "Plain .md with YAML frontmatter. Good for Obsidian, text editors, git.",
          enabled: outputs.markdown.enabled,
          onToggle: (v) => updateOutputs({ markdown: { ...outputs.markdown, enabled: v } }),
          children: outputs.markdown.enabled && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              FolderField,
              {
                label: "Folder",
                value: outputs.markdown.dir,
                onChange: (v) => updateOutputs({ markdown: { ...outputs.markdown, dir: v } }),
                onBrowse: () => void browseFor(
                  outputs.markdown.dir,
                  (next) => updateOutputs({ markdown: { ...outputs.markdown, dir: next } })
                )
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              TranscriptToggle,
              {
                checked: outputs.markdown.includeTranscript,
                onChange: (v) => updateOutputs({
                  markdown: { ...outputs.markdown, includeTranscript: v }
                })
              }
            )
          ] })
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        DestinationCard,
        {
          title: "HTML file",
          description: "Self-contained .html with basic styling. Good for emailing or archiving.",
          enabled: outputs.html.enabled,
          onToggle: (v) => updateOutputs({ html: { ...outputs.html, enabled: v } }),
          children: outputs.html.enabled && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              FolderField,
              {
                label: "Folder",
                value: outputs.html.dir,
                onChange: (v) => updateOutputs({ html: { ...outputs.html, dir: v } }),
                onBrowse: () => void browseFor(
                  outputs.html.dir,
                  (next) => updateOutputs({ html: { ...outputs.html, dir: next } })
                )
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              TranscriptToggle,
              {
                checked: outputs.html.includeTranscript,
                onChange: (v) => updateOutputs({
                  html: { ...outputs.html, includeTranscript: v }
                })
              }
            )
          ] })
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        DestinationCard,
        {
          title: "Apple Notes",
          description: "Notes are organised as {Parent folder} → {Client name} → Note.",
          enabled: outputs.appleNotes.enabled,
          onToggle: (v) => updateOutputs({ appleNotes: { ...outputs.appleNotes, enabled: v } }),
          children: outputs.appleNotes.enabled && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginTop: 10 }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: "Parent folder in Notes" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                "input",
                {
                  type: "text",
                  value: outputs.appleNotes.parentFolder,
                  onChange: (e) => updateOutputs({
                    appleNotes: {
                      ...outputs.appleNotes,
                      parentFolder: e.target.value
                    }
                  }),
                  style: inputStyle,
                  placeholder: "distill"
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: hintStyle, children: "Created automatically in your default Notes account if it doesn't exist. Requires Automation permission for Notes.app the first time you save a summary." })
            ] }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              TranscriptToggle,
              {
                checked: outputs.appleNotes.includeTranscript,
                onChange: (v) => updateOutputs({
                  appleNotes: {
                    ...outputs.appleNotes,
                    includeTranscript: v
                  }
                })
              }
            )
          ] })
        }
      ),
      nothingEnabled && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: warningBoxStyle, children: "At least one destination must be enabled, otherwise summaries have nowhere to land." }),
      error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: error })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
      savedAt && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", style: { fontSize: 11 }, "aria-live": "polite", children: "Saved." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginLeft: "auto", display: "flex", gap: 8 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Close" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onSave(),
            disabled: saving || nothingEnabled,
            children: saving ? "Saving…" : "Save"
          }
        )
      ] })
    ] })
  ] });
}
function PromptsPane(props) {
  const [prompts, setPrompts] = reactExports.useState(props.initial);
  const [selectedId, setSelectedId] = reactExports.useState(
    props.initial[0]?.id ?? ""
  );
  const [draft, setDraft] = reactExports.useState(
    props.initial[0]?.prompt ?? ""
  );
  const [error, setError] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const [savedAt, setSavedAt] = reactExports.useState(null);
  const [importing, setImporting] = reactExports.useState(false);
  const [importMessage, setImportMessage] = reactExports.useState(null);
  const [creating, setCreating] = reactExports.useState(null);
  const [createError, setCreateError] = reactExports.useState(null);
  const [createSaving, setCreateSaving] = reactExports.useState(false);
  const selected = reactExports.useMemo(
    () => prompts.find((p) => p.id === selectedId),
    [prompts, selectedId]
  );
  const switchTo = reactExports.useCallback(
    (id) => {
      const p = prompts.find((x) => x.id === id);
      if (!p) return;
      setSelectedId(id);
      setDraft(p.prompt);
      setError(null);
      setSavedAt(null);
      setCreating(null);
      setCreateError(null);
    },
    [prompts]
  );
  const openCreate = reactExports.useCallback(() => {
    setCreating({ name: "", prompt: "" });
    setCreateError(null);
  }, []);
  const onCreate = reactExports.useCallback(async () => {
    if (!creating) return;
    const name = creating.name.trim();
    const prompt = creating.prompt.trim();
    if (name.length === 0) {
      setCreateError("Name required.");
      return;
    }
    if (prompt.length === 0) {
      setCreateError("Prompt cannot be empty.");
      return;
    }
    setCreateError(null);
    setCreateSaving(true);
    try {
      const created = await window.distill.meetingTypes.add({ name, prompt });
      const next = [...prompts, created].sort(
        (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
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
  const applyUpdatedPrompt = reactExports.useCallback(
    (updated) => {
      const next = prompts.map((p) => p.id === updated.id ? updated : p);
      setPrompts(next);
      props.onChanged(next);
      if (updated.id === selectedId) setDraft(updated.prompt);
    },
    [prompts, props, selectedId]
  );
  const isDirty = selected ? draft !== selected.prompt : false;
  const onSave = reactExports.useCallback(async () => {
    if (!selected) return;
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      setError("Prompt cannot be empty.");
      return;
    }
    setError(null);
    setSaving(true);
    try {
      const updated = await window.distill.settings.savePrompt({
        id: selected.id,
        prompt: draft
      });
      applyUpdatedPrompt(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, draft, applyUpdatedPrompt]);
  const onRevert = reactExports.useCallback(async () => {
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
  const onDelete = reactExports.useCallback(async () => {
    if (!selected || selected.is_builtin) return;
    const confirmed = window.confirm(
      `Delete “${selected.name}”? This can't be undone.

Any existing recordings tagged with this prompt will be detached — their summaries on disk and inbox history are kept, but the meeting type will show as blank for those rows.`
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
        setSelectedId("");
        setDraft("");
      }
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, prompts, props]);
  const onImport = reactExports.useCallback(async () => {
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
        setSelectedId("");
        setDraft("");
      }
      setSavedAt(null);
      setImportMessage(
        `Imported ${result.created + result.updated} prompt${result.created + result.updated === 1 ? "" : "s"} (${result.created} new, ${result.updated} updated).`
      );
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [props, selectedId]);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: paneStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: promptsPaneBodyStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { style: sidebarStyle, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: sidebarLabelStyle, children: "Meeting types" }),
        prompts.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "button",
          {
            onClick: () => switchTo(p.id),
            style: {
              ...sidebarItemStyle,
              background: p.id === selectedId && !creating ? "var(--row-hover)" : "transparent",
              fontWeight: p.id === selectedId && !creating ? 500 : 400
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis" }, children: p.name }),
                p.is_modified && /* @__PURE__ */ jsxRuntimeExports.jsx(ModifiedBadge, {})
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: sidebarMetaStyle, children: [
                p.is_builtin ? "Built-in" : "User",
                " · ",
                formatRelative(p.updated_at)
              ] })
            ]
          },
          p.id
        )),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: openCreate,
            style: {
              ...addButtonStyle,
              alignSelf: "stretch",
              marginTop: 8,
              textAlign: "center",
              background: creating ? "var(--row-hover)" : "transparent",
              fontWeight: creating ? 500 : 400
            },
            title: "Create a new meeting type",
            children: "+ New prompt…"
          }
        )
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("section", { style: editorStyle, children: creating ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: editorHeaderStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontSize: 13, fontWeight: 500 }, children: "New meeting type" }) }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: "Name" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            type: "text",
            autoFocus: true,
            value: creating.name,
            onChange: (e) => {
              setCreating({ ...creating, name: e.target.value });
              setCreateError(null);
            },
            style: { ...inputStyle, marginBottom: 10 },
            placeholder: "e.g. Internal one-to-one",
            disabled: createSaving
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: "Prompt" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "textarea",
          {
            value: creating.prompt,
            onChange: (e) => {
              setCreating({ ...creating, prompt: e.target.value });
              setCreateError(null);
            },
            style: textareaStyle,
            spellCheck: false,
            placeholder: "Paste the system prompt for this meeting type…",
            disabled: createSaving
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: hintStyle, children: "The prompt is what Ollama uses as the system message when this meeting type is selected. Tip: copy an existing prompt as a starting point, then edit." }),
        createError && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: createError })
      ] }) : selected ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: editorHeaderStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontSize: 13, fontWeight: 500 }, children: selected.name }),
          selected.is_modified && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontSize: 11, color: "var(--fg-muted)" }, children: "modified from default" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "textarea",
          {
            value: draft,
            onChange: (e) => {
              setDraft(e.target.value);
              setSavedAt(null);
            },
            style: textareaStyle,
            spellCheck: false
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: hintStyle, children: "In-flight summaries keep the prompt they started with. Changes apply to new summaries only." }),
        error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: error })
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { padding: 24, fontSize: 12 }, children: "No meeting types configured." }) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
      savedAt && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", style: { fontSize: 11 }, "aria-live": "polite", children: "Saved." }),
      importMessage && !savedAt && /* @__PURE__ */ jsxRuntimeExports.jsx(
        "span",
        {
          className: "muted",
          style: { fontSize: 11 },
          "aria-live": "polite",
          children: importMessage
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginLeft: "auto", display: "flex", gap: 8 }, children: creating ? /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: () => {
              setCreating(null);
              setCreateError(null);
            },
            disabled: createSaving,
            children: "Cancel"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onCreate(),
            disabled: createSaving || creating.name.trim().length === 0 || creating.prompt.trim().length === 0,
            children: createSaving ? "Adding…" : "Add prompt"
          }
        )
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        selected?.is_builtin && selected.is_modified && /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: () => void onRevert(),
            disabled: saving || importing,
            title: "Reset this prompt to the version shipped in PROMPTS.md",
            children: "Revert to default"
          }
        ),
        selected && !selected.is_builtin && /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: () => void onDelete(),
            disabled: saving || importing,
            title: "Delete this user-created prompt",
            style: { color: "var(--danger)" },
            children: "Delete prompt"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: () => void onImport(),
            disabled: saving || importing,
            title: "Import prompts from a markdown file. Existing prompts (matched by id) are updated; new ids are added as user-created prompts.",
            children: importing ? "Importing…" : "Import…"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Close" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onSave(),
            disabled: saving || importing || !isDirty || !selected,
            children: saving ? "Saving…" : "Save prompt"
          }
        )
      ] }) })
    ] })
  ] });
}
function VocabularyPane(props) {
  const [scopes, setScopes] = reactExports.useState(
    props.initialScopes
  );
  const [selectedId, setSelectedId] = reactExports.useState(
    props.initialScopes[0]?.id ?? ""
  );
  const [file, setFile] = reactExports.useState(null);
  const [hints, setHints] = reactExports.useState([]);
  const [replacements, setReplacements] = reactExports.useState([]);
  const [loadingScope, setLoadingScope] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const [importing, setImporting] = reactExports.useState(false);
  const [exporting, setExporting] = reactExports.useState(false);
  const [savedAt, setSavedAt] = reactExports.useState(null);
  const [exportedPath, setExportedPath] = reactExports.useState(null);
  const [helpOpen, setHelpOpen] = reactExports.useState(false);
  const selected = reactExports.useMemo(
    () => scopes.find((s) => s.id === selectedId),
    [scopes, selectedId]
  );
  reactExports.useEffect(() => {
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
            requiresContext: r.requiresContext?.join(", ") ?? ""
          }))
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
  const markDirty = reactExports.useCallback(() => setSavedAt(null), []);
  const addHint = reactExports.useCallback(() => {
    setHints((h) => [...h, ""]);
    markDirty();
  }, [markDirty]);
  const updateHint = reactExports.useCallback(
    (index, value) => {
      setHints((h) => h.map((x, i) => i === index ? value : x));
      markDirty();
    },
    [markDirty]
  );
  const deleteHint = reactExports.useCallback(
    (index) => {
      setHints((h) => h.filter((_, i) => i !== index));
      markDirty();
    },
    [markDirty]
  );
  const addReplacement = reactExports.useCallback(() => {
    setReplacements((r) => [...r, { from: "", to: "", requiresContext: "" }]);
    markDirty();
  }, [markDirty]);
  const updateReplacement = reactExports.useCallback(
    (index, patch) => {
      setReplacements(
        (r) => r.map((x, i) => i === index ? { ...x, ...patch } : x)
      );
      markDirty();
    },
    [markDirty]
  );
  const deleteReplacement = reactExports.useCallback(
    (index) => {
      setReplacements((r) => r.filter((_, i) => i !== index));
      markDirty();
    },
    [markDirty]
  );
  const onSave = reactExports.useCallback(async () => {
    if (!selected) return;
    setError(null);
    setSaving(true);
    try {
      const payload = {
        whisperHints: hints,
        replacements: replacements.map(
          (r) => ({
            from: r.from,
            to: r.to,
            requiresContext: r.requiresContext.trim().length > 0 ? r.requiresContext.split(",").map((s) => s.trim()).filter((s) => s.length > 0) : void 0
          })
        )
        // Notes are preserved by main from the on-disk file. Not sent
        // from the renderer.
      };
      const updated = await window.distill.settings.saveVocabulary({
        scopeId: selected.id,
        file: payload
      });
      setScopes(
        (prev) => prev.map((s) => s.id === updated.id ? updated : s)
      );
      props.onScopeSaved(updated);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, [selected, hints, replacements, props]);
  const onImport = reactExports.useCallback(async () => {
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
          requiresContext: r.requiresContext?.join(", ") ?? ""
        }))
      );
      const updatedSummary = {
        ...selected,
        termCount: merged.whisperHints.length + merged.replacements.length
      };
      setScopes(
        (prev) => prev.map((s) => s.id === updatedSummary.id ? updatedSummary : s)
      );
      props.onScopeSaved(updatedSummary);
      setSavedAt(Date.now());
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setImporting(false);
    }
  }, [selected, props]);
  const onExport = reactExports.useCallback(async () => {
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
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: paneStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: promptsPaneBodyStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("aside", { style: sidebarStyle, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: sidebarLabelStyle, children: "Built-in packs" }),
        builtins.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          ScopeSidebarItem,
          {
            scope: s,
            active: s.id === selectedId,
            onClick: () => setSelectedId(s.id)
          },
          s.id
        )),
        clientScopes.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "div",
            {
              className: "muted",
              style: { ...sidebarLabelStyle, marginTop: 12 },
              children: "Per-client"
            }
          ),
          clientScopes.map((s) => /* @__PURE__ */ jsxRuntimeExports.jsx(
            ScopeSidebarItem,
            {
              scope: s,
              active: s.id === selectedId,
              onClick: () => setSelectedId(s.id)
            },
            s.id
          ))
        ] })
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("section", { style: editorStyle, children: !selected ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { padding: 24, fontSize: 12 }, children: "No vocabulary scopes available." }) : loadingScope ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: { padding: 12, fontSize: 12 }, children: [
        "Loading “",
        selected.label,
        "”…"
      ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: editorHeaderStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontSize: 13, fontWeight: 500 }, children: selected.label }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontSize: 11, color: "var(--fg-muted)" }, children: selected.builtin ? "Always applied" : `Client scope · ${selected.label}` }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              onClick: () => setHelpOpen((v) => !v),
              style: {
                marginLeft: "auto",
                fontSize: 11,
                padding: "2px 8px",
                background: "transparent",
                border: "1px solid var(--border)",
                borderRadius: 4,
                color: "var(--fg-muted)",
                cursor: "pointer"
              },
              title: "Show / hide the JSON schema and a worked example for this editor.",
              "aria-expanded": helpOpen,
              children: helpOpen ? "Hide help" : "Show help"
            }
          )
        ] }),
        helpOpen && /* @__PURE__ */ jsxRuntimeExports.jsx(VocabularyHelpPanel, {}),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: sectionHeadingStyle, children: "Whisper hints" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 }, children: "Terms Whisper should recognise. Written into the initial_prompt at transcription time." }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: tableStyle, children: [
          hints.length === 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { padding: "4px 2px", fontSize: 11 }, children: "No hints yet." }),
          hints.map((h, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: tableRowStyle, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                type: "text",
                value: h,
                onChange: (e) => updateHint(i, e.target.value),
                style: { ...inputStyle, flex: 1 },
                placeholder: "e.g. Acme Corp"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                onClick: () => deleteHint(i),
                style: deleteButtonStyle,
                title: "Remove this hint",
                "aria-label": "Remove hint",
                children: "✕"
              }
            )
          ] }, i)),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: addHint, style: addButtonStyle, children: "+ Add hint" })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { ...sectionHeadingStyle, marginTop: 16 }, children: "Replacement rules" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 }, children: "Post-transcription rewrites. Context words (comma-separated) are optional — when set, the rule only fires if one of those words appears elsewhere in the transcript." }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: tableStyle, children: [
          replacements.length === 0 && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { padding: "4px 2px", fontSize: 11 }, children: "No replacement rules yet." }),
          replacements.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: replacementHeaderStyle, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { flex: 2 }, children: "From" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { flex: 2 }, children: "To" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { flex: 3 }, children: "Context (csv, optional)" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { width: 28 } })
          ] }),
          replacements.map((r, i) => /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: tableRowStyle, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                type: "text",
                value: r.from,
                onChange: (e) => updateReplacement(i, { from: e.target.value }),
                style: { ...inputStyle, flex: 2 },
                placeholder: "akmee"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                type: "text",
                value: r.to,
                onChange: (e) => updateReplacement(i, { to: e.target.value }),
                style: { ...inputStyle, flex: 2 },
                placeholder: "Acme"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                type: "text",
                value: r.requiresContext,
                onChange: (e) => updateReplacement(i, { requiresContext: e.target.value }),
                style: { ...inputStyle, flex: 3 },
                placeholder: "marketing, campaign"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                onClick: () => deleteReplacement(i),
                style: deleteButtonStyle,
                title: "Remove this rule",
                "aria-label": "Remove replacement",
                children: "✕"
              }
            )
          ] }, i)),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: addReplacement, style: addButtonStyle, children: "+ Add rule" })
        ] }),
        file?.notes && file.notes.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { ...sectionHeadingStyle, marginTop: 16 }, children: "Notes" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 6 }, children: "Preserved from the JSON file on disk. Edit the file directly to change these." }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { style: notesListStyle, children: file.notes.map((n, i) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { style: { marginBottom: 4 }, children: n }, i)) })
        ] }),
        error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: error })
      ] }) })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
      savedAt && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", style: { fontSize: 11 }, "aria-live": "polite", children: "Saved." }),
      exportedPath && !savedAt && /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "span",
        {
          className: "muted",
          style: { fontSize: 11, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", maxWidth: 360 },
          "aria-live": "polite",
          title: exportedPath,
          children: [
            "Exported to ",
            exportedPath
          ]
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginLeft: "auto", display: "flex", gap: 8 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: () => void onImport(),
            disabled: importing || saving || exporting || loadingScope || !selected,
            title: "Import a vocabulary file (JSON or markdown table) and merge it into this scope. Existing entries are kept; conflicts (same `from` value) are overwritten by the imported version.",
            children: importing ? "Importing…" : "Import…"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: () => void onExport(),
            disabled: exporting || saving || importing || loadingScope || !selected,
            title: "Export this scope's saved contents to a JSON file. Uses the on-disk file, NOT any unsaved edits in the editor.",
            children: exporting ? "Exporting…" : "Export…"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Close" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onSave(),
            disabled: saving || importing || exporting || loadingScope || !selected,
            children: saving ? "Saving…" : "Save scope"
          }
        )
      ] })
    ] })
  ] });
}
function ScopeSidebarItem(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      onClick: props.onClick,
      style: {
        ...sidebarItemStyle,
        background: props.active ? "var(--row-hover)" : "transparent",
        fontWeight: props.active ? 500 : 400
      },
      children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", alignItems: "center", gap: 6 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { flex: 1, overflow: "hidden", textOverflow: "ellipsis" }, children: props.scope.label }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: termCountBadgeStyle, children: props.scope.termCount })
      ] })
    }
  );
}
function VocabularyHelpPanel() {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "section",
    {
      style: {
        border: "1px solid var(--border)",
        borderRadius: 6,
        padding: 12,
        marginBottom: 14,
        fontSize: 11,
        lineHeight: 1.5,
        background: "var(--row-hover)"
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 8 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Whisper hints" }),
          " bias the transcriber toward recognising specific terms. Use the spelling and capitalisation you want in the transcript. Examples: ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "Acme Corp" }),
          ",",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "Falcon" }),
          ", ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "QBR" }),
          ", ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "Karen Velasquez" }),
          "."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 8 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Replacement rules" }),
          " rewrite likely mistranscriptions after Whisper finishes. Each rule has a",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "from" }),
          " (what Whisper outputs incorrectly) and a",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "to" }),
          " (what we want it to be). Matched case-insensitively at word boundaries."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 8 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Context (optional)" }),
          " gates a replacement rule on other words appearing in the transcript. Use for homophones: e.g. ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "sim" }),
          " → ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "CIM" }),
          " only fires when",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "marketing" }),
          " or ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "campaign" }),
          " is also in the transcript, so phone-sim mentions stay untouched."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { ...sectionHeadingStyle, marginTop: 12 }, children: "JSON schema" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { style: helpCodeStyle, children: `{
  "$description": "Optional human-readable description.",
  "$version": 1,
  "whisperHints": ["Acme Corp", "Falcon", "QBR"],
  "replacements": [
    { "from": "acmee", "to": "Acme" },
    { "from": "sim", "to": "CIM", "requiresContext": ["marketing", "campaign"] }
  ],
  "notes": ["Optional free-text notes for humans."]
}` }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { ...sectionHeadingStyle, marginTop: 12 }, children: "Worked example" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 6 }, children: [
          "Imagine you work at Acme Corp on the Falcon database. Whisper regularly mishears ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "Acme" }),
          " as ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "acne" }),
          " and",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "Falcon" }),
          " as ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "fall come" }),
          "."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { style: helpCodeStyle, children: `{
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
}` }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginTop: 10 }, children: [
          "Save this JSON to a file and use the ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Import…" }),
          " ",
          "button below to merge it into this scope. Existing entries are kept; conflicts (same ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "from" }),
          " value) are overwritten by the imported version."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginTop: 6 }, children: [
          "Tip: if generating these by hand is tedious, paste your domain notes into ChatGPT / Claude with the prompt in",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "VOCABULARY_GENERATION_PROMPT.md" }),
          " (bundled in the app's resources directory) and ask it to produce a JSON file in this shape."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { ...sectionHeadingStyle, marginTop: 12 }, children: "Markdown table format" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginBottom: 6 }, children: [
          "Replacement rules can also be imported from a markdown file containing one or more GFM tables with the columns",
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Heard as" }),
          ", ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Should be" }),
          ", and (optionally) ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Context cue" }),
          ". Other tables in the same file (acronym glossaries, narrative tables) are skipped. Hints and notes don't come through this format — import a JSON file for those."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { style: helpCodeStyle, children: `# My team's vocabulary

| Heard as | Should be | Context cue |
|---|---|---|
| akmee | Acme | |
| fall come | Falcon | |
| sim | CIM | marketing, campaign |
` })
      ]
    }
  );
}
function GeneralPane(props) {
  const initialEnabled = props.initial.audioRetentionDays !== null;
  const initialDays = props.initial.audioRetentionDays ?? 14;
  const [enabled, setEnabled] = reactExports.useState(initialEnabled);
  const [daysText, setDaysText] = reactExports.useState(String(initialDays));
  const [error, setError] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const [savedAt, setSavedAt] = reactExports.useState(null);
  const computed = reactExports.useMemo(() => {
    if (!enabled) return { audioRetentionDays: null };
    const trimmed = daysText.trim();
    if (trimmed.length === 0) return null;
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || !Number.isInteger(parsed) || parsed < 0) {
      return null;
    }
    return { audioRetentionDays: parsed };
  }, [enabled, daysText]);
  const isDirty = reactExports.useMemo(() => {
    if (!computed) return false;
    return computed.audioRetentionDays !== props.initial.audioRetentionDays;
  }, [computed, props.initial.audioRetentionDays]);
  const onSave = reactExports.useCallback(async () => {
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
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: paneStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: paneBodyStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", style: { fontSize: 12, marginTop: 0, marginBottom: 16 }, children: "App-level settings that aren't tied to a specific output destination, prompt, or vocabulary scope." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "section",
        {
          style: {
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 500, fontSize: 13, marginBottom: 4 }, children: "Audio retention" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 10 }, children: "Imported audio (Teams recordings, voice memos, anything dragged in) is kept on disk after a summary lands. This setting controls how long. Plaud-sourced recordings are never auto-deleted — they can be re-fetched from the Plaud cloud, so deleting locally is cheap. Local imports are unique on disk, so the default is conservative." }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "label",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  fontSize: 12,
                  cursor: "pointer",
                  marginBottom: 8
                },
                children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx(
                    "input",
                    {
                      type: "checkbox",
                      checked: enabled,
                      onChange: (e) => {
                        setEnabled(e.target.checked);
                        setSavedAt(null);
                      }
                    }
                  ),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Auto-delete imported audio after a set period" })
                ]
              }
            ),
            enabled && /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "center",
                  gap: 8,
                  marginLeft: 24
                },
                children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx(
                    "input",
                    {
                      type: "number",
                      min: 0,
                      step: 1,
                      value: daysText,
                      onChange: (e) => {
                        setDaysText(e.target.value);
                        setSavedAt(null);
                      },
                      style: { ...inputStyle, width: 80 }
                    }
                  ),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontSize: 12 }, children: "days after the summary is written" })
                ]
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { ...hintStyle, marginTop: 10, marginLeft: enabled ? 24 : 0 }, children: enabled ? daysText.trim() === "0" ? "Audio is deleted as soon as the row reaches “complete”." : `Audio is deleted ${daysText || "N"} day(s) after the most recent successful output write.` : "Audio is kept indefinitely. You can sweep manually by deleting files in ~/Library/Application Support/distill/audio/." })
          ]
        }
      ),
      error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: error })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
      savedAt && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", style: { fontSize: 11 }, "aria-live": "polite", children: "Saved." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginLeft: "auto", display: "flex", gap: 8 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Close" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onSave(),
            disabled: saving || !isDirty || !computed,
            children: saving ? "Saving…" : "Save"
          }
        )
      ] })
    ] })
  ] });
}
function PerformancePane(props) {
  const [draft, setDraft] = reactExports.useState(props.initial);
  const [models, setModels] = reactExports.useState(null);
  const [ollamaError, setOllamaError] = reactExports.useState(null);
  const [loadingModels, setLoadingModels] = reactExports.useState(false);
  const [error, setError] = reactExports.useState(null);
  const [saving, setSaving] = reactExports.useState(false);
  const [savedAt, setSavedAt] = reactExports.useState(null);
  const refreshModels = reactExports.useCallback(async () => {
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
  reactExports.useEffect(() => {
    void refreshModels();
  }, [refreshModels]);
  const isDirty = draft.ollamaModel !== props.initial.ollamaModel || draft.ollamaKeepAlive !== props.initial.ollamaKeepAlive || draft.whisperModel !== props.initial.whisperModel;
  const ollamaUnreachable = ollamaError !== null;
  const canSave = !saving && isDirty && !ollamaUnreachable;
  const onSave = reactExports.useCallback(async () => {
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
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: paneStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: paneBodyStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", style: { fontSize: 12, marginTop: 0, marginBottom: 16 }, children: "Pipeline model choices. In-flight steps keep the values they started with; changes here apply to subsequent runs." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "section",
        {
          style: {
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "div",
              {
                style: {
                  display: "flex",
                  alignItems: "baseline",
                  justifyContent: "space-between",
                  gap: 8,
                  marginBottom: 4
                },
                children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 500, fontSize: 13 }, children: "Ollama model" }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx(
                    "button",
                    {
                      onClick: () => void refreshModels(),
                      disabled: loadingModels,
                      style: { fontSize: 11 },
                      title: "Re-fetch the list from Ollama",
                      children: loadingModels ? "Refreshing…" : "Refresh"
                    }
                  )
                ]
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: { fontSize: 11, marginBottom: 10 }, children: [
              "Pulled live from your local Ollama (",
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "/api/tags" }),
              "). Pull new models from a terminal with ",
              /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "ollama pull <name>" }),
              "; they appear here after Refresh."
            ] }),
            ollamaUnreachable ? /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "div",
              {
                role: "alert",
                style: {
                  ...errorBoxStyle,
                  marginTop: 0,
                  marginBottom: 6
                },
                children: [
                  ollamaError,
                  /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: { fontSize: 11, marginTop: 6 }, children: [
                    "Start Ollama and click Refresh. The current saved model is still in effect: ",
                    /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: props.initial.ollamaModel }),
                    "."
                  ] })
                ]
              }
            ) : models === null ? /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 12, padding: "4px 0" }, children: "Loading…" }) : models.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "div",
              {
                style: {
                  ...errorBoxStyle,
                  marginTop: 0,
                  marginBottom: 6
                },
                children: [
                  "Ollama is running but no models are pulled. From a terminal:",
                  /* @__PURE__ */ jsxRuntimeExports.jsx("code", { style: { display: "block", marginTop: 6 }, children: "ollama pull qwen2.5:32b" })
                ]
              }
            ) : /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "select",
              {
                value: draft.ollamaModel,
                onChange: (e) => {
                  setDraft({ ...draft, ollamaModel: e.target.value });
                  setSavedAt(null);
                },
                style: { ...inputStyle, width: "100%" },
                children: [
                  !models.some((m) => modelMatches(m.name, draft.ollamaModel)) && /* @__PURE__ */ jsxRuntimeExports.jsxs("option", { value: draft.ollamaModel, children: [
                    draft.ollamaModel,
                    " — not installed locally"
                  ] }),
                  models.map((m) => /* @__PURE__ */ jsxRuntimeExports.jsxs("option", { value: m.name, children: [
                    m.name,
                    " — ",
                    formatBytes(m.sizeBytes)
                  ] }, m.name))
                ]
              }
            )
          ]
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "section",
        {
          style: {
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 500, fontSize: 13, marginBottom: 4 }, children: "Ollama keep-alive" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 10 }, children: "How long Ollama keeps the model loaded after a summary finishes. Lower values free unified memory sooner; higher values let back-to-back summaries skip the load cost." }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "select",
              {
                value: draft.ollamaKeepAlive,
                onChange: (e) => {
                  setDraft({ ...draft, ollamaKeepAlive: e.target.value });
                  setSavedAt(null);
                },
                style: { ...inputStyle, width: "100%" },
                children: KEEPALIVE_PRESETS.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: p.value, children: p.label }, p.value))
              }
            )
          ]
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs(
        "section",
        {
          style: {
            border: "1px solid var(--border)",
            borderRadius: 8,
            padding: 12,
            marginBottom: 12
          },
          children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 500, fontSize: 13, marginBottom: 4 }, children: "Whisper model" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 10 }, children: "Larger models give better transcription, especially on names and technical terms, but use more RAM and CPU. The vocabulary system compensates somewhat for smaller models." }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "select",
              {
                value: draft.whisperModel,
                onChange: (e) => {
                  setDraft({ ...draft, whisperModel: e.target.value });
                  setSavedAt(null);
                },
                style: { ...inputStyle, width: "100%" },
                children: [
                  !WHISPER_MODEL_PRESETS.some((p) => p.value === draft.whisperModel) && /* @__PURE__ */ jsxRuntimeExports.jsxs("option", { value: draft.whisperModel, children: [
                    draft.whisperModel,
                    " — custom"
                  ] }),
                  WHISPER_MODEL_PRESETS.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: p.value, children: p.label }, p.value))
                ]
              }
            ),
            !WHISPER_MODEL_PRESETS.some((p) => p.value === draft.whisperModel) && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { ...hintStyle, marginTop: 6 }, children: "Your config currently points at a custom Whisper model. Saving will switch to the picked preset." })
          ]
        }
      ),
      error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: error })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
      savedAt && /* @__PURE__ */ jsxRuntimeExports.jsx("span", { className: "muted", style: { fontSize: 11 }, "aria-live": "polite", children: "Saved." }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginLeft: "auto", display: "flex", gap: 8 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Close" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onSave(),
            disabled: !canSave,
            title: ollamaUnreachable ? "Ollama is unreachable — start Ollama and refresh before saving" : void 0,
            children: saving ? "Saving…" : "Save"
          }
        )
      ] })
    ] })
  ] });
}
function modelMatches(name, target) {
  if (name === target) return true;
  if (name === `${target}:latest`) return true;
  if (`${name}:latest` === target) return true;
  return false;
}
function formatBytes(bytes) {
  if (!Number.isFinite(bytes) || bytes <= 0) return "?";
  const gb = bytes / (1024 * 1024 * 1024);
  if (gb >= 1) return `${gb.toFixed(1)} GB`;
  const mb = bytes / (1024 * 1024);
  return `${mb.toFixed(0)} MB`;
}
function AboutPane() {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: paneStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: { ...paneBodyStyle, maxWidth: 720 }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { style: aboutHeadingStyle, children: "distill" }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", style: aboutLeadStyle, children: "A local-first meeting summariser. Pulls recordings from a Plaud device (or files you drag in), transcribes them on your Mac, summarises them with a local language model, and writes the result to Markdown / HTML / Apple Notes — all without sending your audio or transcripts to a third-party AI service." }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { style: aboutSectionStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { style: aboutSubheadingStyle, children: "How it works" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("ol", { style: aboutOrderedListStyle, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Sync." }),
          " Polls the Plaud cloud for new recordings, or accepts files you drop into the inbox (audio or video, ffmpeg extracts the audio track)."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Transcribe." }),
          " Runs MLX Whisper locally on the audio. Your vocabulary packs (per-client and global) are baked into the prompt so technical terms come through correctly, and post-pass replacements fix known mistranscriptions."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Summarise." }),
          " Sends the transcript to your local Ollama instance with the meeting-type prompt of your choice. The summary stays on your machine."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Write." }),
          " Saves the summary (and optionally the transcript) to whichever destinations you have enabled. Idempotent per destination, so a retry only re-runs the parts that didn't land."
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { style: aboutSectionStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { style: aboutSubheadingStyle, children: "Where your data goes" }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("ul", { style: aboutUnorderedListStyle, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Plaud cloud" }),
          " — distill talks to it to list and download your own recordings. Uses the credentials you sign in with under Sources. Your password is stored in macOS Keychain."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Ollama" }),
          " — runs locally on your machine, by default at ",
          /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: "localhost:11434" }),
          ". Transcripts are sent to it for summarisation. Nothing leaves your Mac."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Hugging Face" }),
          " — contacted once per Whisper model to download model weights the first time you use them. Subsequent transcriptions run entirely offline."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("li", { children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("strong", { children: "Output destinations" }),
          " — Markdown / HTML files land in folders you configure (typically iCloud Drive or a local Documents subfolder); Apple Notes writes to your local Notes app. distill never uploads outputs anywhere on its own."
        ] })
      ] })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { style: aboutSectionStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("h3", { style: aboutSubheadingStyle, children: "Built on" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", style: aboutSmallTextStyle, children: "Electron and React for the app shell. MLX Whisper for transcription. Ollama for local language-model inference. better-sqlite3 for the inbox database. Plaud's public API for recording sync." })
    ] }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: aboutFooterStyle, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "button",
        {
          onClick: () => {
            void window.distill.app.openTipJar();
          },
          style: {
            fontSize: 11,
            background: "transparent",
            border: "none",
            color: "var(--accent, #3b82f6)",
            cursor: "pointer",
            padding: 0,
            marginRight: "auto",
            textDecoration: "underline"
          },
          title: "Open the tip jar in your default browser",
          children: "Support development"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { className: "muted", style: aboutVersionStyle, children: [
        "distill ",
        "0.0.1"
      ] })
    ] })
  ] }) });
}
function SourcesPane(props) {
  const [plaud, setPlaud] = reactExports.useState(props.initial.plaud);
  const [recentChange, setRecentChange] = reactExports.useState(null);
  const updatePlaud = reactExports.useCallback(
    (next) => {
      setPlaud(next);
      props.onChanged({ plaud: next });
    },
    [props]
  );
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: paneStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsxs("main", { style: paneBodyStyle, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("p", { className: "muted", style: { fontSize: 12, marginTop: 0, marginBottom: 16 }, children: "Sources are where distill picks up recordings. Plaud is the first one supported; more can be added later. Each source has its own sign-in and sync settings." }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      PlaudSourceCard,
      {
        status: plaud,
        onSignedIn: (next) => {
          updatePlaud(next);
          setRecentChange("signed-in");
        },
        onSignedOut: () => {
          updatePlaud({ signedIn: false });
          setRecentChange("signed-out");
        }
      }
    ),
    recentChange && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: infoBoxStyle, role: "status", children: recentChange === "signed-in" ? "Signed in. Quit and reopen distill to start syncing with this Plaud account." : "Signed out. Quit and reopen distill so the poller stops trying to use the old credentials." })
  ] }) });
}
function PlaudSourceCard(props) {
  const [email, setEmail] = reactExports.useState("");
  const [password, setPassword] = reactExports.useState("");
  const [region, setRegion] = reactExports.useState("eu");
  const [signingIn, setSigningIn] = reactExports.useState(false);
  const [signInError, setSignInError] = reactExports.useState(null);
  const [signingOut, setSigningOut] = reactExports.useState(false);
  const onSignIn = reactExports.useCallback(async () => {
    setSignInError(null);
    if (email.trim().length === 0 || password.length === 0) {
      setSignInError("Enter your email and password.");
      return;
    }
    setSigningIn(true);
    try {
      const next = await window.distill.sources.signInPlaud({
        email: email.trim(),
        password,
        region
      });
      setEmail("");
      setPassword("");
      props.onSignedIn(next);
    } catch (e) {
      setSignInError(e instanceof Error ? e.message : String(e));
    } finally {
      setSigningIn(false);
    }
  }, [email, password, region, props]);
  const onSignOut = reactExports.useCallback(async () => {
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
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "section",
    {
      style: {
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        marginBottom: 12
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 10,
              marginBottom: props.status.signedIn ? 6 : 10
            },
            children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { flex: 1 }, children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 500, fontSize: 13 }, children: "Plaud" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginTop: 2 }, children: props.status.signedIn ? "Polls api.plaud.ai for new recordings every few minutes." : "Sign in to your Plaud account to sync recordings." })
            ] })
          }
        ),
        props.status.signedIn ? /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 12,
              marginTop: 10,
              flexWrap: "wrap"
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 4 }, children: [
                /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 10, textTransform: "uppercase", letterSpacing: 0.4 }, children: "Signed in as" }),
                /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontSize: 12, fontWeight: 500 }, children: props.status.email }),
                /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: { fontSize: 11 }, children: [
                  "Region: ",
                  props.status.region.toUpperCase(),
                  props.status.tokenExpiresAt !== null && /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
                    " · token good until ",
                    new Date(props.status.tokenExpiresAt).toLocaleDateString()
                  ] })
                ] })
              ] }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginLeft: "auto", display: "flex", gap: 8 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => void onSignOut(), disabled: signingOut, children: signingOut ? "Signing out…" : "Sign out" }) }),
              signInError && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: signInError })
            ]
          }
        ) : /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 8, marginTop: 10 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: "Email" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                type: "email",
                autoComplete: "username",
                value: email,
                onChange: (e) => setEmail(e.target.value),
                style: inputStyle,
                placeholder: "you@example.com",
                disabled: signingIn
              }
            )
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: "Password" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "input",
              {
                type: "password",
                autoComplete: "current-password",
                value: password,
                onChange: (e) => setPassword(e.target.value),
                onKeyDown: (e) => {
                  if (e.key === "Enter" && !signingIn) void onSignIn();
                },
                style: inputStyle,
                disabled: signingIn
              }
            )
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: "Region" }),
            /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "select",
              {
                value: region,
                onChange: (e) => setRegion(e.target.value),
                style: { ...inputStyle, width: "100%" },
                disabled: signingIn,
                children: [
                  /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "eu", children: "EU (api-euc1.plaud.ai)" }),
                  /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "us", children: "US (api.plaud.ai)" })
                ]
              }
            )
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: { ...hintStyle, marginTop: 4 }, children: [
            "Your password is stored in macOS Keychain (service:",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: " distill.plaud" }),
            "). Email and region live in",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: " ~/.plaud/config.json" }),
            "."
          ] }),
          signInError && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { role: "alert", style: errorBoxStyle, children: signInError }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { display: "flex", gap: 8, marginTop: 4 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
            "button",
            {
              className: "primary",
              onClick: () => void onSignIn(),
              disabled: signingIn || email.trim().length === 0 || password.length === 0,
              children: signingIn ? "Signing in…" : "Sign in"
            }
          ) })
        ] })
      ]
    }
  );
}
function TabButton(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      role: "tab",
      "aria-selected": props.active,
      onClick: props.onClick,
      style: {
        ...tabButtonStyle,
        borderBottomColor: props.active ? "var(--accent, #3b82f6)" : "transparent",
        color: props.active ? "var(--fg)" : "var(--fg-muted)",
        fontWeight: props.active ? 500 : 400
      },
      children: props.label
    }
  );
}
function ModifiedBadge() {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "span",
    {
      style: {
        fontSize: 9,
        padding: "1px 5px",
        borderRadius: 3,
        background: "var(--accent, #3b82f6)",
        color: "white",
        textTransform: "uppercase",
        letterSpacing: 0.3,
        fontWeight: 600
      },
      title: "Prompt has been edited from the default",
      children: "mod"
    }
  );
}
function DestinationCard(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "section",
    {
      style: {
        border: "1px solid var(--border)",
        borderRadius: 8,
        padding: 12,
        marginBottom: 12,
        background: props.enabled ? "var(--bg)" : "var(--row-hover)"
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("label", { style: { display: "flex", gap: 10, cursor: "pointer" }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              type: "checkbox",
              checked: props.enabled,
              onChange: (e) => props.onToggle(e.target.checked),
              style: { marginTop: 2 }
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { flex: 1 }, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 500, fontSize: 13 }, children: props.title }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginTop: 2 }, children: props.description })
          ] })
        ] }),
        props.children
      ]
    }
  );
}
function FolderField(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { marginTop: 10 }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: fieldLabelStyle, children: props.label }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", gap: 6 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx(
        "input",
        {
          type: "text",
          value: props.value,
          onChange: (e) => props.onChange(e.target.value),
          style: { ...inputStyle, flex: 1 },
          placeholder: "~/Documents/distill"
        }
      ),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: props.onBrowse, children: "Browse…" })
    ] })
  ] });
}
function TranscriptToggle(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "label",
    {
      style: {
        display: "flex",
        alignItems: "center",
        gap: 8,
        marginTop: 10,
        fontSize: 12,
        cursor: "pointer"
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "input",
          {
            type: "checkbox",
            checked: props.checked,
            onChange: (e) => props.onChange(e.target.checked)
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Embed full transcript below the summary" })
      ]
    }
  );
}
function formatRelative(epochMs) {
  const diff = Date.now() - epochMs;
  if (diff < 6e4) return "just now";
  const mins = Math.floor(diff / 6e4);
  if (mins < 60) return `${mins}m ago`;
  const hours = Math.floor(mins / 60);
  if (hours < 24) return `${hours}h ago`;
  const days = Math.floor(hours / 24);
  if (days === 1) return "yesterday";
  if (days < 7) return `${days}d ago`;
  const d = new Date(epochMs);
  return d.toLocaleDateString(void 0, { day: "numeric", month: "short" });
}
const shellStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  background: "var(--bg)",
  color: "var(--fg)"
};
const headerStyle = {
  padding: "12px 20px",
  borderBottom: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  gap: 8
};
const tabBarStyle = {
  display: "flex",
  gap: 0,
  borderBottom: "1px solid var(--border)",
  padding: "0 12px"
};
const tabButtonStyle = {
  padding: "10px 16px",
  fontSize: 12,
  background: "transparent",
  border: "none",
  borderBottom: "2px solid transparent",
  cursor: "pointer",
  marginBottom: -1
};
const paneStyle = {
  display: "flex",
  flexDirection: "column",
  flex: 1,
  minHeight: 0
};
const paneBodyStyle = {
  padding: "14px 20px",
  overflowY: "auto",
  flex: 1
};
const promptsPaneBodyStyle = {
  display: "flex",
  flex: 1,
  minHeight: 0
};
const sidebarStyle = {
  width: 220,
  borderRight: "1px solid var(--border)",
  overflowY: "auto",
  padding: "10px 8px",
  display: "flex",
  flexDirection: "column",
  gap: 2
};
const sidebarLabelStyle = {
  fontSize: 10,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  padding: "4px 8px 8px"
};
const sidebarItemStyle = {
  textAlign: "left",
  padding: "8px 10px",
  border: "none",
  borderRadius: 4,
  cursor: "pointer",
  fontSize: 12,
  color: "var(--fg)",
  lineHeight: 1.3
};
const sidebarMetaStyle = {
  fontSize: 10,
  marginTop: 2
};
const editorStyle = {
  flex: 1,
  padding: "14px 20px",
  display: "flex",
  flexDirection: "column",
  minHeight: 0,
  overflowY: "auto"
};
const editorHeaderStyle = {
  display: "flex",
  alignItems: "baseline",
  gap: 10,
  marginBottom: 10
};
const textareaStyle = {
  flex: 1,
  minHeight: 240,
  padding: 10,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  background: "var(--input-bg, var(--row-hover))",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 6,
  resize: "none",
  lineHeight: 1.5,
  whiteSpace: "pre"
};
const fieldLabelStyle = {
  display: "block",
  fontSize: 11,
  color: "var(--fg-muted)",
  marginBottom: 4
};
const hintStyle = {
  fontSize: 10,
  marginTop: 4,
  fontStyle: "italic"
};
const warningBoxStyle = {
  marginTop: 16,
  padding: "10px 12px",
  background: "rgba(220, 38, 38, 0.08)",
  color: "var(--danger)",
  fontSize: 12,
  borderRadius: 6
};
const errorBoxStyle = {
  marginTop: 16,
  padding: "10px 12px",
  background: "rgba(220, 38, 38, 0.08)",
  color: "var(--danger)",
  fontSize: 12,
  borderRadius: 6,
  whiteSpace: "pre-wrap"
};
const infoBoxStyle = {
  marginTop: 16,
  padding: "10px 12px",
  background: "rgba(59, 130, 246, 0.08)",
  color: "var(--fg)",
  fontSize: 12,
  borderRadius: 6,
  borderLeft: "3px solid var(--accent, #3b82f6)"
};
const footerStyle = {
  padding: "12px 20px",
  borderTop: "1px solid var(--border)",
  display: "flex",
  alignItems: "center",
  gap: 8
};
const inputStyle = {
  padding: "6px 8px",
  fontSize: 12,
  background: "var(--input-bg, var(--row-hover))",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  width: "100%",
  boxSizing: "border-box"
};
const sectionHeadingStyle = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--fg-muted)",
  marginTop: 4,
  marginBottom: 4
};
const tableStyle = {
  display: "flex",
  flexDirection: "column",
  gap: 4,
  marginBottom: 4
};
const tableRowStyle = {
  display: "flex",
  gap: 6,
  alignItems: "center"
};
const replacementHeaderStyle = {
  display: "flex",
  gap: 6,
  fontSize: 10,
  color: "var(--fg-muted)",
  textTransform: "uppercase",
  letterSpacing: 0.3,
  padding: "0 2px 2px"
};
const deleteButtonStyle = {
  width: 28,
  height: 28,
  padding: 0,
  fontSize: 12,
  lineHeight: 1,
  background: "transparent",
  border: "1px solid var(--border)",
  borderRadius: 4,
  color: "var(--fg-muted)",
  cursor: "pointer",
  flex: "none"
};
const addButtonStyle = {
  alignSelf: "flex-start",
  marginTop: 4,
  padding: "4px 10px",
  fontSize: 11,
  background: "transparent",
  border: "1px dashed var(--border)",
  borderRadius: 4,
  color: "var(--fg-muted)",
  cursor: "pointer"
};
const notesListStyle = {
  margin: 0,
  paddingLeft: 20,
  fontSize: 11,
  color: "var(--fg-muted)",
  lineHeight: 1.4
};
const termCountBadgeStyle = {
  fontSize: 10,
  padding: "1px 6px",
  borderRadius: 8,
  background: "var(--row-hover)",
  color: "var(--fg-muted)",
  minWidth: 20,
  textAlign: "center"
};
const helpCodeStyle = {
  margin: "4px 0",
  padding: 10,
  fontSize: 10,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  background: "var(--bg)",
  color: "var(--fg)",
  border: "1px solid var(--border)",
  borderRadius: 4,
  whiteSpace: "pre",
  overflowX: "auto",
  lineHeight: 1.5
};
const aboutHeadingStyle = {
  fontSize: 20,
  fontWeight: 600,
  marginTop: 0,
  marginBottom: 6,
  letterSpacing: -0.2
};
const aboutLeadStyle = {
  fontSize: 13,
  lineHeight: 1.5,
  marginTop: 0,
  marginBottom: 18,
  color: "var(--fg)"
};
const aboutSectionStyle = {
  marginBottom: 18
};
const aboutSubheadingStyle = {
  fontSize: 11,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--fg-muted)",
  marginTop: 0,
  marginBottom: 8
};
const aboutOrderedListStyle = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.55
};
const aboutUnorderedListStyle = {
  margin: 0,
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.55
};
const aboutSmallTextStyle = {
  fontSize: 12,
  lineHeight: 1.5,
  margin: 0
};
const aboutFooterStyle = {
  marginTop: 24,
  paddingTop: 12,
  borderTop: "1px solid var(--border)",
  display: "flex",
  justifyContent: "flex-end"
};
const aboutVersionStyle = {
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace'
};
const root = document.getElementById("root");
if (!root) throw new Error("Settings renderer: #root not found");
createRoot(root).render(/* @__PURE__ */ jsxRuntimeExports.jsx(Settings, {}));

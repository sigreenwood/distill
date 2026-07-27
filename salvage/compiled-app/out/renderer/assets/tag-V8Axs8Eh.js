import { r as reactExports, j as jsxRuntimeExports, c as createRoot, R as React } from "./styles-DDvpJv-I.js";
function Tag() {
  const recordingId = reactExports.useMemo(() => window.distill.tag.getSheetRecordingId(), []);
  const [state, setState] = reactExports.useState({ kind: "loading" });
  const [selectedClientId, setSelectedClientId] = reactExports.useState("");
  const [selectedMeetingTypeId, setSelectedMeetingTypeId] = reactExports.useState("");
  const [addClient, setAddClient] = reactExports.useState({ open: false });
  const [addMeetingType, setAddMeetingType] = reactExports.useState({ open: false });
  const [saving, setSaving] = reactExports.useState(false);
  const [saveError, setSaveError] = reactExports.useState(null);
  reactExports.useEffect(() => {
    (async () => {
      try {
        const [clients2, meetingTypes2] = await Promise.all([
          window.distill.clients.list(),
          window.distill.meetingTypes.list()
        ]);
        setState({ kind: "ready", clients: clients2, meetingTypes: meetingTypes2 });
        if (clients2[0]) setSelectedClientId(clients2[0].id);
        if (meetingTypes2[0]) setSelectedMeetingTypeId(meetingTypes2[0].id);
      } catch (e) {
        setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
      }
    })();
  }, []);
  reactExports.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") {
        window.close();
      } else if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
        void onSave();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [selectedClientId, selectedMeetingTypeId, recordingId]);
  const onAddClient = reactExports.useCallback(async () => {
    if (!addClient.open) return;
    const name = addClient.name.trim();
    if (!name) {
      setAddClient({ ...addClient, error: "Name required" });
      return;
    }
    setAddClient({ ...addClient, saving: true, error: null });
    try {
      const created = await window.distill.clients.add({ name });
      setState(
        (prev) => prev.kind === "ready" ? { ...prev, clients: [...prev.clients, created].sort((a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)) } : prev
      );
      setSelectedClientId(created.id);
      setAddClient({ open: false });
    } catch (e) {
      setAddClient({ ...addClient, saving: false, error: e instanceof Error ? e.message : String(e) });
    }
  }, [addClient]);
  const onAddMeetingType = reactExports.useCallback(async () => {
    if (!addMeetingType.open) return;
    const name = addMeetingType.name.trim();
    const prompt = addMeetingType.prompt.trim();
    if (!name) {
      setAddMeetingType({ ...addMeetingType, error: "Name required" });
      return;
    }
    if (!prompt) {
      setAddMeetingType({ ...addMeetingType, error: "Prompt required" });
      return;
    }
    setAddMeetingType({ ...addMeetingType, saving: true, error: null });
    try {
      const created = await window.distill.meetingTypes.add({ name, prompt });
      setState(
        (prev) => prev.kind === "ready" ? {
          ...prev,
          meetingTypes: [...prev.meetingTypes, created].sort(
            (a, b) => a.sort_order - b.sort_order || a.name.localeCompare(b.name)
          )
        } : prev
      );
      setSelectedMeetingTypeId(created.id);
      setAddMeetingType({ open: false });
    } catch (e) {
      setAddMeetingType({
        ...addMeetingType,
        saving: false,
        error: e instanceof Error ? e.message : String(e)
      });
    }
  }, [addMeetingType]);
  const onSave = reactExports.useCallback(async () => {
    if (!recordingId || !selectedClientId || !selectedMeetingTypeId) return;
    setSaving(true);
    setSaveError(null);
    try {
      await window.distill.tag.save({ recordingId, clientId: selectedClientId, meetingTypeId: selectedMeetingTypeId });
      window.close();
    } catch (e) {
      setSaveError(e instanceof Error ? e.message : String(e));
      setSaving(false);
    }
  }, [recordingId, selectedClientId, selectedMeetingTypeId]);
  if (!recordingId) {
    return wrap(
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { padding: 24 }, children: [
        "Missing recording id. This window should be opened from the inbox.",
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginTop: 12 }, children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Close" }) })
      ] })
    );
  }
  if (state.kind === "loading") {
    return wrap(/* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 24, color: "var(--fg-muted)" }, children: "Loading…" }));
  }
  if (state.kind === "error") {
    return wrap(
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { padding: 24 }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("div", { children: "Could not load clients or meeting types." }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            className: "muted",
            style: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11, marginTop: 8 },
            children: state.message
          }
        )
      ] })
    );
  }
  const { clients, meetingTypes } = state;
  return wrap(
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { padding: 16, display: "flex", flexDirection: "column", gap: 14 }, children: [
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("label", { children: "Client" }),
        addClient.open ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              type: "text",
              autoFocus: true,
              placeholder: "New client name",
              value: addClient.name,
              onChange: (e) => setAddClient({ ...addClient, name: e.target.value }),
              onKeyDown: (e) => {
                if (e.key === "Enter") void onAddClient();
                if (e.key === "Escape") setAddClient({ open: false });
                e.stopPropagation();
              }
            }
          ),
          addClient.error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { color: "var(--danger)", fontSize: 11 }, children: addClient.error }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: () => void onAddClient(), disabled: addClient.saving, children: addClient.saving ? "Adding…" : "Add" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => setAddClient({ open: false }), children: "Cancel" })
          ] })
        ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "select",
          {
            value: selectedClientId,
            onChange: (e) => {
              const v = e.target.value;
              if (v === "__add__") {
                setAddClient({ open: true, name: "", saving: false, error: null });
              } else {
                setSelectedClientId(v);
              }
            },
            children: [
              clients.map((c) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: c.id, children: c.name }, c.id)),
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { disabled: true, children: "────────────" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "__add__", children: "+ Add new client…" })
            ]
          }
        )
      ] }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("label", { children: "Meeting type" }),
        addMeetingType.open ? /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", gap: 6 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "input",
            {
              type: "text",
              autoFocus: true,
              placeholder: "Meeting type name",
              value: addMeetingType.name,
              onChange: (e) => setAddMeetingType({ ...addMeetingType, name: e.target.value })
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("label", { style: { marginTop: 4 }, children: "Prompt" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "textarea",
            {
              placeholder: "Paste the system prompt here",
              value: addMeetingType.prompt,
              onChange: (e) => setAddMeetingType({ ...addMeetingType, prompt: e.target.value })
            }
          ),
          addMeetingType.error && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { color: "var(--danger)", fontSize: 11 }, children: addMeetingType.error }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx(
              "button",
              {
                className: "primary",
                onClick: () => void onAddMeetingType(),
                disabled: addMeetingType.saving,
                children: addMeetingType.saving ? "Adding…" : "Add"
              }
            ),
            /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => setAddMeetingType({ open: false }), children: "Cancel" })
          ] })
        ] }) : /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "select",
          {
            value: selectedMeetingTypeId,
            onChange: (e) => {
              const v = e.target.value;
              if (v === "__add__") {
                setAddMeetingType({ open: true, name: "", prompt: "", saving: false, error: null });
              } else {
                setSelectedMeetingTypeId(v);
              }
            },
            children: [
              meetingTypes.map((m) => /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: m.id, children: m.name }, m.id)),
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { disabled: true, children: "────────────" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("option", { value: "__add__", children: "+ Add new meeting type…" })
            ]
          }
        )
      ] }),
      saveError && /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { color: "var(--danger)", fontSize: 12, marginTop: -6 }, children: saveError }),
      /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", style: { justifyContent: "flex-end", marginTop: "auto" }, children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => window.close(), children: "Cancel" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: () => void onSave(),
            disabled: saving || !selectedClientId || !selectedMeetingTypeId || addClient.open || addMeetingType.open,
            children: saving ? "Saving…" : "Save & process"
          }
        )
      ] })
    ] })
  );
}
function wrap(children) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { display: "flex", flexDirection: "column", height: "100%" }, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(
      "header",
      {
        style: {
          padding: "10px 14px",
          borderBottom: "1px solid var(--border)",
          fontWeight: 600
        },
        children: "Tag recording"
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx("main", { style: { flexGrow: 1, overflow: "auto", display: "flex", flexDirection: "column" }, children })
  ] });
}
const root = createRoot(document.getElementById("root"));
root.render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(React.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(Tag, {}) })
);

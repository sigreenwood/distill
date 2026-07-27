import { r as reactExports, j as jsxRuntimeExports, c as createRoot, R as React } from "./styles-DDvpJv-I.js";
function formatDuration(seconds) {
  if (seconds == null) return "—";
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor(s % 3600 / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, "0")}m`;
  if (m > 0) return `${m}m${r.toString().padStart(2, "0")}s`;
  return `${r}s`;
}
function formatWhen(startTimeMs, fallbackEpochMs) {
  const ms = startTimeMs != null ? startTimeMs : fallbackEpochMs;
  const d = new Date(ms);
  const now = /* @__PURE__ */ new Date();
  const sameDay = d.getFullYear() === now.getFullYear() && d.getMonth() === now.getMonth() && d.getDate() === now.getDate();
  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday = d.getFullYear() === yesterday.getFullYear() && d.getMonth() === yesterday.getMonth() && d.getDate() === yesterday.getDate();
  const hm = `${d.getHours().toString().padStart(2, "0")}:${d.getMinutes().toString().padStart(2, "0")}`;
  if (sameDay) return `Today ${hm}`;
  if (isYesterday) return `Yesterday ${hm}`;
  const weekday = d.toLocaleDateString(void 0, { weekday: "short" });
  const day = d.getDate();
  const month = d.toLocaleDateString(void 0, { month: "short" });
  return `${weekday} ${day} ${month} ${hm}`;
}
function Inbox() {
  const [state, setState] = reactExports.useState({ kind: "loading" });
  const [focusedId, setFocusedId] = reactExports.useState(null);
  const [refreshing, setRefreshing] = reactExports.useState(false);
  const [dragOver, setDragOver] = reactExports.useState(false);
  const [importQueue, setImportQueue] = reactExports.useState([]);
  const importQueueRef = reactExports.useRef([]);
  const importLoopRunningRef = reactExports.useRef(false);
  const [tipJar, setTipJar] = reactExports.useState(null);
  const refresh = reactExports.useCallback(async () => {
    setRefreshing(true);
    try {
      const list = await window.distill.inbox.list();
      setState({ kind: "ready", recordings: list });
    } catch (e) {
      setState({ kind: "error", message: e instanceof Error ? e.message : String(e) });
    } finally {
      setRefreshing(false);
    }
  }, []);
  reactExports.useEffect(() => {
    void refresh();
    const off = window.distill.onInboxChanged(() => {
      void refresh();
    });
    return off;
  }, [refresh]);
  reactExports.useEffect(() => {
    const load = async () => {
      try {
        const status = await window.distill.app.getTipJarStatus();
        setTipJar(status);
      } catch (e) {
        console.warn("failed to read tip-jar status", e);
      }
    };
    void load();
    const off = window.distill.onInboxChanged(() => {
      void load();
    });
    return off;
  }, []);
  const onDismissTipJar = reactExports.useCallback(async () => {
    setTipJar(
      (prev) => prev ? { ...prev, bannerDismissed: true, shouldShowBanner: false } : prev
    );
    try {
      await window.distill.app.dismissTipJarBanner();
    } catch (e) {
      console.warn("failed to dismiss tip-jar banner", e);
    }
  }, []);
  const onOpenTipJar = reactExports.useCallback(() => {
    void window.distill.app.openTipJar();
  }, []);
  reactExports.useEffect(() => {
    return window.distill.onFocusRecording((id) => {
      setFocusedId(id);
      requestAnimationFrame(() => {
        document.getElementById(`recording-${id}`)?.scrollIntoView({ behavior: "smooth", block: "center" });
      });
    });
  }, []);
  reactExports.useEffect(() => {
    const onKey = (e) => {
      if (e.key === "Escape") window.close();
      if ((e.metaKey || e.ctrlKey) && e.key === "r") {
        e.preventDefault();
        void refresh();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [refresh]);
  const onSkip = reactExports.useCallback(async (id) => {
    try {
      await window.distill.inbox.skip(id);
      setState(
        (prev) => prev.kind === "ready" ? { kind: "ready", recordings: prev.recordings.filter((r) => r.id !== id) } : prev
      );
    } catch (e) {
      alert(`Could not skip: ${e instanceof Error ? e.message : String(e)}`);
    }
  }, []);
  const onTag = reactExports.useCallback((id) => {
    void window.distill.tag.open(id).catch((e) => alert(`Could not open tag sheet: ${String(e)}`));
  }, []);
  const onCancel = reactExports.useCallback((id) => {
    void window.distill.pipeline.cancel(id).catch((e) => alert(`Could not cancel: ${String(e)}`));
  }, []);
  const onRetry = reactExports.useCallback((id) => {
    void window.distill.pipeline.retry(id).catch((e) => alert(`Could not retry: ${String(e)}`));
  }, []);
  const onReveal = reactExports.useCallback((id) => {
    void window.distill.inbox.revealInFinder(id).catch((e) => alert(`Could not reveal: ${String(e)}`));
  }, []);
  const onOpenSources = reactExports.useCallback(() => {
    void window.distill.app.openSettings({ tab: "sources" }).catch((e) => alert(`Could not open Settings: ${String(e)}`));
  }, []);
  const enqueueImports = reactExports.useCallback((paths) => {
    if (paths.length === 0) return;
    const newEntries = paths.map((p) => ({
      sourcePath: p,
      status: "queued",
      phase: null,
      percent: null,
      error: null
    }));
    setImportQueue((prev) => {
      const next = [...prev, ...newEntries];
      importQueueRef.current = next;
      return next;
    });
    void runImportLoop();
  }, []);
  const runImportLoop = reactExports.useCallback(async () => {
    if (importLoopRunningRef.current) return;
    importLoopRunningRef.current = true;
    try {
      while (true) {
        const next = importQueueRef.current.find((e) => e.status === "queued");
        if (!next) break;
        importQueueRef.current = importQueueRef.current.map(
          (e) => e.sourcePath === next.sourcePath && e.status === "queued" ? { ...e, status: "active" } : e
        );
        setImportQueue(importQueueRef.current);
        try {
          const { recordingId } = await window.distill.localImport.importPath(
            next.sourcePath
          );
          setFocusedId(recordingId);
          importQueueRef.current = importQueueRef.current.filter(
            (e) => e.sourcePath !== next.sourcePath
          );
          setImportQueue(importQueueRef.current);
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          importQueueRef.current = importQueueRef.current.map(
            (entry) => entry.sourcePath === next.sourcePath ? { ...entry, status: "error", error: msg } : entry
          );
          setImportQueue(importQueueRef.current);
        }
      }
    } finally {
      importLoopRunningRef.current = false;
    }
  }, []);
  const dismissQueueEntry = reactExports.useCallback((sourcePath) => {
    importQueueRef.current = importQueueRef.current.filter(
      (e) => e.sourcePath !== sourcePath
    );
    setImportQueue(importQueueRef.current);
  }, []);
  const onPickAndImport = reactExports.useCallback(async () => {
    let paths;
    try {
      paths = await window.distill.localImport.pickFiles();
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      enqueueImports([]);
      setImportQueue((prev) => [
        ...prev,
        {
          sourcePath: "(picker)",
          status: "error",
          phase: null,
          percent: null,
          error: `Could not open picker: ${msg}`
        }
      ]);
      return;
    }
    enqueueImports(paths);
  }, [enqueueImports]);
  const onDragOver = reactExports.useCallback((e) => {
    if (e.dataTransfer.types.includes("Files")) {
      e.preventDefault();
      e.dataTransfer.dropEffect = "copy";
      setDragOver(true);
    }
  }, []);
  const onDragLeave = reactExports.useCallback((e) => {
    if (!e.relatedTarget) setDragOver(false);
  }, []);
  const onDrop = reactExports.useCallback(
    (e) => {
      e.preventDefault();
      setDragOver(false);
      const files = Array.from(e.dataTransfer.files);
      if (files.length === 0) return;
      const paths = [];
      const failed = [];
      for (const f of files) {
        const p = window.distill.localImport.getPathForFile(f);
        if (p) paths.push(p);
        else failed.push(f.name);
      }
      if (failed.length > 0) {
        setImportQueue((prev) => [
          ...prev,
          {
            sourcePath: `(drop) ${failed.join(", ")}`,
            status: "error",
            phase: null,
            percent: null,
            error: `Could not resolve ${failed.length} file(s) to a path. This usually means they came from a sandboxed source. Try the + button instead.`
          }
        ]);
      }
      enqueueImports(paths);
    },
    [enqueueImports]
  );
  reactExports.useEffect(() => {
    return window.distill.onLocalImportProgress((p) => {
      importQueueRef.current = importQueueRef.current.map(
        (e) => e.sourcePath === p.sourcePath && e.status === "active" ? { ...e, phase: p.phase, percent: p.percent } : e
      );
      setImportQueue(importQueueRef.current);
    });
  }, []);
  const sections = reactExports.useMemo(() => bucket(state), [state]);
  if (state.kind === "loading") {
    return /* @__PURE__ */ jsxRuntimeExports.jsx(
      Shell,
      {
        refreshing,
        onRefresh: refresh,
        total: 0,
        dragOver,
        importQueue,
        dismissQueueEntry,
        onPickAndImport,
        onDragOver,
        onDragLeave,
        onDrop,
        tipJar,
        onDismissTipJar,
        onOpenTipJar,
        children: /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 24, color: "var(--fg-muted)", textAlign: "center" }, children: "Loading…" })
      }
    );
  }
  if (state.kind === "error") {
    return /* @__PURE__ */ jsxRuntimeExports.jsx(
      Shell,
      {
        refreshing,
        onRefresh: refresh,
        total: 0,
        dragOver,
        importQueue,
        dismissQueueEntry,
        onPickAndImport,
        onDragOver,
        onDragLeave,
        onDrop,
        tipJar,
        onDismissTipJar,
        onOpenTipJar,
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { padding: 24 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { marginBottom: 12 }, children: "Could not load the inbox." }),
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "div",
            {
              className: "muted",
              style: { fontFamily: "ui-monospace, Menlo, monospace", fontSize: 11 },
              children: state.message
            }
          ),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { style: { marginTop: 12 }, onClick: () => void refresh(), children: "Retry" })
        ] })
      }
    );
  }
  const headerCount = sections.processing.length + sections.waiting.length + sections.errored.length + sections.cancelled.length;
  const total = state.recordings.length;
  if (total === 0) {
    return /* @__PURE__ */ jsxRuntimeExports.jsx(
      Shell,
      {
        refreshing,
        onRefresh: refresh,
        total: 0,
        dragOver,
        importQueue,
        dismissQueueEntry,
        onPickAndImport,
        onDragOver,
        onDragLeave,
        onDrop,
        tipJar,
        onDismissTipJar,
        onOpenTipJar,
        children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            style: {
              padding: 32,
              color: "var(--fg-muted)",
              textAlign: "center",
              fontSize: 12
            },
            children: [
              "Nothing here.",
              /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
              "New recordings will show up as Plaud syncs.",
              /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { fontStyle: "italic" }, children: "Or drop an mp3/mp4 here to import." })
            ]
          }
        )
      }
    );
  }
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    Shell,
    {
      refreshing,
      onRefresh: refresh,
      total: headerCount,
      dragOver,
      importQueue,
      dismissQueueEntry,
      onPickAndImport,
      onDragOver,
      onDragLeave,
      onDrop,
      tipJar,
      onDismissTipJar,
      onOpenTipJar,
      children: [
        sections.processing.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "Processing", count: sections.processing.length, children: sections.processing.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsx(ProcessingRow, { r, focused: focusedId === r.id, onCancel }, r.id)) }),
        sections.waiting.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "Waiting to tag", count: sections.waiting.length, children: sections.waiting.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsx(WaitingRow, { r, focused: focusedId === r.id, onTag, onSkip }, r.id)) }),
        sections.errored.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "Errors", count: sections.errored.length, children: sections.errored.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          ErrorRow,
          {
            r,
            focused: focusedId === r.id,
            onRetry,
            onSkip,
            onOpenSources
          },
          r.id
        )) }),
        sections.cancelled.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "Cancelled", count: sections.cancelled.length, children: sections.cancelled.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsx(CancelledRow, { r, focused: focusedId === r.id, onRetry, onSkip }, r.id)) }),
        sections.complete.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(Section, { title: "Recent", count: sections.complete.length, defaultCollapsed: true, children: sections.complete.map((r) => /* @__PURE__ */ jsxRuntimeExports.jsx(CompleteRow, { r, focused: focusedId === r.id, onReveal, onSkip }, r.id)) })
      ]
    }
  );
}
function bucket(state) {
  const out = {
    processing: [],
    waiting: [],
    errored: [],
    cancelled: [],
    complete: []
  };
  if (state.kind !== "ready") return out;
  for (const r of state.recordings) {
    switch (r.status) {
      case "tagged":
      case "downloading":
      case "transcribing":
      case "summarising":
      case "writing":
        out.processing.push(r);
        break;
      case "inbox":
        out.waiting.push(r);
        break;
      case "error":
        out.errored.push(r);
        break;
      case "cancelled":
        out.cancelled.push(r);
        break;
      case "complete":
        out.complete.push(r);
        break;
    }
  }
  return out;
}
function Shell(props) {
  const activeOrQueued = props.importQueue.filter(
    (e) => e.status === "queued" || e.status === "active"
  ).length;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      style: {
        display: "flex",
        flexDirection: "column",
        height: "100%",
        position: "relative"
      },
      onDragOver: props.onDragOver,
      onDragLeave: props.onDragLeave,
      onDrop: (e) => void props.onDrop(e),
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "header",
          {
            style: {
              padding: "10px 14px",
              borderBottom: "1px solid var(--border)",
              display: "flex",
              alignItems: "center",
              gap: 8
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { fontWeight: 600 }, children: "Inbox" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { marginLeft: "auto", fontSize: 11 }, children: props.total > 0 ? `${props.total} total` : "" }),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                HeaderButton,
                {
                  title: "Import audio or video…",
                  onClick: () => void props.onPickAndImport(),
                  children: "+"
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(
                HeaderButton,
                {
                  title: "Refresh (⌘R)",
                  onClick: () => void props.onRefresh(),
                  disabled: props.refreshing,
                  children: props.refreshing ? "⋯" : "↻"
                }
              ),
              /* @__PURE__ */ jsxRuntimeExports.jsx(HeaderButton, { title: "Close (Esc)", onClick: () => window.close(), children: "×" })
            ]
          }
        ),
        props.tipJar && props.tipJar.shouldShowBanner && /* @__PURE__ */ jsxRuntimeExports.jsx(
          TipJarBanner,
          {
            status: props.tipJar,
            onDismiss: () => void props.onDismissTipJar(),
            onOpen: props.onOpenTipJar
          }
        ),
        props.importQueue.length > 0 && /* @__PURE__ */ jsxRuntimeExports.jsx(
          ImportQueuePanel,
          {
            entries: props.importQueue,
            onDismiss: props.dismissQueueEntry,
            activeOrQueued
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("main", { style: { flexGrow: 1, overflowY: "auto" }, children: props.children }),
        props.dragOver && /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            style: {
              position: "absolute",
              inset: 0,
              pointerEvents: "none",
              border: "3px dashed var(--accent)",
              background: "rgba(59, 130, 246, 0.08)",
              display: "flex",
              alignItems: "center",
              justifyContent: "center",
              zIndex: 10
            },
            children: /* @__PURE__ */ jsxRuntimeExports.jsxs(
              "div",
              {
                style: {
                  padding: "16px 24px",
                  background: "var(--bg)",
                  border: "1px solid var(--border)",
                  borderRadius: 8,
                  textAlign: "center",
                  fontSize: 13,
                  fontWeight: 500
                },
                children: [
                  "Drop to import",
                  /* @__PURE__ */ jsxRuntimeExports.jsxs(
                    "div",
                    {
                      className: "muted",
                      style: { fontSize: 11, fontWeight: 400, marginTop: 4 },
                      children: [
                        "Audio: mp3 m4a wav aac ogg flac opus",
                        /* @__PURE__ */ jsxRuntimeExports.jsx("br", {}),
                        "Video: mp4 mov m4v mkv webm (needs ffmpeg)"
                      ]
                    }
                  )
                ]
              }
            )
          }
        )
      ]
    }
  );
}
function Section(props) {
  const [collapsed, setCollapsed] = reactExports.useState(props.defaultCollapsed ?? false);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { children: [
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "button",
      {
        type: "button",
        onClick: () => setCollapsed((c) => !c),
        style: {
          // Style the header as a clickable banner. We previously used
          // `all: 'unset'` here as a one-line reset, but that interacted
          // badly with the surrounding styles in some browser versions
          // (the click target became unreliable for the Recent section
          // specifically). Spelling out the resets we want avoids that
          // and keeps the visual identical.
          appearance: "none",
          WebkitAppearance: "none",
          border: "none",
          margin: 0,
          textAlign: "left",
          font: "inherit",
          display: "block",
          width: "100%",
          boxSizing: "border-box",
          cursor: "pointer",
          padding: "8px 14px 4px",
          fontSize: 10,
          fontWeight: 600,
          letterSpacing: "0.05em",
          textTransform: "uppercase",
          color: "var(--fg-muted)",
          borderTop: "1px solid var(--border)",
          background: "var(--row-hover)"
        },
        "aria-expanded": !collapsed,
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(
            "span",
            {
              "aria-hidden": "true",
              style: {
                display: "inline-block",
                width: 10,
                marginRight: 4,
                // Rotated triangle, no font dependency. Plain ASCII chevron
                // would also work but the triangle scales nicely with font size.
                transform: collapsed ? "rotate(0deg)" : "rotate(90deg)",
                transition: "transform 120ms"
              },
              children: "▸"
            }
          ),
          props.title,
          " ",
          /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { style: { fontWeight: 400 }, children: [
            "· ",
            props.count
          ] })
        ]
      }
    ),
    !collapsed && /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { style: { listStyle: "none", margin: 0, padding: 0 }, children: props.children })
  ] });
}
function Row(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "li",
    {
      id: `recording-${props.id}`,
      style: {
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: props.focused ? "var(--row-hover)" : "transparent"
      },
      children: props.children
    }
  );
}
function Title({ r }) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "ellipsis", style: { fontWeight: 500, marginBottom: 2 }, children: r.filename });
}
function MetaLine({ r }) {
  const tag = r.clientName && r.meetingTypeName ? `${r.clientName} · ${r.meetingTypeName}` : null;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "muted", style: { fontSize: 11, marginBottom: 8 }, children: [
    formatWhen(r.start_time, r.synced_at),
    " · ",
    formatDuration(r.duration_seconds),
    tag ? ` · ${tag}` : ""
  ] });
}
function ProcessingRow(props) {
  const { r } = props;
  const stepLabel = r.status === "tagged" ? "Queued" : humanStep(r.currentStep) + "…";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Row, { id: r.id, focused: props.focused, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Title, { r }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(MetaLine, { r }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        style: {
          display: "flex",
          alignItems: "center",
          gap: 8,
          fontSize: 11,
          color: "var(--accent)",
          marginBottom: 8
        },
        children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx(Spinner, {}),
          /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: stepLabel })
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "row", children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => props.onCancel(r.id), children: "Cancel" }) })
  ] });
}
function WaitingRow(props) {
  const lengthHint = describeDurationRisk(props.r.duration_seconds);
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Row, { id: props.r.id, focused: props.focused, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Title, { r: props.r }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(MetaLine, { r: props.r }),
    lengthHint && /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        style: {
          fontSize: 11,
          marginBottom: 8,
          color: lengthHint.severity === "red" ? "var(--danger)" : "var(--warning, #b58900)"
        },
        title: lengthHint.tooltip,
        children: [
          "⚠ ",
          lengthHint.message
        ]
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: () => props.onTag(props.r.id), children: "Tag & process" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => void props.onSkip(props.r.id), children: "Skip" })
    ] })
  ] });
}
function ErrorRow(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Row, { id: props.r.id, focused: props.focused, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Title, { r: props.r }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(MetaLine, { r: props.r }),
    props.r.error && /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        style: {
          fontSize: 11,
          color: "var(--danger)",
          marginBottom: 8,
          fontFamily: "ui-monospace, Menlo, monospace",
          whiteSpace: "pre-wrap"
        },
        children: props.r.error
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", children: [
      props.r.isAuthError ? /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: props.onOpenSources, children: "Sign in again" }) : /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: () => props.onRetry(props.r.id), children: "Retry" }),
      props.r.isAuthError && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => props.onRetry(props.r.id), children: "Retry" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => void props.onSkip(props.r.id), children: "Skip" })
    ] })
  ] });
}
function CancelledRow(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Row, { id: props.r.id, focused: props.focused, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Title, { r: props.r }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(MetaLine, { r: props.r }),
    /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11, marginBottom: 8 }, children: "Cancelled" }),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: () => props.onRetry(props.r.id), children: "Resume" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => void props.onSkip(props.r.id), children: "Dismiss" })
    ] })
  ] });
}
function CompleteRow(props) {
  const { r } = props;
  const vocabLine = r.vocabularyRulesApplied != null && r.vocabularyRulesApplied > 0 ? `${r.vocabularyRulesApplied} correction${r.vocabularyRulesApplied === 1 ? "" : "s"} applied${r.vocabularySources ? ` · ${r.vocabularySources.split(",").join(" + ")}` : ""}` : null;
  const truncationTooltip = r.estimatedInputTokens !== null && r.contextWindowAtSubmit !== null ? `Estimated input ${r.estimatedInputTokens.toLocaleString()} tokens against a ${r.contextWindowAtSubmit.toLocaleString()}-token context window. The model silently truncates the start of the input when this happens, so the early part of the meeting may be missing from the summary.` : "Input was likely larger than the model context window; the summary may be missing detail from the start of the meeting.";
  const externalLabel = r.modelSnapshot ? `Processed on another machine (summary by ${r.modelSnapshot})` : "Processed on another machine";
  const externalTooltip = "This recording was processed on another Mac and its Markdown output was found via iCloud Drive. The pipeline did not run on this machine, so the summary reflects whatever model the other machine used. To re-run on this machine, delete the Markdown file and tag the recording again on the next poll.";
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(Row, { id: r.id, focused: props.focused, children: [
    /* @__PURE__ */ jsxRuntimeExports.jsx(Title, { r }),
    /* @__PURE__ */ jsxRuntimeExports.jsx(MetaLine, { r }),
    r.processedExternally && /* @__PURE__ */ jsxRuntimeExports.jsxs(
      "div",
      {
        style: {
          fontSize: 11,
          marginBottom: 8,
          color: "var(--fg-muted)",
          display: "flex",
          alignItems: "center",
          gap: 4
        },
        title: externalTooltip,
        children: [
          "📁 ",
          externalLabel
        ]
      }
    ),
    r.truncationWarning && /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        style: {
          fontSize: 11,
          marginBottom: 8,
          color: "var(--warning, #b58900)"
        },
        title: truncationTooltip,
        children: "⚠ Long meeting — summary may be missing detail from the start."
      }
    ),
    vocabLine && /* @__PURE__ */ jsxRuntimeExports.jsx(
      "div",
      {
        className: "muted",
        style: { fontSize: 11, marginBottom: 8, fontStyle: "italic" },
        title: "Vocabulary corrections applied during transcription",
        children: vocabLine
      }
    ),
    /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { className: "row", children: [
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: () => props.onReveal(r.id), children: "Reveal in Finder" }),
      /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: () => void props.onSkip(r.id), children: "Dismiss" })
    ] })
  ] });
}
function TipJarBanner(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      role: "region",
      "aria-label": "Support development",
      style: {
        padding: "10px 14px",
        borderBottom: "1px solid var(--border)",
        background: "rgba(245, 158, 11, 0.08)",
        display: "flex",
        alignItems: "center",
        gap: 12
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { flex: 1, fontSize: 12, lineHeight: 1.4 }, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: { fontWeight: 500, marginBottom: 2 }, children: [
            props.status.completionCount,
            " summaries done — nice work"
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { className: "muted", style: { fontSize: 11 }, children: "Glad distill is earning its keep. If you'd like to support development, you can keep me caffeinated." })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            className: "primary",
            onClick: props.onOpen,
            style: { fontSize: 12 },
            title: `Opens ${props.status.url} in your default browser`,
            children: "Buy me a coffee"
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "button",
          {
            onClick: props.onDismiss,
            style: {
              fontSize: 11,
              background: "transparent",
              border: "none",
              color: "var(--fg-muted)",
              cursor: "pointer",
              padding: "4px 6px"
            },
            title: "Hide this banner. It won't come back.",
            children: "Not now"
          }
        )
      ]
    }
  );
}
function describeDurationRisk(durationSeconds) {
  if (durationSeconds == null) return null;
  if (durationSeconds >= 10800) {
    return {
      severity: "red",
      message: "Very long meeting — summary likely to lose detail.",
      tooltip: "Meetings over 3 hours often exceed the model’s context window after transcription. The model will silently truncate the start of the input and the summary may be missing earlier topics."
    };
  }
  if (durationSeconds >= 5400) {
    return {
      severity: "yellow",
      message: "Long meeting — summary quality may suffer.",
      tooltip: "Long meetings produce long transcripts. The model can still summarise them, but its attention spreads more thinly so finer points are easier to miss. Worth re-reading against the source if anything seems off."
    };
  }
  return null;
}
function humanStep(step) {
  switch (step) {
    case "download":
      return "Downloading";
    case "transcribe":
      return "Transcribing";
    case "summarise":
      return "Summarising";
    case "write":
      return "Writing markdown";
    default:
      return "Processing";
  }
}
function Spinner() {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "span",
    {
      style: {
        display: "inline-block",
        width: 10,
        height: 10,
        border: "2px solid var(--accent)",
        borderRightColor: "transparent",
        borderRadius: "50%",
        animation: "plaud-spin 0.7s linear infinite"
      }
    }
  );
}
function HeaderButton(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "button",
    {
      title: props.title,
      onClick: props.onClick,
      disabled: props.disabled,
      style: {
        padding: "2px 8px",
        fontSize: 14,
        lineHeight: 1,
        minWidth: 24
      },
      children: props.children
    }
  );
}
function ImportQueuePanel(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "div",
    {
      role: "region",
      "aria-label": "Imports in progress",
      style: {
        borderBottom: "1px solid var(--border)",
        background: "var(--row-hover)"
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            style: {
              padding: "6px 14px",
              fontSize: 10,
              fontWeight: 600,
              letterSpacing: "0.05em",
              textTransform: "uppercase",
              color: "var(--fg-muted)",
              display: "flex",
              alignItems: "center",
              gap: 6
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: "Imports" }),
              /* @__PURE__ */ jsxRuntimeExports.jsxs("span", { style: { fontWeight: 400 }, children: [
                "· ",
                props.entries.length,
                props.activeOrQueued > 0 && ` (${props.activeOrQueued} pending)`
              ] })
            ]
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { style: { listStyle: "none", margin: 0, padding: 0 }, children: props.entries.map((e) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          ImportQueueRow,
          {
            entry: e,
            onDismiss: () => props.onDismiss(e.sourcePath)
          },
          e.sourcePath
        )) })
      ]
    }
  );
}
function ImportQueueRow(props) {
  const e = props.entry;
  const lastSlash = Math.max(e.sourcePath.lastIndexOf("/"), e.sourcePath.lastIndexOf("\\"));
  const basename = lastSlash >= 0 ? e.sourcePath.slice(lastSlash + 1) : e.sourcePath;
  return /* @__PURE__ */ jsxRuntimeExports.jsxs(
    "li",
    {
      title: e.sourcePath,
      style: {
        padding: "8px 14px",
        borderTop: "1px solid var(--border)",
        fontSize: 12
      },
      children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            className: "ellipsis",
            style: { fontWeight: 500, marginBottom: 4 },
            children: basename
          }
        ),
        /* @__PURE__ */ jsxRuntimeExports.jsxs(
          "div",
          {
            style: {
              display: "flex",
              alignItems: "center",
              gap: 8,
              fontSize: 11,
              color: e.status === "error" ? "var(--danger)" : "var(--fg-muted)"
            },
            children: [
              /* @__PURE__ */ jsxRuntimeExports.jsx("span", { children: describeImportStatus(e) }),
              e.status === "active" && /* @__PURE__ */ jsxRuntimeExports.jsx(ImportProgressBar, { percent: e.percent }),
              e.status === "error" && /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: props.onDismiss, style: { marginLeft: "auto", fontSize: 11 }, children: "Dismiss" })
            ]
          }
        ),
        e.error && /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            style: {
              marginTop: 6,
              color: "var(--danger)",
              fontFamily: "ui-monospace, Menlo, monospace",
              fontSize: 11,
              whiteSpace: "pre-wrap"
            },
            children: e.error
          }
        )
      ]
    }
  );
}
function ImportProgressBar(props) {
  const p = props.percent;
  return /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      style: {
        flex: 1,
        height: 4,
        borderRadius: 2,
        overflow: "hidden",
        background: "var(--border)",
        position: "relative"
      },
      children: /* @__PURE__ */ jsxRuntimeExports.jsx(
        "div",
        {
          style: {
            width: p === null ? "100%" : `${p}%`,
            height: "100%",
            background: "var(--accent)",
            // Indeterminate: gentle pulse via opacity. Keeps the CSS
            // surface here tiny; if we ever want a sliding stripe we
            // can move this into shared/styles.css.
            opacity: p === null ? 0.6 : 1,
            transition: "width 200ms linear"
          }
        }
      )
    }
  );
}
function describeImportStatus(e) {
  if (e.status === "queued") return "Queued";
  if (e.status === "error") return "Failed";
  switch (e.phase) {
    case "probe":
      return "Reading file…";
    case "copy":
      return e.percent !== null ? `Copying audio… ${e.percent}%` : "Copying audio…";
    case "extract":
      return e.percent !== null ? `Extracting audio… ${e.percent}%` : "Extracting audio…";
    case "finalise":
      return "Finalising…";
    default:
      return "Importing…";
  }
}
const root = createRoot(document.getElementById("root"));
root.render(
  /* @__PURE__ */ jsxRuntimeExports.jsx(React.StrictMode, { children: /* @__PURE__ */ jsxRuntimeExports.jsx(Inbox, {}) })
);

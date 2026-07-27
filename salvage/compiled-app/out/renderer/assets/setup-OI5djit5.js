import { r as reactExports, j as jsxRuntimeExports, c as createRoot } from "./styles-DDvpJv-I.js";
const PHASE_LABELS = {
  "creating-venv": "Creating Python environment",
  "installing-packages": "Installing transcription packages",
  verifying: "Verifying install"
};
const PHASE_PROGRESS = {
  "creating-venv": 10,
  "installing-packages": 60,
  verifying: 95
};
function Setup() {
  const [state, setState] = reactExports.useState({ kind: "loading" });
  const [log, setLog] = reactExports.useState([]);
  const logRef = reactExports.useRef(null);
  reactExports.useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status = await window.distill.setup.getStatus();
        if (cancelled) return;
        if (status.kind === "python-missing") {
          setState({ kind: "python-missing", triedPaths: status.triedPaths });
        } else {
          setState({
            kind: "needs-setup",
            systemPython: status.systemPython,
            systemPythonVersion: status.systemPythonVersion,
            reason: status.reason
          });
        }
      } catch (e) {
        if (cancelled) return;
        setState({
          kind: "failed",
          phase: "creating-venv",
          message: `Could not load setup status: ${e instanceof Error ? e.message : String(e)}`
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);
  reactExports.useEffect(() => {
    const off = window.distill.onSetupProgress((event) => {
      if (event.kind === "log" && event.log) {
        setLog((prev) => {
          const next = [...prev, event.log];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } else if (event.kind === "phase" && event.phase) {
        setState(
          (prev) => prev.kind === "installing" || prev.kind === "needs-setup" ? { kind: "installing", phase: event.phase } : prev
        );
      } else if (event.kind === "done") {
        setState({ kind: "done" });
        setTimeout(() => {
          window.close();
        }, 1500);
      } else if (event.kind === "failed" && event.failure) {
        setState({
          kind: "failed",
          phase: event.failure.phase,
          message: event.failure.message
        });
      }
    });
    return off;
  }, []);
  reactExports.useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);
  const onInstall = reactExports.useCallback(async () => {
    setLog([]);
    setState({ kind: "installing", phase: "creating-venv" });
    const result = await window.distill.setup.start();
    if (result.kind === "failed") {
      setState({
        kind: "failed",
        phase: result.phase,
        message: result.message
      });
    }
  }, []);
  const onQuit = reactExports.useCallback(() => {
    void window.distill.setup.quit();
  }, []);
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: shellStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsx("main", { style: mainStyle, children: renderState(state, log, logRef, onInstall, onQuit) }) });
}
function renderState(state, log, logRef, onInstall, onQuit) {
  switch (state.kind) {
    case "loading":
      return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: { padding: 24, color: "var(--fg-muted)", fontSize: 12 }, children: "Loading…" });
    case "needs-setup":
      return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { style: headingStyle, children: "Welcome to distill" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { style: leadStyle, children: "distill needs to install a small Python environment to handle transcription on your Mac. This is a one-time setup that takes a few minutes; nothing leaves your machine." }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { style: cardStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: cardLabelStyle, children: "What will happen" }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("ol", { style: listStyle, children: [
            /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: "Create a Python environment in your distill data folder" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: "Download and install MLX Whisper (~700 MB) from the Python package index" }),
            /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: "Verify the install worked" })
          ] }),
          /* @__PURE__ */ jsxRuntimeExports.jsxs("div", { style: smallStyle, children: [
            "Using ",
            state.systemPythonVersion,
            " from",
            " ",
            /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: state.systemPython }),
            ". ",
            state.reason
          ] })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: onQuit, children: "Quit" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: onInstall, children: "Install" })
        ] })
      ] });
    case "python-missing":
      return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { style: headingStyle, children: "Python 3.11 needed" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { style: leadStyle, children: "distill needs Python 3.11 installed on your Mac to run transcription. The recommended way is via Homebrew:" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("section", { style: cardStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { style: preStyle, children: "brew install python@3.11" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: smallStyle, children: "Once Python 3.11 is installed, quit and re-launch distill." })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("details", { style: detailsStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("summary", { style: summaryStyle, children: "Where distill looked" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("ul", { style: listStyle, children: state.triedPaths.map((p) => /* @__PURE__ */ jsxRuntimeExports.jsx("li", { children: /* @__PURE__ */ jsxRuntimeExports.jsx("code", { children: p }) }, p)) })
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("footer", { style: footerStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: onQuit, children: "Quit" }) })
      ] });
    case "installing":
      return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsxs("h2", { style: headingStyle, children: [
          PHASE_LABELS[state.phase],
          "…"
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { style: leadStyle, children: state.phase === "installing-packages" ? "This can take a few minutes on a slow connection. You can leave this window open and check back." : "Setting things up." }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(ProgressBar, { percent: PHASE_PROGRESS[state.phase] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { ref: logRef, style: logStyle, children: log.length === 0 ? /* @__PURE__ */ jsxRuntimeExports.jsx("span", { style: { color: "var(--fg-muted)" }, children: "Starting…" }) : log.map((line, i) => /* @__PURE__ */ jsxRuntimeExports.jsx(
          "div",
          {
            style: {
              color: line.stream === "stderr" ? "var(--danger)" : "var(--fg)"
            },
            children: line.text
          },
          i
        )) })
      ] });
    case "done":
      return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { style: headingStyle, children: "All set" }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("p", { style: leadStyle, children: "distill is ready to go. This window will close in a moment." }),
        /* @__PURE__ */ jsxRuntimeExports.jsx(ProgressBar, { percent: 100 })
      ] });
    case "failed":
      return /* @__PURE__ */ jsxRuntimeExports.jsxs(jsxRuntimeExports.Fragment, { children: [
        /* @__PURE__ */ jsxRuntimeExports.jsx("h2", { style: { ...headingStyle, color: "var(--danger)" }, children: "Setup failed" }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("p", { style: leadStyle, children: [
          "Something went wrong during ",
          PHASE_LABELS[state.phase].toLowerCase(),
          ". The most likely cause is a network drop during package download. Try again, or quit and re-launch distill later."
        ] }),
        /* @__PURE__ */ jsxRuntimeExports.jsx("pre", { style: errorBoxStyle, children: state.message }),
        /* @__PURE__ */ jsxRuntimeExports.jsxs("footer", { style: footerStyle, children: [
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { onClick: onQuit, children: "Quit" }),
          /* @__PURE__ */ jsxRuntimeExports.jsx("button", { className: "primary", onClick: onInstall, children: "Try again" })
        ] })
      ] });
  }
}
function ProgressBar(props) {
  return /* @__PURE__ */ jsxRuntimeExports.jsx("div", { style: progressTrackStyle, children: /* @__PURE__ */ jsxRuntimeExports.jsx(
    "div",
    {
      style: {
        ...progressFillStyle,
        width: `${Math.max(0, Math.min(100, props.percent))}%`
      }
    }
  ) });
}
const shellStyle = {
  display: "flex",
  flexDirection: "column",
  height: "100vh",
  background: "var(--bg)",
  color: "var(--fg)"
};
const mainStyle = {
  flex: 1,
  padding: "28px 32px 20px",
  display: "flex",
  flexDirection: "column",
  gap: 12,
  minHeight: 0
};
const headingStyle = {
  fontSize: 20,
  fontWeight: 600,
  margin: 0,
  letterSpacing: -0.2
};
const leadStyle = {
  fontSize: 13,
  lineHeight: 1.5,
  margin: 0,
  color: "var(--fg)"
};
const cardStyle = {
  border: "1px solid var(--border)",
  borderRadius: 8,
  padding: 12,
  marginTop: 4
};
const cardLabelStyle = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: "uppercase",
  letterSpacing: 0.4,
  color: "var(--fg-muted)",
  marginBottom: 6
};
const listStyle = {
  margin: "4px 0 6px",
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.5
};
const smallStyle = {
  fontSize: 11,
  color: "var(--fg-muted)",
  marginTop: 8,
  lineHeight: 1.4
};
const preStyle = {
  margin: "4px 0 0",
  padding: "8px 10px",
  background: "var(--input-bg, var(--row-hover))",
  borderRadius: 4,
  fontSize: 12,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  whiteSpace: "pre-wrap"
};
const detailsStyle = {
  fontSize: 11,
  marginTop: 4
};
const summaryStyle = {
  cursor: "pointer",
  color: "var(--fg-muted)",
  padding: "4px 0"
};
const logStyle = {
  flex: 1,
  minHeight: 120,
  margin: 0,
  padding: 10,
  background: "var(--input-bg, var(--row-hover))",
  border: "1px solid var(--border)",
  borderRadius: 6,
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  overflow: "auto",
  whiteSpace: "pre-wrap",
  wordBreak: "break-word"
};
const progressTrackStyle = {
  width: "100%",
  height: 6,
  borderRadius: 3,
  background: "var(--row-hover)",
  overflow: "hidden",
  marginTop: 4,
  marginBottom: 4
};
const progressFillStyle = {
  height: "100%",
  background: "var(--accent, #3b82f6)",
  transition: "width 280ms ease"
};
const errorBoxStyle = {
  margin: 0,
  padding: 10,
  background: "rgba(220, 38, 38, 0.08)",
  color: "var(--danger)",
  border: "1px solid rgba(220, 38, 38, 0.2)",
  borderRadius: 6,
  fontSize: 11,
  fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  whiteSpace: "pre-wrap",
  wordBreak: "break-word",
  maxHeight: 200,
  overflow: "auto"
};
const footerStyle = {
  display: "flex",
  justifyContent: "flex-end",
  gap: 8,
  marginTop: "auto",
  paddingTop: 12,
  borderTop: "1px solid var(--border)"
};
const root = document.getElementById("root");
if (!root) throw new Error("Setup renderer: #root not found");
createRoot(root).render(/* @__PURE__ */ jsxRuntimeExports.jsx(Setup, {}));

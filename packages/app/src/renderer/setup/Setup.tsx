/**
 * First-launch setup window.
 *
 * Renders the Python venv install flow. Four states the renderer
 * can be in, plus an initial loading state while we fetch the
 * server-side status:
 *
 *   - loading       window just opened, awaiting setup.getStatus()
 *   - needs-setup   Python 3.11 found, venv missing/broken/incomplete
 *                   -> show explainer + Install button
 *   - python-missing -> show brew-install instructions + Quit button
 *   - installing    -> show progress bar, phase label, log textarea
 *   - failed        -> show failure phase + error tail + Retry button
 *   - done          -> brief success message, then auto-close
 *
 * State transitions are renderer-side based on the start() promise
 * resolution and on push events from main. The window deliberately
 * doesn't have a Close (X) on the title bar so the user can't
 * accidentally cancel half-way through pip install — they have to
 * either complete or quit explicitly.
 */

import { useCallback, useEffect, useRef, useState } from 'react';
import type {
  SetupInitialStatus,
  SetupPhase,
  SetupProgressEvent,
} from '../../shared/ipc-contract.js';

type UiState =
  | { kind: 'loading' }
  | { kind: 'needs-setup'; systemPython: string; systemPythonVersion: string; reason: string }
  | { kind: 'python-missing'; triedPaths: string[] }
  | { kind: 'installing'; phase: SetupPhase }
  | { kind: 'done' }
  | { kind: 'failed'; phase: SetupPhase; message: string };

interface LogLine {
  stream: 'stdout' | 'stderr';
  text: string;
}

const PHASE_LABELS: Record<SetupPhase, string> = {
  'creating-venv': 'Creating Python environment',
  'installing-packages': 'Installing transcription packages',
  verifying: 'Verifying install',
};

/**
 * Approximate "how far along are we" weighting for the progress bar.
 * Pip install is by far the longest phase (2-5 min vs ~5s each for
 * the other two), so we show the bar resting at 10% during venv
 * creation, climbing to 90% during pip, and snapping to 100% on
 * verify+done. The values are eyeballed; real per-phase progress
 * isn't available because pip doesn't emit a percent.
 */
const PHASE_PROGRESS: Record<SetupPhase, number> = {
  'creating-venv': 10,
  'installing-packages': 60,
  verifying: 95,
};

export function Setup(): JSX.Element {
  const [state, setState] = useState<UiState>({ kind: 'loading' });
  const [log, setLog] = useState<LogLine[]>([]);
  const logRef = useRef<HTMLPreElement>(null);

  // Fetch initial status on mount. main answers this from the same
  // detection helpers used at bootstrap time.
  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const status: SetupInitialStatus = await window.distill.setup.getStatus();
        if (cancelled) return;
        if (status.kind === 'python-missing') {
          setState({ kind: 'python-missing', triedPaths: status.triedPaths });
        } else {
          setState({
            kind: 'needs-setup',
            systemPython: status.systemPython,
            systemPythonVersion: status.systemPythonVersion,
            reason: status.reason,
          });
        }
      } catch (e) {
        // Should never happen — getStatus is synchronous-ish in main.
        // If it does, fail to a known state with a Retry option so the
        // user isn't stuck on a blank loading screen.
        if (cancelled) return;
        setState({
          kind: 'failed',
          phase: 'creating-venv',
          message: `Could not load setup status: ${e instanceof Error ? e.message : String(e)}`,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, []);

  // Subscribe to setup-progress events. Phase events bump the UI
  // state; log events append to the log list; done/failed are
  // terminal but we also rely on the start() promise resolution to
  // catch failures (in case a push event is missed).
  useEffect(() => {
    const off = window.distill.onSetupProgress((event: SetupProgressEvent) => {
      if (event.kind === 'log' && event.log) {
        setLog((prev) => {
          // Cap the log at 500 lines so a chatty pip output doesn't
          // build up unbounded memory in a tab the user might leave
          // open. The tail is what's interesting anyway.
          const next = [...prev, event.log!];
          return next.length > 500 ? next.slice(-500) : next;
        });
      } else if (event.kind === 'phase' && event.phase) {
        setState((prev) =>
          prev.kind === 'installing' || prev.kind === 'needs-setup'
            ? { kind: 'installing', phase: event.phase! }
            : prev,
        );
      } else if (event.kind === 'done') {
        setState({ kind: 'done' });
        // The window auto-closes after a brief success message so
        // the user gets visual confirmation. main has already moved
        // on to building the rest of the app.
        setTimeout(() => {
          window.close();
        }, 1500);
      } else if (event.kind === 'failed' && event.failure) {
        setState({
          kind: 'failed',
          phase: event.failure.phase,
          message: event.failure.message,
        });
      }
    });
    return off;
  }, []);

  // Auto-scroll the log to the bottom as new lines come in.
  useEffect(() => {
    if (logRef.current) {
      logRef.current.scrollTop = logRef.current.scrollHeight;
    }
  }, [log]);

  const onInstall = useCallback(async () => {
    setLog([]);
    setState({ kind: 'installing', phase: 'creating-venv' });
    // start() resolves when the install finishes either way. The push
    // events also report the outcome but we await this for absolute
    // certainty — if a push event was dropped, the resolved value is
    // still authoritative.
    const result = await window.distill.setup.start();
    if (result.kind === 'failed') {
      setState({
        kind: 'failed',
        phase: result.phase,
        message: result.message,
      });
    }
    // success and cancelled are already handled by the push events.
  }, []);

  const onQuit = useCallback(() => {
    void window.distill.setup.quit();
  }, []);

  return (
    <div style={shellStyle}>
      <main style={mainStyle}>{renderState(state, log, logRef, onInstall, onQuit)}</main>
    </div>
  );
}

function renderState(
  state: UiState,
  log: LogLine[],
  logRef: React.RefObject<HTMLPreElement>,
  onInstall: () => void,
  onQuit: () => void,
): JSX.Element {
  switch (state.kind) {
    case 'loading':
      return (
        <div style={{ padding: 24, color: 'var(--fg-muted)', fontSize: 12 }}>
          Loading…
        </div>
      );

    case 'needs-setup':
      return (
        <>
          <h2 style={headingStyle}>Welcome to distill</h2>
          <p style={leadStyle}>
            distill needs to install a small Python environment to handle
            transcription on your Mac. This is a one-time setup that takes
            a few minutes; nothing leaves your machine.
          </p>
          <section style={cardStyle}>
            <div style={cardLabelStyle}>What will happen</div>
            <ol style={listStyle}>
              <li>Create a Python environment in your distill data folder</li>
              <li>
                Download and install MLX Whisper (~700&nbsp;MB) from the
                Python package index
              </li>
              <li>Verify the install worked</li>
            </ol>
            <div style={smallStyle}>
              Using {state.systemPythonVersion} from{' '}
              <code>{state.systemPython}</code>. {state.reason}
            </div>
          </section>
          <footer style={footerStyle}>
            <button onClick={onQuit}>Quit</button>
            <button className="primary" onClick={onInstall}>
              Install
            </button>
          </footer>
        </>
      );

    case 'python-missing':
      return (
        <>
          <h2 style={headingStyle}>Python 3.11 needed</h2>
          <p style={leadStyle}>
            distill needs Python 3.11 installed on your Mac to run
            transcription. The recommended way is via Homebrew:
          </p>
          <section style={cardStyle}>
            <pre style={preStyle}>brew install python@3.11</pre>
            <div style={smallStyle}>
              Once Python 3.11 is installed, quit and re-launch distill.
            </div>
          </section>
          <details style={detailsStyle}>
            <summary style={summaryStyle}>Where distill looked</summary>
            <ul style={listStyle}>
              {state.triedPaths.map((p) => (
                <li key={p}>
                  <code>{p}</code>
                </li>
              ))}
            </ul>
          </details>
          <footer style={footerStyle}>
            <button className="primary" onClick={onQuit}>
              Quit
            </button>
          </footer>
        </>
      );

    case 'installing':
      return (
        <>
          <h2 style={headingStyle}>{PHASE_LABELS[state.phase]}…</h2>
          <p style={leadStyle}>
            {state.phase === 'installing-packages'
              ? 'This can take a few minutes on a slow connection. You can leave this window open and check back.'
              : 'Setting things up.'}
          </p>
          <ProgressBar percent={PHASE_PROGRESS[state.phase]} />
          <pre ref={logRef} style={logStyle}>
            {log.length === 0 ? (
              <span style={{ color: 'var(--fg-muted)' }}>Starting…</span>
            ) : (
              log.map((line, i) => (
                <div
                  key={i}
                  style={{
                    color:
                      line.stream === 'stderr'
                        ? 'var(--danger)'
                        : 'var(--fg)',
                  }}
                >
                  {line.text}
                </div>
              ))
            )}
          </pre>
        </>
      );

    case 'done':
      return (
        <>
          <h2 style={headingStyle}>All set</h2>
          <p style={leadStyle}>
            distill is ready to go. This window will close in a moment.
          </p>
          <ProgressBar percent={100} />
        </>
      );

    case 'failed':
      return (
        <>
          <h2 style={{ ...headingStyle, color: 'var(--danger)' }}>
            Setup failed
          </h2>
          <p style={leadStyle}>
            Something went wrong during {PHASE_LABELS[state.phase].toLowerCase()}.
            The most likely cause is a network drop during package download.
            Try again, or quit and re-launch distill later.
          </p>
          <pre style={errorBoxStyle}>{state.message}</pre>
          <footer style={footerStyle}>
            <button onClick={onQuit}>Quit</button>
            <button className="primary" onClick={onInstall}>
              Try again
            </button>
          </footer>
        </>
      );
  }
}

function ProgressBar(props: { percent: number }): JSX.Element {
  return (
    <div style={progressTrackStyle}>
      <div
        style={{
          ...progressFillStyle,
          width: `${Math.max(0, Math.min(100, props.percent))}%`,
        }}
      />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Styles. Co-located because Setup is a small, self-contained window.
// ---------------------------------------------------------------------------

const shellStyle: React.CSSProperties = {
  display: 'flex',
  flexDirection: 'column',
  height: '100vh',
  background: 'var(--bg)',
  color: 'var(--fg)',
};

const mainStyle: React.CSSProperties = {
  flex: 1,
  padding: '28px 32px 20px',
  display: 'flex',
  flexDirection: 'column',
  gap: 12,
  minHeight: 0,
};

const headingStyle: React.CSSProperties = {
  fontSize: 20,
  fontWeight: 600,
  margin: 0,
  letterSpacing: -0.2,
};

const leadStyle: React.CSSProperties = {
  fontSize: 13,
  lineHeight: 1.5,
  margin: 0,
  color: 'var(--fg)',
};

const cardStyle: React.CSSProperties = {
  border: '1px solid var(--border)',
  borderRadius: 8,
  padding: 12,
  marginTop: 4,
};

const cardLabelStyle: React.CSSProperties = {
  fontSize: 10,
  fontWeight: 600,
  textTransform: 'uppercase',
  letterSpacing: 0.4,
  color: 'var(--fg-muted)',
  marginBottom: 6,
};

const listStyle: React.CSSProperties = {
  margin: '4px 0 6px',
  paddingLeft: 22,
  fontSize: 12,
  lineHeight: 1.5,
};

const smallStyle: React.CSSProperties = {
  fontSize: 11,
  color: 'var(--fg-muted)',
  marginTop: 8,
  lineHeight: 1.4,
};

const preStyle: React.CSSProperties = {
  margin: '4px 0 0',
  padding: '8px 10px',
  background: 'var(--input-bg, var(--row-hover))',
  borderRadius: 4,
  fontSize: 12,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  whiteSpace: 'pre-wrap',
};

const detailsStyle: React.CSSProperties = {
  fontSize: 11,
  marginTop: 4,
};

const summaryStyle: React.CSSProperties = {
  cursor: 'pointer',
  color: 'var(--fg-muted)',
  padding: '4px 0',
};

const logStyle: React.CSSProperties = {
  flex: 1,
  minHeight: 120,
  margin: 0,
  padding: 10,
  background: 'var(--input-bg, var(--row-hover))',
  border: '1px solid var(--border)',
  borderRadius: 6,
  fontSize: 11,
  lineHeight: 1.4,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  overflow: 'auto',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
};

const progressTrackStyle: React.CSSProperties = {
  width: '100%',
  height: 6,
  borderRadius: 3,
  background: 'var(--row-hover)',
  overflow: 'hidden',
  marginTop: 4,
  marginBottom: 4,
};

const progressFillStyle: React.CSSProperties = {
  height: '100%',
  background: 'var(--accent, #3b82f6)',
  transition: 'width 280ms ease',
};

const errorBoxStyle: React.CSSProperties = {
  margin: 0,
  padding: 10,
  background: 'rgba(220, 38, 38, 0.08)',
  color: 'var(--danger)',
  border: '1px solid rgba(220, 38, 38, 0.2)',
  borderRadius: 6,
  fontSize: 11,
  fontFamily:
    'ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, "Liberation Mono", "Courier New", monospace',
  whiteSpace: 'pre-wrap',
  wordBreak: 'break-word',
  maxHeight: 200,
  overflow: 'auto',
};

const footerStyle: React.CSSProperties = {
  display: 'flex',
  justifyContent: 'flex-end',
  gap: 8,
  marginTop: 'auto',
  paddingTop: 12,
  borderTop: '1px solid var(--border)',
};

import React, { useCallback, useEffect, useState } from 'react';
import type { ClaudeSettingsDTO, ClaudeStatusDTO } from '../shared/api.js';

/**
 * Settings → Claude. Optional summaries written by Claude Code instead of the
 * local model. Everything here is about making the trade-off visible: turning
 * it on is the one thing that lets a transcript leave this Mac, so the page
 * says what is sent, what is not, and what still has to be allowed per client.
 */

const box: React.CSSProperties = { border: '1px solid var(--border)', borderRadius: 8, padding: 12, marginBottom: 12 };
const heading: React.CSSProperties = { fontWeight: 500, fontSize: 13, marginBottom: 4 };
const hint: React.CSSProperties = { fontSize: 11, lineHeight: 1.45 };
// The app's global `label` style is small uppercase, made for short field names; a sentence the
// user is consenting to should read as one.
const checkLabel: React.CSSProperties = {
  display: 'flex', alignItems: 'center', gap: 8, fontSize: 12, cursor: 'pointer',
  textTransform: 'none', letterSpacing: 'normal', color: 'var(--fg)', marginBottom: 0,
};
const code: React.CSSProperties = {
  display: 'block', fontFamily: 'ui-monospace, Menlo, monospace', fontSize: 11,
  background: 'var(--row-hover)', borderRadius: 4, padding: '4px 8px', margin: '4px 0', userSelect: 'all',
};

const MODELS: { value: string; label: string }[] = [
  { value: '', label: "Claude Code's default" },
  { value: 'sonnet', label: 'Sonnet (balanced)' },
  { value: 'opus', label: 'Opus (most capable)' },
  { value: 'haiku', label: 'Haiku (fastest)' },
];

export function ClaudePane() {
  const [settings, setSettings] = useState<ClaudeSettingsDTO | null>(null);
  const [status, setStatus] = useState<ClaudeStatusDTO | null>(null);
  const [checking, setChecking] = useState(false);
  const [saving, setSaving] = useState(false);
  const [message, setMessage] = useState<string | null>(null);
  const [testing, setTesting] = useState(false);
  const [testResult, setTestResult] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.distill.claude
      .getSettings()
      .then((r) => {
        if (!live) return;
        setSettings(r.settings);
        setStatus(r.status);
      })
      .catch((e) => live && setMessage(e instanceof Error ? e.message : String(e)));
    return () => {
      live = false;
    };
  }, []);

  const recheck = useCallback(async () => {
    setChecking(true);
    setTestResult(null);
    try {
      setStatus(await window.distill.claude.check());
    } catch (e) {
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setChecking(false);
    }
  }, []);

  // Each change saves at once: it is a permission, not a form to be filled in.
  const save = useCallback(async (next: ClaudeSettingsDTO) => {
    setSaving(true);
    setMessage(null);
    try {
      setSettings(await window.distill.claude.saveSettings(next));
    } catch (e) {
      // Declining the consent prompt arrives here; the page keeps showing what is really saved.
      setMessage(e instanceof Error ? e.message : String(e));
    } finally {
      setSaving(false);
    }
  }, []);

  const runTest = useCallback(async () => {
    setTesting(true);
    setTestResult(null);
    try {
      const r = await window.distill.claude.test();
      setTestResult(
        r.ok
          ? `Works. ${r.model} answered in ${r.seconds}s${r.costUsd !== null ? ` (about $${r.costUsd.toFixed(4)})` : ''}. Nothing from any recording was sent.`
          : `Did not work: ${r.error}`,
      );
    } catch (e) {
      setTestResult(e instanceof Error ? e.message : String(e));
    } finally {
      setTesting(false);
    }
  }, []);

  if (!settings) {
    return (
      <div style={{ padding: 16 }} className="muted">
        {message ?? 'Looking for Claude Code…'}
      </div>
    );
  }

  const ready = status?.installed === true && status.loggedIn;

  return (
    <div style={{ flex: 1, minHeight: 0, overflowY: 'auto', padding: 16 }}>
      <p className="muted" style={{ ...hint, marginTop: 0 }}>
        By default every summary is written on this Mac by Ollama and nothing leaves it. This page lets you use
        Claude Code for some clients instead, usually for a better summary. It is off until you turn it on here{' '}
        <strong>and</strong> allow each client under Clients.
      </p>

      <section style={box}>
        <div style={heading}>1. Claude Code on this Mac</div>
        {status === null ? (
          <div className="muted" style={hint}>Checking…</div>
        ) : ready ? (
          <div style={{ fontSize: 12 }}>
            ✓ {status.version ?? 'Claude Code'} — signed in
            {status.email ? ` as ${status.email}` : ''}
            {status.authMethod ? ` (${status.authMethod}${status.subscription ? `, ${status.subscription}` : ''})` : ''}
            <div className="muted" style={hint}>{status.binary}</div>
          </div>
        ) : (
          <div style={{ fontSize: 12 }}>
            <div style={{ color: 'var(--danger)' }}>{status.problem}</div>
            <div className="muted" style={{ ...hint, marginTop: 8 }}>
              {status.installed ? 'Sign in:' : 'Install it (any one of these), then sign in:'}
            </div>
            {!status.installed && (
              <>
                <code style={code}>curl -fsSL https://claude.ai/install.sh | bash</code>
                <code style={code}>brew install --cask claude-code</code>
              </>
            )}
            <div className="muted" style={hint}>Then open Terminal, run:</div>
            <code style={code}>claude</code>
            <div className="muted" style={hint}>
              and follow the browser prompt (a Pro, Max, Team or Enterprise plan, or a Console account; the free
              claude.ai plan does not include Claude Code). Come back here and press Check again.
            </div>
          </div>
        )}
        <div style={{ display: 'flex', gap: 8, marginTop: 10, alignItems: 'center', flexWrap: 'wrap' }}>
          <button onClick={() => void recheck()} disabled={checking}>{checking ? 'Checking…' : 'Check again'}</button>
          <button onClick={() => void runTest()} disabled={testing || !ready}>{testing ? 'Testing…' : 'Send a test'}</button>
          <button onClick={() => void window.distill.claude.openGuide().catch((e) => setMessage(String(e)))}>Open the guide</button>
        </div>
        {testResult && <div className="muted" style={{ ...hint, marginTop: 6 }} aria-live="polite">{testResult}</div>}
      </section>

      <section style={box}>
        <div style={heading}>2. Allow it</div>
        <label style={checkLabel}>
          <input
            type="checkbox"
            checked={settings.enabled}
            disabled={saving}
            onChange={(e) => void save({ ...settings, enabled: e.target.checked })}
          />
          Allow Claude Code to write summaries
        </label>
        <div className="muted" style={{ ...hint, marginTop: 6 }}>
          Turning this on asks you to confirm. Even then <strong>nothing is sent</strong> until a client is allowed under
          Settings → Clients. Turning it off takes effect straight away.
        </div>
        {settings.enabled && !ready && (
          <div style={{ ...hint, marginTop: 6, color: 'var(--danger)' }}>
            Claude Code is not ready (step 1), so summaries will be written locally until it is.
          </div>
        )}

        <div style={{ marginTop: 12, fontSize: 12 }}>
          <label style={{ ...checkLabel, cursor: 'default' }}>
            Model
            <select
              value={settings.model}
              disabled={saving}
              onChange={(e) => void save({ ...settings, model: e.target.value })}
            >
              {MODELS.map((m) => (
                <option key={m.value} value={m.value}>{m.label}</option>
              ))}
            </select>
          </label>
        </div>

        <label style={{ ...checkLabel, marginTop: 12 }}>
          <input
            type="checkbox"
            checked={settings.forUnfiled}
            disabled={saving || !settings.enabled}
            onChange={(e) => void save({ ...settings, forUnfiled: e.target.checked })}
          />
          Also use it for recordings not filed to any client
        </label>
        <div className="muted" style={hint}>
          Off by default. A recording that has only a <em>suggested</em> client always stays local.
        </div>
      </section>

      <section style={box}>
        <div style={heading}>What is sent, and what is not</div>
        <ul className="muted" style={{ ...hint, margin: '4px 0 0', paddingLeft: 18 }}>
          <li>Sent to Anthropic, for an allowed client's recording: the transcript, the meeting prompt, the attendee list, the client's account context, and notes made from attached slides.</li>
          <li>Never sent: the audio, other clients' recordings, or anything from a recording that is not allowed.</li>
          <li>Used only for the summary. Filing suggestions, search, briefs, corrections and attached-file notes stay on this Mac.</li>
          <li>If Claude Code fails or is unavailable, the summary is written locally. A local failure never falls back to Claude.</li>
          <li>The summary says which wrote it: the model name on the recording starts with <code>claude-code:</code> for these.</li>
          <li>Claude Code cannot be set to temperature 0, so re-running the same transcript can give a different summary.</li>
        </ul>
      </section>

      {message && <div style={{ ...hint, color: 'var(--danger)' }} aria-live="polite">{message}</div>}
    </div>
  );
}

/** One client's switch, shown in the Clients editor. Saves as soon as it is confirmed. */
export function ClientClaudeSwitch(props: {
  clientName: string;
  allowed: boolean;
  onChange: (allowed: boolean) => Promise<void>;
}) {
  const [enabled, setEnabled] = useState<boolean | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let live = true;
    window.distill.claude
      .getSettings()
      .then((r) => live && setEnabled(r.settings.enabled))
      .catch(() => live && setEnabled(null));
    return () => {
      live = false;
    };
  }, []);

  return (
    <fieldset disabled={busy} style={{ margin: '8px 0 12px', border: '1px solid var(--border)', borderRadius: 6, fontSize: 11 }}>
      <legend>Summaries written by Claude</legend>
      <label style={checkLabel}>
        <input
          type="checkbox"
          checked={props.allowed}
          onChange={(e) => {
            setBusy(true);
            setError(null);
            props
              .onChange(e.target.checked)
              .catch((err) => setError(err instanceof Error ? err.message : String(err)))
              .finally(() => setBusy(false));
          }}
        />
        Let Claude Code write summaries for {props.clientName}
      </label>
      <div className="muted" style={{ marginTop: 4 }}>
        {props.allowed
          ? enabled === false
            ? 'Allowed for this client, but Claude summaries are switched off in Settings → Claude, so nothing is sent.'
            : "This client's transcripts are sent to Anthropic to write their summaries."
          : 'Off: this client\'s meetings are summarised on this Mac and never leave it.'}
      </div>
      {error && <div style={{ color: 'var(--danger)', marginTop: 4 }}>{error}</div>}
    </fieldset>
  );
}

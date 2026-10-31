import { Marked } from 'marked';
import type { UpdateInfo } from './updateCheck.js';

/**
 * The "What's new" page shown before an update is downloaded.
 *
 * Release notes come off the network, so the page is built to be inert even if
 * the notes were hostile: raw HTML in them is escaped rather than passed
 * through, only https links survive, and a CSP forbids everything but inline
 * styling (so no script runs, inline included). The window that shows it is
 * sandboxed with no preload (see windows.ts). The buttons are plain links on a
 * private scheme that the main process intercepts — there is no script and no
 * IPC surface. The CSP is what keeps scripts out, so a test pins it as present
 * and strict.
 */
export type UpdateChoice = 'install' | 'skip' | 'later' | 'page';

export const CHOICE_SCHEME = 'distill-update:';

export function escapeHtml(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

const md = new Marked({
  gfm: true,
  breaks: false,
  renderer: {
    // Never let notes inject markup.
    html: ({ text }) => escapeHtml(text),
    // Images would be a network fetch to wherever the notes point; show the alt text.
    image: ({ text }) => escapeHtml(text),
    link({ href, tokens }) {
      const label = this.parser.parseInline(tokens);
      return /^https:\/\//i.test(href) ? `<a href="${escapeHtml(href)}">${label}</a>` : label;
    },
  },
});

export function renderNotes(markdown: string): string {
  const text = markdown.trim();
  if (!text) return '<p class="empty">No release notes were published for this version.</p>';
  return md.parse(text, { async: false }) as string;
}

const CSS = `
:root { color-scheme: light dark; --bg:#fff; --fg:#1d1d1f; --muted:#6e6e73; --line:#d2d2d7; --accent:#0a64d8; --btn:#f5f5f7; }
@media (prefers-color-scheme: dark) { :root { --bg:#1e1e20; --fg:#f5f5f7; --muted:#98989d; --line:#3a3a3c; --accent:#4c9bff; --btn:#2c2c2e; } }
* { box-sizing: border-box; }
html, body { height: 100%; margin: 0; }
body { display: flex; flex-direction: column; background: var(--bg); color: var(--fg); font: 13px/1.5 -apple-system, BlinkMacSystemFont, sans-serif; }
header { padding: 16px 20px 12px; border-bottom: 1px solid var(--line); }
h1 { font-size: 16px; margin: 0 0 2px; }
.sub { color: var(--muted); font-size: 12px; }
main { flex: 1; overflow-y: auto; padding: 12px 20px; }
main h1, main h2, main h3 { font-size: 13px; margin: 14px 0 4px; }
main ul, main ol { padding-left: 20px; margin: 4px 0 8px; }
main li { margin: 2px 0; }
main code { font: 12px ui-monospace, Menlo, monospace; background: var(--btn); padding: 1px 4px; border-radius: 4px; }
main pre { background: var(--btn); padding: 8px 10px; border-radius: 6px; overflow-x: auto; }
main a { color: var(--accent); }
.empty { color: var(--muted); font-style: italic; }
.note { color: var(--muted); font-size: 11px; padding: 8px 20px 0; line-height: 1.4; }
footer { display: flex; gap: 8px; padding: 12px 20px 16px; justify-content: flex-end; }
.btn { text-decoration: none; padding: 6px 14px; border-radius: 6px; border: 1px solid var(--line); background: var(--btn); color: var(--fg); font-size: 13px; }
.btn.primary { background: var(--accent); border-color: var(--accent); color: #fff; font-weight: 500; }
.spacer { flex: 1; }
`;

/**
 * Self-contained HTML for the window. `canInstall` is false when the release has
 * no published checksum — the app will not install what it cannot verify, so the
 * only forward action is the release page.
 */
export function renderUpdatePage(info: UpdateInfo, currentVersion: string, opts: { processing: boolean }): string {
  const canInstall = info.sha256 !== null;
  const link = (choice: UpdateChoice, label: string, cls = 'btn') =>
    `<a class="${cls}" href="${CHOICE_SCHEME}${choice}">${escapeHtml(label)}</a>`;
  const notes = [
    canInstall
      ? 'Nothing is downloaded until you press Download and Install. Installing quits distill, then the macOS installer opens and asks for your password; open distill again from Applications afterwards.'
      : 'This release has no published checksum, so it cannot be installed from inside the app.',
    opts.processing ? 'A recording is being processed right now; it resumes when distill restarts.' : '',
  ]
    .filter(Boolean)
    .join(' ');

  return `<!doctype html>
<html lang="en"><head><meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="default-src 'none'; style-src 'unsafe-inline'">
<title>distill ${escapeHtml(info.version)}</title>
<style>${CSS}</style></head>
<body>
<header><h1>distill ${escapeHtml(info.version)} is available</h1>
<div class="sub">You have ${escapeHtml(currentVersion)} · what's changed:</div></header>
<main>${renderNotes(info.notes)}</main>
<div class="note">${escapeHtml(notes)}</div>
<footer>
${link('skip', 'Skip This Version')}
<span class="spacer"></span>
${link('page', 'Release Page')}
${link('later', 'Not Now')}
${canInstall ? link('install', 'Download and Install', 'btn primary') : ''}
</footer>
</body></html>`;
}

/** Map a navigation inside the update window to what the user chose; null = not one of ours. */
export function choiceFromUrl(url: string): UpdateChoice | null {
  if (!url.startsWith(CHOICE_SCHEME)) return null;
  const c = url.slice(CHOICE_SCHEME.length);
  return c === 'install' || c === 'skip' || c === 'later' || c === 'page' ? c : null;
}

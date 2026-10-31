import { describe, it, expect } from 'vitest';
import { renderNotes, renderUpdatePage, choiceFromUrl, escapeHtml } from '../src/main/updateNotes.js';
import type { UpdateInfo } from '../src/main/updateCheck.js';

const info = (over: Partial<UpdateInfo> = {}): UpdateInfo => ({
  version: '0.0.22', notes: '## Added\n- Call recording', pageUrl: 'https://github.com/sigreenwood/distill/releases/tag/v0.0.22',
  assetName: 'distill-0.0.22-arm64.pkg', assetUrl: 'https://github.com/sigreenwood/distill/releases/download/v0.0.22/x',
  size: 1, sha256: 'a'.repeat(64), sha256Url: null, ...over,
});

describe('renderNotes', () => {
  it('renders markdown structure', () => {
    const h = renderNotes('## Added\n- one\n- two\n\n`code`');
    expect(h).toContain('<h2>Added</h2>');
    expect(h).toContain('<li>one</li>');
    expect(h).toContain('<code>code</code>');
  });

  it('escapes raw HTML instead of passing it through', () => {
    const h = renderNotes('hello <script>alert(1)</script> <img src=x onerror=alert(1)>\n\n<div onclick="x()">block</div>');
    expect(h).not.toMatch(/<script|<img|<div/i);
    expect(h).toContain('&lt;script&gt;');
  });

  it('keeps https links and drops every other scheme', () => {
    const h = renderNotes('[ok](https://example.com/a) [bad](javascript:alert(1)) [file](file:///etc/passwd) [http](http://example.com)');
    expect(h).toContain('<a href="https://example.com/a">ok</a>');
    expect(h).not.toMatch(/javascript:|file:|http:\/\//i);
    expect(h).toContain('bad');
  });

  it('does not fetch images', () => {
    const h = renderNotes('![tracker](https://evil.example/pixel.png)');
    expect(h).not.toContain('<img');
    expect(h).not.toContain('pixel.png');
  });

  it('says so when there are no notes', () => {
    expect(renderNotes('   ')).toContain('No release notes were published');
  });
});

describe('renderUpdatePage', () => {
  it('shows the changelog and both versions, with an install button', () => {
    const h = renderUpdatePage(info(), '0.0.21', { processing: false });
    expect(h).toContain('distill 0.0.22 is available');
    expect(h).toContain('You have 0.0.21');
    expect(h).toContain('Call recording');
    expect(h).toContain('href="distill-update:install"');
  });

  it('forbids scripts and network via CSP', () => {
    const h = renderUpdatePage(info(), '0.0.21', { processing: false });
    expect(h).toContain("default-src 'none'");
    expect(h).not.toMatch(/<script/i);
  });

  it('offers no install when the release has no checksum', () => {
    const h = renderUpdatePage(info({ sha256: null }), '0.0.21', { processing: false });
    expect(h).not.toContain('distill-update:install');
    expect(h).toContain('no published checksum');
    expect(h).toContain('distill-update:page');
  });

  it('warns when processing is under way', () => {
    expect(renderUpdatePage(info(), '0.0.21', { processing: true })).toContain('being processed right now');
  });

  it('cannot be broken out of by a hostile version string', () => {
    const h = renderUpdatePage(info({ version: '1"><script>x</script>' }), '0.0.21', { processing: false });
    expect(h).not.toContain('<script>x');
  });
});

describe('choiceFromUrl', () => {
  it('recognises only our four actions', () => {
    expect(choiceFromUrl('distill-update:install')).toBe('install');
    expect(choiceFromUrl('distill-update:skip')).toBe('skip');
    expect(choiceFromUrl('distill-update:later')).toBe('later');
    expect(choiceFromUrl('distill-update:page')).toBe('page');
    expect(choiceFromUrl('distill-update:rm-rf')).toBeNull();
    expect(choiceFromUrl('https://example.com')).toBeNull();
  });
});

describe('escapeHtml', () => {
  it('escapes the five dangerous characters', () => {
    expect(escapeHtml(`<a href="x">'&'</a>`)).toBe('&lt;a href=&quot;x&quot;&gt;&#39;&amp;&#39;&lt;/a&gt;');
  });
});

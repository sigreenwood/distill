import React from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { describe, expect, it } from 'vitest';
import { MeetingText } from '../src/renderer/reader/MeetingText.js';

const render = (text: string, query = '', markdown = true) =>
  renderToStaticMarkup(React.createElement(MeetingText, { text, query, markdown }));

describe('meeting text rendering', () => {
  it('formats summary headings, lists, emphasis, and tables', () => {
    const html = render('# Decisions\n\n- **Approve** the plan\n\n| Owner | Due |\n| --- | --- |\n| Sam | Friday |');
    expect(html).toContain('<h1>Decisions</h1>');
    expect(html).toContain('<strong>Approve</strong>');
    expect(html).toContain('<ul>');
    expect(html).toContain('<td>Friday</td>');
  });

  it('shows one box per task item and never the raw [ ] marker', () => {
    const html = render('## Actions\n- [ ] Sam — send the deck — Friday\n- [x] Alex — book the room');
    expect(html.match(/☐/g)).toHaveLength(1);
    expect(html.match(/☑/g)).toHaveLength(1);
    expect(html).toContain('aria-label="Not completed"');
    expect(html).not.toMatch(/\[[ x]\]/);
  });

  it('never executes embedded HTML or loads links and images from meeting content', () => {
    const html = render('<script>alert(1)</script>\n\n<img src="https://example.com/pixel" onerror="alert(1)">\n\n[run](javascript:alert(1))\n\n![tracking](https://example.com/image)');
    expect(html).not.toMatch(/<(script|img|a)\b/);
    expect(html).toContain('&lt;script&gt;');
    expect(html).toContain('[Image: tracking]');
  });

  it('matches literal terms case-insensitively and preserves transcript text', () => {
    const html = render('[01:00] A: C++ and c++\n\n# This is dialogue.', 'c++', false);
    expect(html.match(/<mark /g)).toHaveLength(2);
    expect(html).toContain('[01:00] A:');
    expect(html).toContain('# This is dialogue.');
    expect(html).not.toContain('<h1>');
  });
});

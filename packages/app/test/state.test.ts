import { describe, it, expect } from 'vitest';
import { effectiveOutputTargets } from '../src/main/state.js';
import type { OutputsConfig } from '../src/main/config.js';

// effectiveOutputTargets is the one piece of this feature that's a pure
// function — everything else (State.setOutputTargets, the migration, the
// IPC status-flip) touches real SQLite/IPC, which can't run under vitest
// (see CLAUDE.md's note on the Electron ABI trap; no other State SQL
// method has a test either).
describe('effectiveOutputTargets', () => {
  const outputsAllOn: OutputsConfig = {
    markdown: { enabled: true, dir: '/md', includeTranscript: false },
    html: { enabled: true, dir: '/html', includeTranscript: false },
    appleNotes: { enabled: true, parentFolder: 'distill', includeTranscript: false },
  };
  const outputsAllOff: OutputsConfig = {
    markdown: { enabled: false, dir: '/md', includeTranscript: false },
    html: { enabled: false, dir: '/html', includeTranscript: false },
    appleNotes: { enabled: false, parentFolder: 'distill', includeTranscript: false },
  };

  it('inherits the global config when the row has no override', () => {
    const row = { output_markdown: null, output_html: null, output_apple_note: null };
    expect(effectiveOutputTargets(row, outputsAllOn)).toEqual({
      markdown: true,
      html: true,
      appleNote: true,
    });
    expect(effectiveOutputTargets(row, outputsAllOff)).toEqual({
      markdown: false,
      html: false,
      appleNote: false,
    });
  });

  it('an explicit override wins over an enabled global default', () => {
    const row = { output_markdown: 0, output_html: null, output_apple_note: 0 };
    expect(effectiveOutputTargets(row, outputsAllOn)).toEqual({
      markdown: false,
      html: true,
      appleNote: false,
    });
  });

  it('an explicit override wins over a disabled global default', () => {
    const row = { output_markdown: 1, output_html: null, output_apple_note: 1 };
    expect(effectiveOutputTargets(row, outputsAllOff)).toEqual({
      markdown: true,
      html: false,
      appleNote: true,
    });
  });

  it('each destination is independent — mixed overrides and inheritance', () => {
    const row = { output_markdown: 1, output_html: 0, output_apple_note: null };
    expect(effectiveOutputTargets(row, outputsAllOff)).toEqual({
      markdown: true,
      html: false,
      appleNote: false,
    });
  });
});

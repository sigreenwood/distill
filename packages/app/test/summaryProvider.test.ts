import { describe, it, expect } from 'vitest';
import { chooseSummaryProvider, gateClientFor, type ClaudeSummarySettings } from '../src/main/summaryProvider.js';

const on: ClaudeSummarySettings = { enabled: true, model: '', forUnfiled: false };
const allowed = { id: 'acme', claude_summaries: 1 };
const notAllowed = { id: 'acme', claude_summaries: 0 };

describe('chooseSummaryProvider', () => {
  it('stays local when the feature is off, whatever the client says', () => {
    expect(chooseSummaryProvider({ settings: { ...on, enabled: false }, client: allowed }).provider).toBe('ollama');
    expect(chooseSummaryProvider({ settings: { ...on, enabled: false, forUnfiled: true }, client: null }).provider).toBe('ollama');
  });

  it('needs the client to be allowed individually: turning the feature on alone sends nothing', () => {
    expect(chooseSummaryProvider({ settings: on, client: notAllowed }).provider).toBe('ollama');
    expect(chooseSummaryProvider({ settings: on, client: allowed }).provider).toBe('claude-code');
  });

  it('keeps recordings with no client local unless that was asked for', () => {
    expect(chooseSummaryProvider({ settings: on, client: null }).provider).toBe('ollama');
    expect(chooseSummaryProvider({ settings: on, client: { id: 'unclassified', claude_summaries: 1 } }).provider).toBe('ollama');
    expect(chooseSummaryProvider({ settings: { ...on, forUnfiled: true }, client: null }).provider).toBe('claude-code');
    expect(chooseSummaryProvider({ settings: { ...on, forUnfiled: true }, client: { id: 'unclassified', claude_summaries: 0 } }).provider).toBe('claude-code');
  });

  it('only an exact 1 allows a client (not truthy values)', () => {
    expect(chooseSummaryProvider({ settings: on, client: { id: 'a', claude_summaries: 2 } }).provider).toBe('ollama');
  });

  it('always says why', () => {
    for (const client of [null, allowed, notAllowed]) {
      expect(chooseSummaryProvider({ settings: on, client }).reason.length).toBeGreaterThan(10);
    }
  });
});

describe('gateClientFor — a suggestion can deny but never allow', () => {
  const clients: Record<string, { id: string; claude_summaries: number }> = {
    open: { id: 'open', claude_summaries: 1 },
    shut: { id: 'shut', claude_summaries: 0 },
  };
  const lookup = (id: string) => clients[id];

  it('uses the confirmed client, with its real permission', () => {
    expect(gateClientFor({ client_id: 'open', suggested_client_id: null }, lookup)).toEqual({ id: 'open', claude_summaries: 1 });
    expect(gateClientFor({ client_id: 'shut', suggested_client_id: 'open' }, lookup)).toEqual({ id: 'shut', claude_summaries: 0 });
  });

  it('a suggested client never grants permission, even one that is allowed', () => {
    expect(gateClientFor({ client_id: null, suggested_client_id: 'open' }, lookup)).toEqual({ id: 'open', claude_summaries: 0 });
    const settings = { enabled: true, model: '', forUnfiled: true };
    const g = gateClientFor({ client_id: null, suggested_client_id: 'open' }, lookup);
    expect(chooseSummaryProvider({ settings, client: g }).provider).toBe('ollama');
  });

  it('a suggested client also overrides "allow unfiled", so a wrong guess cannot leak', () => {
    const settings = { enabled: true, model: '', forUnfiled: true };
    const g = gateClientFor({ client_id: null, suggested_client_id: 'shut' }, lookup);
    expect(chooseSummaryProvider({ settings, client: g }).provider).toBe('ollama');
  });

  it('is null (unfiled) with no client at all, or ids that no longer exist', () => {
    expect(gateClientFor({ client_id: null, suggested_client_id: null }, lookup)).toBeNull();
    expect(gateClientFor({ client_id: 'gone', suggested_client_id: 'gone' }, lookup)).toBeNull();
  });
});

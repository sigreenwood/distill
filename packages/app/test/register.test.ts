import { describe, expect, it } from 'vitest';
import { checkRegisterAdd, isOverdue, REGISTER_TEXT_MAX, type RegisterAddInput, type RegisterItem } from '../src/shared/register.js';

const base: RegisterAddInput = {
  clientId: 'client-1',
  kind: 'action',
  text: 'Send the pricing sheet',
  sourceRecordingId: 'rec-1',
};

describe('checkRegisterAdd', () => {
  it('accepts a minimal valid action', () => {
    expect(checkRegisterAdd(base)).toEqual({ ok: true, reason: null });
  });

  it('accepts a minimal valid decision', () => {
    expect(checkRegisterAdd({ ...base, kind: 'decision', text: 'Pilot agreed' })).toEqual({ ok: true, reason: null });
  });

  it('rejects a missing client or source meeting', () => {
    expect(checkRegisterAdd({ ...base, clientId: '' }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, clientId: '  ' }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, sourceRecordingId: '' }).ok).toBe(false);
  });

  it('rejects an invalid kind', () => {
    expect(checkRegisterAdd({ ...base, kind: 'todo' as RegisterAddInput['kind'] }).ok).toBe(false);
  });

  it('rejects empty or oversized text', () => {
    expect(checkRegisterAdd({ ...base, text: '' }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, text: '   ' }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, text: 'x'.repeat(REGISTER_TEXT_MAX + 1) }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, text: 'x'.repeat(REGISTER_TEXT_MAX) }).ok).toBe(true);
  });

  it('rejects an oversized owner name', () => {
    expect(checkRegisterAdd({ ...base, owner: 'x'.repeat(101) }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, owner: 'x'.repeat(100) }).ok).toBe(true);
  });

  it('rejects an invalid due date', () => {
    expect(checkRegisterAdd({ ...base, dueAt: 0 }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, dueAt: -1 }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, dueAt: Number.NaN }).ok).toBe(false);
    expect(checkRegisterAdd({ ...base, dueAt: Date.now() + 86_400_000 }).ok).toBe(true);
    expect(checkRegisterAdd({ ...base, dueAt: null }).ok).toBe(true);
  });
});

describe('isOverdue', () => {
  const day = 86_400_000;
  const item = (patch: Partial<Pick<RegisterItem, 'kind' | 'status' | 'dueAt'>>) =>
    ({ kind: 'action' as const, status: 'open' as const, dueAt: null, ...patch });

  it('flags only an open action past its due date', () => {
    expect(isOverdue(item({ dueAt: Date.now() - day }))).toBe(true);
  });

  it('does not flag a decision, a done action, or one with no due date', () => {
    expect(isOverdue(item({ kind: 'decision', status: null, dueAt: Date.now() - day }))).toBe(false);
    expect(isOverdue(item({ status: 'done', dueAt: Date.now() - day }))).toBe(false);
    expect(isOverdue(item({ dueAt: null }))).toBe(false);
  });

  it('does not flag a future due date', () => {
    expect(isOverdue(item({ dueAt: Date.now() + day }))).toBe(false);
  });
});

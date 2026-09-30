import { describe, expect, it } from 'vitest';
import { normaliseConfig } from '../src/main/config.js';

describe('normaliseConfig — adaptiveContextWindow', () => {
  it('defaults to enabled for a fresh config', () => {
    expect(normaliseConfig({}).ollama.adaptiveContextWindow).toBe(true);
  });

  it('honours an explicit false without being coerced back on', () => {
    expect(normaliseConfig({ ollama: { adaptiveContextWindow: false } }).ollama.adaptiveContextWindow).toBe(false);
  });

  it('honours an explicit true', () => {
    expect(normaliseConfig({ ollama: { adaptiveContextWindow: true } }).ollama.adaptiveContextWindow).toBe(true);
  });

  it('falls back to the default for a garbage value rather than throwing', () => {
    expect(normaliseConfig({ ollama: { adaptiveContextWindow: 'yes' } }).ollama.adaptiveContextWindow).toBe(true);
  });
});

import { describe, it, expect } from 'vitest';
import { normaliseConfig, type AppConfig } from '../src/main/config.js';

/**
 * Tests for the contextWindow bump in normaliseConfig. The bump is a
 * one-time migration from the old 32k default to a new 64k default,
 * applied at every config load so existing on-disk configs are
 * silently migrated without a separate JSON-file rewrite step. The
 * critical correctness property is "users who set a manual value
 * (16k, 131k, anything) keep it untouched."
 */

describe('normaliseConfig contextWindow handling', () => {
  it('bumps the legacy 32k default to 64k', () => {
    // Simulates the on-disk shape of every install before the bump:
    // contextWindow=32768 because that was the default at write time.
    const result = normaliseConfig({
      ollama: {
        host: 'http://localhost:11434',
        model: 'qwen2.5:32b',
        contextWindow: 32768,
        temperature: 0.3,
        keepAlive: '5m',
      },
    } as Partial<AppConfig>);
    expect(result.ollama.contextWindow).toBe(65536);
  });

  it('preserves a manually-set value below 32k (e.g. low-RAM mode)', () => {
    const result = normaliseConfig({
      ollama: {
        host: 'http://localhost:11434',
        model: 'qwen2.5:14b',
        contextWindow: 16384,
        temperature: 0.3,
        keepAlive: '5m',
      },
    } as Partial<AppConfig>);
    expect(result.ollama.contextWindow).toBe(16384);
  });

  it('preserves a manually-set value above 32k (e.g. user already bumped to 64k)', () => {
    const result = normaliseConfig({
      ollama: {
        host: 'http://localhost:11434',
        model: 'qwen2.5:32b',
        contextWindow: 65536,
        temperature: 0.3,
        keepAlive: '5m',
      },
    } as Partial<AppConfig>);
    expect(result.ollama.contextWindow).toBe(65536);
  });

  it('preserves a manually-set value of 131072 (qwen2.5:32b max)', () => {
    const result = normaliseConfig({
      ollama: {
        host: 'http://localhost:11434',
        model: 'qwen2.5:32b',
        contextWindow: 131072,
        temperature: 0.3,
        keepAlive: '5m',
      },
    } as Partial<AppConfig>);
    expect(result.ollama.contextWindow).toBe(131072);
  });

  it('uses 64k as the default for fresh installs (no ollama block at all)', () => {
    const result = normaliseConfig({} as Partial<AppConfig>);
    expect(result.ollama.contextWindow).toBe(65536);
  });

  it('preserves all other ollama fields when bumping contextWindow', () => {
    const result = normaliseConfig({
      ollama: {
        host: 'http://10.0.0.5:11434',
        model: 'custom-model',
        contextWindow: 32768,
        temperature: 0.7,
        keepAlive: '24h',
      },
    } as Partial<AppConfig>);
    expect(result.ollama.host).toBe('http://10.0.0.5:11434');
    expect(result.ollama.model).toBe('custom-model');
    expect(result.ollama.temperature).toBe(0.7);
    expect(result.ollama.keepAlive).toBe('24h');
    expect(result.ollama.contextWindow).toBe(65536);
  });

  it('is idempotent: running normaliseConfig twice produces the same result', () => {
    const first = normaliseConfig({
      ollama: {
        host: 'http://localhost:11434',
        model: 'qwen2.5:32b',
        contextWindow: 32768,
        temperature: 0.3,
        keepAlive: '5m',
      },
    } as Partial<AppConfig>);
    const second = normaliseConfig(first);
    expect(second.ollama.contextWindow).toBe(65536);
    expect(second.ollama.contextWindow).toBe(first.ollama.contextWindow);
  });
});

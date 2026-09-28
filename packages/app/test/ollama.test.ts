import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import { OllamaClient, preflightMessage } from '../src/main/ollama.js';

describe('OllamaClient.listTags', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // @ts-expect-error — vitest-style fetch stubbing
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns ok with the model list when Ollama responds', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5:32b', modified_at: 'x', size: 21_000_000_000 },
          { name: 'llama3.2:latest', modified_at: 'x', size: 2_000_000_000 },
        ],
      }),
    });

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.listTags();

    expect(r.ok).toBe(true);
    if (r.ok) {
      expect(r.models.map((m) => m.name)).toEqual(['qwen2.5:32b', 'llama3.2:latest']);
      expect(r.models[0]!.size).toBe(21_000_000_000);
    }
  });

  it('returns ok with an empty list when Ollama is up but no models pulled', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({ models: [] }),
    });

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.listTags();

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.models).toEqual([]);
  });

  it('returns ok with an empty list when Ollama omits the models field', async () => {
    // Older Ollama builds and some custom proxies return `{}` rather
    // than `{ models: [] }`. Tolerate it as "no models" rather than
    // crashing the Settings pane.
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({}),
    });

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.listTags();

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.models).toEqual([]);
  });

  it('reports unreachable on connection refused', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.listTags();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unreachable');
      expect(r.detail).toContain('Connection refused');
    }
  });

  it('reports unreachable on a non-2xx response', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: false,
      status: 503,
      json: async () => ({}),
    });

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.listTags();

    expect(r.ok).toBe(false);
    if (!r.ok) {
      expect(r.reason).toBe('unreachable');
      expect(r.detail).toContain('503');
    }
  });
});

describe('OllamaClient.preflight', () => {
  const originalFetch = global.fetch;

  beforeEach(() => {
    // @ts-expect-error — vitest-style fetch stubbing
    global.fetch = vi.fn();
  });

  afterEach(() => {
    global.fetch = originalFetch;
    vi.restoreAllMocks();
  });

  it('returns ok when the model is installed', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [
          { name: 'qwen2.5:32b', modified_at: 'x', size: 1 },
          { name: 'llama3.2:latest', modified_at: 'x', size: 1 },
        ],
      }),
    });

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.preflight('qwen2.5:32b');

    expect(r.ok).toBe(true);
    if (r.ok) expect(r.model).toBe('qwen2.5:32b');
  });

  it('matches model name with or without :latest suffix', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'qwen3:14b:latest', modified_at: 'x', size: 1 }],
      }),
    });
    const c = new OllamaClient('http://localhost:11434');
    const r = await c.preflight('qwen3:14b');
    expect(r.ok).toBe(true);
  });

  it('reports model-missing with the available list', async () => {
    (global.fetch as ReturnType<typeof vi.fn>).mockResolvedValue({
      ok: true,
      json: async () => ({
        models: [{ name: 'llama3.2:latest', modified_at: 'x', size: 1 }],
      }),
    });

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.preflight('qwen2.5:32b');

    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'model-missing') {
      expect(r.model).toBe('qwen2.5:32b');
      expect(r.available).toEqual(['llama3.2:latest']);
    } else {
      expect.fail(`expected model-missing, got ${JSON.stringify(r)}`);
    }
  });

  it('reports unreachable on connection refused', async () => {
    const err = Object.assign(new Error('connect ECONNREFUSED'), { code: 'ECONNREFUSED' });
    (global.fetch as ReturnType<typeof vi.fn>).mockRejectedValue(err);

    const c = new OllamaClient('http://localhost:11434');
    const r = await c.preflight('qwen2.5:32b');

    expect(r.ok).toBe(false);
    if (!r.ok && r.reason === 'unreachable') {
      expect(r.detail).toContain('Connection refused');
    } else {
      expect.fail(`expected unreachable, got ${JSON.stringify(r)}`);
    }
  });

  it('preflightMessage produces actionable strings', () => {
    expect(preflightMessage({ ok: false, reason: 'unreachable', detail: 'x' })).toContain(
      'ollama serve',
    );
    expect(
      preflightMessage({ ok: false, reason: 'model-missing', model: 'qwen2.5:32b', available: [] }),
    ).toContain('ollama pull qwen2.5:32b');
  });
});

describe('OllamaClient.chat', () => {
  it('sends the thinking control through to Ollama', async () => {
    const originalFetch = global.fetch;
    const body = [
      JSON.stringify({
        model: 'qwen3.8:27b-mlx',
        message: { role: 'assistant', content: 'Summary' },
        done: true,
      }),
    ].join('\n') + '\n';

    // @ts-expect-error — vitest-style fetch stubbing
    global.fetch = vi.fn().mockResolvedValue({
      ok: true,
      body: new ReadableStream({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(body));
          controller.close();
        },
      }),
    });

    try {
      const c = new OllamaClient('http://localhost:11434');
      await c.chat({
        model: 'qwen3.8:27b-mlx',
        messages: [{ role: 'user', content: 'Summarise this.' }],
        think: false,
      });

      const request = (global.fetch as ReturnType<typeof vi.fn>).mock.calls[0];
      expect(JSON.parse(request[1].body)).toMatchObject({
        model: 'qwen3.8:27b-mlx',
        think: false,
        stream: true,
      });
    } finally {
      global.fetch = originalFetch;
      vi.restoreAllMocks();
    }
  });
});

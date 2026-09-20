/**
 * Minimal Ollama HTTP client.
 *
 * v1 uses two endpoints:
 *   GET  /api/tags     → list installed models (pre-flight check)
 *   POST /api/chat     → generate a summary (wired in Milestone 2)
 *
 * Designed as a tiny wrapper rather than pulling in a full SDK. The Ollama
 * HTTP API is stable and simple enough that a dependency would be overkill.
 */

export interface OllamaTag {
  name: string;
  modified_at: string;
  size: number;
}

export interface OllamaChatMessage {
  role: 'system' | 'user' | 'assistant';
  content: string;
}

export interface OllamaChatRequest {
  model: string;
  messages: OllamaChatMessage[];
  /** Disable hidden reasoning for summary generation unless explicitly enabled. */
  think?: boolean;
  /** Internal only — the client always streams; set automatically. */
  stream?: boolean;
  keep_alive?: string;
  options?: {
    num_ctx?: number;
    temperature?: number;
  };
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: OllamaChatMessage;
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export type PreflightResult =
  | { ok: true; model: string }
  | { ok: false; reason: 'unreachable'; detail: string }
  | { ok: false; reason: 'model-missing'; model: string; available: string[] };

/**
 * Result of `OllamaClient.listTags()`. Unlike preflight this doesn't
 * care about a specific model; it just returns the full list. A
 * successful call with no installed models is `ok: true, models: []`.
 */
export type ListTagsResult =
  | { ok: true; models: OllamaTag[] }
  | { ok: false; reason: 'unreachable'; detail: string };

export class OllamaClient {
  constructor(private readonly host: string) {}

  /**
   * List installed models from /api/tags. Used by the Performance
   * settings pane to populate the model dropdown. Returns a tagged
   * result so the caller can distinguish "Ollama is up but no
   * models pulled" from "Ollama is unreachable". Same timeout
   * envelope as preflight — we don't want a slow Ollama to make
   * the Settings window feel laggy.
   */
  async listTags(timeoutMs = 3000): Promise<ListTagsResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, reason: 'unreachable', detail: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { models: OllamaTag[] };
      return { ok: true, models: data.models ?? [] };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const detail = err.code === 'ECONNREFUSED' ? 'Connection refused' : err.message ?? String(e);
      return { ok: false, reason: 'unreachable', detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Check Ollama is reachable and the configured model is installed.
   * Returns a tagged result rather than throwing so the caller can surface
   * a clear, actionable message in the tray.
   */
  async preflight(model: string, timeoutMs = 3000): Promise<PreflightResult> {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), timeoutMs);
    try {
      const res = await fetch(`${this.host}/api/tags`, { signal: ctrl.signal });
      if (!res.ok) {
        return { ok: false, reason: 'unreachable', detail: `HTTP ${res.status}` };
      }
      const data = (await res.json()) as { models: OllamaTag[] };
      const available = data.models.map((m) => m.name);
      // Ollama accepts model names with or without `:latest` suffix for the default tag.
      const has = available.some((n) => n === model || n === `${model}:latest`);
      if (!has) {
        return { ok: false, reason: 'model-missing', model, available };
      }
      return { ok: true, model };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const detail = err.code === 'ECONNREFUSED' ? 'Connection refused' : err.message ?? String(e);
      return { ok: false, reason: 'unreachable', detail };
    } finally {
      clearTimeout(timer);
    }
  }

  /**
   * Chat completion with streaming. Ollama's /api/chat endpoint returns
   * newline-delimited JSON chunks when stream=true; we accumulate them
   * into a full OllamaChatResponse.
   *
   * Why streaming rather than blocking? Long generations against a large
   * transcript (100k+ chars) can take many minutes. Node's undici fetch
   * imposes a ~5 minute bodyTimeout on an idle socket, so a blocking
   * request that spends 10 minutes generating dies with "fetch failed".
   * Streaming keeps the socket active on every token so the timeout
   * never fires.
   *
   * The optional AbortSignal cancels mid-stream. onChunk, when provided,
   * fires for each partial message.content delta — useful for a
   * progress bar in future milestones.
   */
  async chat(
    req: OllamaChatRequest,
    signal?: AbortSignal,
    onChunk?: (partialContent: string) => void,
  ): Promise<OllamaChatResponse> {
    const res = await fetch(`${this.host}/api/chat`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ ...req, stream: true }),
      signal,
    });
    if (!res.ok) {
      const body = await res.text();
      throw new Error(`Ollama ${res.status}: ${body.slice(0, 500)}`);
    }
    if (!res.body) {
      throw new Error('Ollama response had no body');
    }

    // Stream shape: one JSON object per line. Final line has done=true
    // plus summary metrics. Accumulate message.content across chunks.
    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buffer = '';
    let accumulated = '';
    let finalChunk: Partial<OllamaChatResponse> | null = null;

    try {
      while (true) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });

        // Split on newlines; keep any trailing partial line in the buffer.
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: {
            message?: { role: 'assistant'; content: string };
            done?: boolean;
            model?: string;
            created_at?: string;
            total_duration?: number;
            eval_count?: number;
            error?: string;
          };
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            // Ollama has been known to emit non-JSON on internal errors;
            // skip the line rather than blow up the whole stream.
            continue;
          }

          if (parsed.error) {
            throw new Error(`Ollama stream error: ${parsed.error}`);
          }

          const delta = parsed.message?.content ?? '';
          if (delta) {
            accumulated += delta;
            onChunk?.(accumulated);
          }

          if (parsed.done) {
            finalChunk = {
              model: parsed.model,
              created_at: parsed.created_at,
              done: true,
              total_duration: parsed.total_duration,
              eval_count: parsed.eval_count,
            };
          }
        }
      }
    } finally {
      // Release the reader even on error so the connection is freed.
      try {
        reader.releaseLock();
      } catch {
        // reader may already be released if the stream completed normally
      }
    }

    if (!finalChunk) {
      throw new Error('Ollama stream ended without a done=true chunk');
    }

    return {
      model: finalChunk.model ?? req.model,
      created_at: finalChunk.created_at ?? new Date().toISOString(),
      message: { role: 'assistant', content: accumulated },
      done: true,
      total_duration: finalChunk.total_duration,
      eval_count: finalChunk.eval_count,
    };
  }
}

/**
 * Build a human-readable message from a failed preflight result. Used by the
 * tray and log output.
 */
export function preflightMessage(r: Extract<PreflightResult, { ok: false }>): string {
  if (r.reason === 'unreachable') {
    return `Ollama is not reachable (${r.detail}). Start the Ollama app or run: ollama serve`;
  }
  return `Ollama is running but the model "${r.model}" is not installed. Pull it with: ollama pull ${r.model}`;
}

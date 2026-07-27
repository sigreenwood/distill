export interface OllamaModelTag {
  name: string;
  size?: number;
  modified_at?: string;
  details?: { parameter_size?: string; quantization_level?: string };
}

export type ListTagsResult =
  | { ok: true; models: OllamaModelTag[] }
  | { ok: false; reason: 'unreachable'; detail: string };

export type PreflightResult =
  | { ok: true; model: string }
  | { ok: false; reason: 'unreachable'; detail: string }
  | { ok: false; reason: 'model-missing'; model: string; available: string[] };

export interface OllamaChatRequest {
  model: string;
  messages: { role: 'system' | 'user' | 'assistant'; content: string }[];
  options?: { temperature?: number; num_ctx?: number };
  keep_alive?: string;
}

export interface OllamaChatResponse {
  model: string;
  created_at: string;
  message: { role: 'assistant'; content: string };
  done: boolean;
  total_duration?: number;
  eval_count?: number;
}

export class OllamaClient {
  host: string;

  constructor(host: string) {
    this.host = host;
  }

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
      const data = (await res.json()) as { models?: OllamaModelTag[] };
      return { ok: true, models: data.models ?? [] };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const detail = err.code === 'ECONNREFUSED' ? 'Connection refused' : (err.message ?? String(e));
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
      const data = (await res.json()) as { models: { name: string }[] };
      const available = data.models.map((m) => m.name);
      const has = available.some((n) => n === model || n === `${model}:latest`);
      if (!has) {
        return { ok: false, reason: 'model-missing', model, available };
      }
      return { ok: true, model };
    } catch (e) {
      const err = e as NodeJS.ErrnoException;
      const detail = err.code === 'ECONNREFUSED' ? 'Connection refused' : (err.message ?? String(e));
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
    onChunk?: (accumulated: string) => void,
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
        const lines = buffer.split('\n');
        buffer = lines.pop() ?? '';
        for (const line of lines) {
          const trimmed = line.trim();
          if (!trimmed) continue;
          let parsed: any;
          try {
            parsed = JSON.parse(trimmed);
          } catch {
            continue;
          }
          if (parsed.error) {
            throw new Error(`Ollama stream error: ${parsed.error}`);
          }
          const delta: string = parsed.message?.content ?? '';
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
      try {
        reader.releaseLock();
      } catch {
        // stream already closed
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

export interface PullProgress {
  status: string;
  completed?: number;
  total?: number;
  /** 0–100 when total is known, null for indeterminate phases */
  percent: number | null;
}

/**
 * Pull a model via Ollama's /api/pull, streaming NDJSON progress. Used by
 * the Settings → Performance "Download" action after the user approves a
 * suggested model. Long-running (tens of GB); pass an AbortSignal to let
 * the user cancel.
 */
export async function pullModel(
  host: string,
  model: string,
  onProgress: (p: PullProgress) => void,
  signal?: AbortSignal,
): Promise<void> {
  const res = await fetch(`${host}/api/pull`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ model, stream: true }),
    signal,
  });
  if (!res.ok) {
    const body = await res.text();
    throw new Error(`Ollama pull ${res.status}: ${body.slice(0, 300)}`);
  }
  if (!res.body) throw new Error('Ollama pull response had no body');
  const reader = res.body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  try {
    while (true) {
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      const lines = buffer.split('\n');
      buffer = lines.pop() ?? '';
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed) continue;
        let parsed: any;
        try {
          parsed = JSON.parse(trimmed);
        } catch {
          continue;
        }
        if (parsed.error) throw new Error(`Ollama pull error: ${parsed.error}`);
        const total: number | undefined = parsed.total;
        const completed: number | undefined = parsed.completed;
        onProgress({
          status: parsed.status ?? '',
          completed,
          total,
          percent:
            typeof total === 'number' && total > 0 && typeof completed === 'number'
              ? Math.min(100, Math.floor((completed / total) * 100))
              : null,
        });
      }
    }
  } finally {
    try {
      reader.releaseLock();
    } catch {
      // stream already closed
    }
  }
}

export function preflightMessage(r: Exclude<PreflightResult, { ok: true }>): string {
  if (r.reason === 'unreachable') {
    return `Ollama is not reachable (${r.detail}). Start the Ollama app or run: ollama serve`;
  }
  return `Ollama is running but the model "${r.model}" is not installed. Pull it with: ollama pull ${r.model}`;
}

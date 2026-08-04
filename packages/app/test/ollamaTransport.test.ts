import { describe, it, expect, afterEach } from 'vitest';
import http from 'node:http';
import { OllamaClient } from '../src/main/ollama.js';

/**
 * Coverage for the node:http transport that replaced fetch in
 * OllamaClient.chat.
 *
 * The bug being guarded against: Node's fetch (undici) closes a socket
 * that has been idle for 5 minutes. Ollama emits nothing at all while
 * processing a long prompt, so a big transcript on a large model
 * produced a bare "fetch failed" at ~302s — measured on a real machine,
 * three times consecutively, with a fourth attempt succeeding in 234s
 * once the model was warm.
 *
 * The 300-second case can't reasonably be unit tested; a standalone
 * experiment confirmed fetch fails at 301s where node:http survives
 * 320s. These tests cover everything else about the rewritten
 * transport, since it is hand-rolled and easy to regress.
 */

let server: http.Server | undefined;

async function serve(handler: http.RequestListener): Promise<string> {
  server = http.createServer(handler);
  await new Promise<void>((r) => server!.listen(0, '127.0.0.1', r));
  const addr = server.address();
  if (typeof addr === 'string' || !addr) throw new Error('no port');
  return `http://127.0.0.1:${addr.port}`;
}

function ndjson(...objs: unknown[]): string {
  return objs.map((o) => JSON.stringify(o) + '\n').join('');
}

afterEach(async () => {
  if (server) await new Promise<void>((r) => server!.close(() => r()));
  server = undefined;
});

const REQ = { model: 'test', messages: [{ role: 'user' as const, content: 'hi' }] };

describe('OllamaClient.chat transport', () => {
  it('assembles streamed deltas into one message', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(200);
      res.end(
        ndjson(
          { message: { content: 'Hello' } },
          { message: { content: ' world' } },
          { message: { content: '' }, done: true, model: 'test:v1', eval_count: 7 },
        ),
      );
    });
    const r = await new OllamaClient(host).chat(REQ);
    expect(r.message.content).toBe('Hello world');
    expect(r.model).toBe('test:v1');
    expect(r.eval_count).toBe(7);
  });

  it('handles a chunk split across packet boundaries', async () => {
    // A JSON object arriving in two TCP writes must not be dropped —
    // the parser buffers on newlines, not on read events.
    const host = await serve((_req, res) => {
      res.writeHead(200);
      const full = ndjson({ message: { content: 'split' } }, { done: true, model: 'm' });
      res.write(full.slice(0, 12));
      setTimeout(() => res.end(full.slice(12)), 20);
    });
    const r = await new OllamaClient(host).chat(REQ);
    expect(r.message.content).toBe('split');
  });

  it('reports progress for each delta', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(200);
      res.end(ndjson({ message: { content: 'a' } }, { message: { content: 'b' } }, { done: true }));
    });
    const seen: string[] = [];
    await new OllamaClient(host).chat(REQ, undefined, (acc) => seen.push(acc));
    expect(seen).toEqual(['a', 'ab']);
  });

  it('surfaces an HTTP error with the body', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(404);
      res.end('{"error":"model not found"}');
    });
    await expect(new OllamaClient(host).chat(REQ)).rejects.toThrow(/404.*model not found/);
  });

  it('surfaces an error delivered mid-stream', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(200);
      res.end(ndjson({ message: { content: 'partial' } }, { error: 'out of memory' }));
    });
    await expect(new OllamaClient(host).chat(REQ)).rejects.toThrow(/out of memory/);
  });

  it('rejects when the stream ends without done=true', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(200);
      res.end(ndjson({ message: { content: 'truncated' } }));
    });
    await expect(new OllamaClient(host).chat(REQ)).rejects.toThrow(/without a done=true/);
  });

  it('aborts a request that is still streaming', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(200);
      res.write(ndjson({ message: { content: 'start' } }));
      // never ends
    });
    const ac = new AbortController();
    setTimeout(() => ac.abort(), 50);
    await expect(new OllamaClient(host).chat(REQ, ac.signal)).rejects.toMatchObject({
      name: 'AbortError',
    });
  });

  it('rejects immediately when given an already-aborted signal', async () => {
    const host = await serve((_req, res) => {
      res.writeHead(200);
      res.end(ndjson({ done: true }));
    });
    await expect(
      new OllamaClient(host).chat(REQ, AbortSignal.abort()),
    ).rejects.toMatchObject({ name: 'AbortError' });
  });

  it('explains a refused connection in terms of Ollama, not errno', async () => {
    // Port 1 is reserved and never listening.
    await expect(new OllamaClient('http://127.0.0.1:1').chat(REQ)).rejects.toThrow(
      /not reachable.*connection refused/i,
    );
  });
});

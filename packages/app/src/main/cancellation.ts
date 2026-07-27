export class CancelledError extends Error {
  constructor(step: string) {
    super(`Step '${step}' cancelled`);
    this.name = 'CancelledError';
  }
}

export function isCancelled(e: unknown): boolean {
  return e instanceof CancelledError || (e instanceof Error && e.name === 'AbortError');
}

export function throwIfAborted(signal: AbortSignal, step: string): void {
  if (signal.aborted) throw new CancelledError(step);
}

import type { OllamaConfig } from './config.js';

/**
 * Refuse to send meeting-derived text anywhere but a local Ollama server
 * running a downloaded model. The configured host could point at another
 * machine, and Ollama's `-cloud` models run remotely.
 */
export function assertLocalInference(config: OllamaConfig, feature: string): void {
  const host = new URL(config.host);
  if (!['http:', 'https:'].includes(host.protocol)
    || !['localhost', '127.0.0.1', '[::1]'].includes(host.hostname) || /cloud/i.test(config.model)) {
    throw new Error(`${feature} requires a local Ollama server and a downloaded local model.`);
  }
}

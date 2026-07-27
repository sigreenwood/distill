/**
 * Hardware-aware Ollama model recommendations + newer-generation detection.
 *
 * Two jobs:
 *  1. recommendModelForRam() — pick a sensible default summarisation model
 *     for this Mac's unified memory. Used for fresh-install config defaults
 *     and surfaced in Settings → About.
 *  2. checkForNewerGeneration() — probe the Ollama registry for a newer
 *     generation of the configured model family (qwen3.6 → qwen3.7 → qwen4)
 *     so the app can *suggest* an upgrade. Never downloads anything on its
 *     own — self-maintaining features are suggestion-only by decision.
 *
 * Kept free of Electron imports so it unit-tests in plain Node.
 */

export interface ModelRecommendation {
  model: string;
  reason: string;
}

/**
 * Tiers assume the model shares unified memory with macOS, Electron, and
 * MLX Whisper. Rule of thumb: keep resident weights under ~70% of RAM so
 * a 64k-token KV cache and the rest of the system still fit.
 *
 * Sizes as of July 2026 (Ollama library):
 *   qwen3.6:35b ≈ 24GB · qwen3.6:27b ≈ 17GB · qwen3.5:9b ≈ 6.6GB ·
 *   qwen3.5:4b ≈ 3.4GB
 */
const RAM_TIERS: { minGb: number; model: string; reason: string }[] = [
  {
    minGb: 48,
    model: 'qwen3.6:35b',
    reason: '48GB+ unified memory fits the 35B flagship (~24GB resident) with headroom.',
  },
  {
    minGb: 24,
    model: 'qwen3.6:27b',
    reason: '24–36GB fits the 27B dense model (~17GB resident); best quality that leaves room for the system.',
  },
  {
    minGb: 16,
    model: 'qwen3.5:9b',
    reason: '16GB fits the 9B model (~7GB resident) while keeping the Mac responsive during processing.',
  },
  {
    minGb: 0,
    model: 'qwen3.5:4b',
    reason: 'Under 16GB, the 4B model is the largest that runs comfortably.',
  },
];

export function recommendModelForRam(totalRamBytes: number): ModelRecommendation {
  const gb = totalRamBytes / (1024 * 1024 * 1024);
  for (const tier of RAM_TIERS) {
    if (gb >= tier.minGb) return { model: tier.model, reason: tier.reason };
  }
  // Unreachable (last tier is 0), but keeps the compiler honest.
  const last = RAM_TIERS[RAM_TIERS.length - 1];
  return { model: last.model, reason: last.reason };
}

/** All tiers, for rendering the "Choosing a local model" table in About. */
export function recommendationTable(): { ram: string; model: string }[] {
  return [
    { ram: '48GB or more', model: 'qwen3.6:35b' },
    { ram: '24–36GB', model: 'qwen3.6:27b' },
    { ram: '16GB', model: 'qwen3.5:9b' },
    { ram: 'under 16GB', model: 'qwen3.5:4b' },
  ];
}

// --- newer-generation detection -------------------------------------------

export interface ParsedModelName {
  /** e.g. "qwen" */
  family: string;
  /** e.g. 3.6 as [3, 6]; [3] for "qwen3"; null when unversioned ("llama") */
  version: number[] | null;
  /** e.g. "27b" — everything after the colon, '' when no tag */
  tag: string;
}

/** Parse "qwen3.6:27b" → { family: "qwen", version: [3,6], tag: "27b" }. */
export function parseModelName(name: string): ParsedModelName | null {
  const [base, tag = ''] = name.split(':');
  const m = base.match(/^([a-z][a-z-]*?)(\d+(?:\.\d+)?)?$/i);
  if (!m) return null;
  const family = m[1];
  const version = m[2] ? m[2].split('.').map((n) => parseInt(n, 10)) : null;
  return { family, version, tag };
}

/**
 * Candidate successor library names for a versioned family, most-preferred
 * first: next minor versions (3.7, 3.8), then the next major (4, 4.5).
 * We probe a small fixed set rather than crawling the registry — the
 * Ollama library has no public listing API, but library pages 404 for
 * models that don't exist, which makes existence probes reliable.
 */
export function successorCandidates(parsed: ParsedModelName): string[] {
  if (!parsed.version || parsed.version.length === 0) return [];
  const [major, minor] = parsed.version;
  const out: string[] = [];
  if (minor !== undefined) {
    out.push(`${parsed.family}${major}.${minor + 1}`);
    out.push(`${parsed.family}${major}.${minor + 2}`);
    out.push(`${parsed.family}${major + 1}`);
    out.push(`${parsed.family}${major + 1}.5`);
  } else {
    out.push(`${parsed.family}${major}.5`);
    out.push(`${parsed.family}${major + 1}`);
  }
  return out;
}

export interface ModelSuggestion {
  /** Library name that exists, e.g. "qwen3.7" */
  newFamily: string;
  /** Concrete pull target keeping the user's size tag, e.g. "qwen3.7:27b" */
  suggestedModel: string;
  currentModel: string;
  checkedAt: number;
}

export type ProbeFetch = (url: string) => Promise<{ status: number; ok: boolean }>;

/**
 * Probe the Ollama registry for a newer generation of the current model's
 * family. Returns the *newest* candidate that exists (later candidates in
 * successorCandidates() are newer, so the last hit wins), or null.
 *
 * Network failures return null — this runs opportunistically in the
 * background and must never surface an error for a nice-to-have check.
 */
export async function checkForNewerGeneration(
  currentModel: string,
  probe: ProbeFetch,
): Promise<ModelSuggestion | null> {
  const parsed = parseModelName(currentModel);
  if (!parsed) return null;
  const candidates = successorCandidates(parsed);
  let best: string | null = null;
  for (const candidate of candidates) {
    try {
      const res = await probe(`https://ollama.com/library/${candidate}`);
      if (res.ok) best = candidate;
    } catch {
      // offline or registry hiccup — treat as "not found"
    }
  }
  if (!best) return null;
  return {
    newFamily: best,
    suggestedModel: parsed.tag ? `${best}:${parsed.tag}` : best,
    currentModel,
    checkedAt: Date.now(),
  };
}

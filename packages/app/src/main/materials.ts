/**
 * Meeting materials: attach files to a recording, and make notes from each
 * one in a model pass of its own before the meeting is summarised (see
 * shared/materials.ts for the rules and prompts).
 *
 * Notes are made once and stored; a failed file is recorded on its row and
 * the summary goes ahead without it. Everything runs on this Mac: the deck
 * text is read by python/materials_extract.py, images are scaled with the
 * system's `sips`, and the passes go to the configured local Ollama model.
 */
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import {
  IMAGE_NOTES_PROMPT,
  MAX_MATERIAL_BYTES,
  SLIDES_NOTES_PROMPT,
  VERBATIM_MAX_CHARS,
  batchSlides,
  formatSlides,
  materialKind,
  type ExtractedSlide,
  type MaterialDTO,
  type MaterialNotes,
} from '../shared/materials.js';
import { throwIfAborted } from './cancellation.js';
import type { Logger } from './logger.js';
import type { OllamaClient } from './ollama.js';
import type { MaterialRow, State } from './state.js';

export interface MaterialsContext {
  state: State;
  logger: Logger;
  ollama: OllamaClient;
  ollamaConfig: { model: string; keepAlive: string; temperature: number };
  pythonBinary: string;
  extractScript: string;
}

/** Longest edge sent to the vision model: slide and screen text stays legible, and the image stays a few thousand tokens. */
const IMAGE_MAX_EDGE = 2000;
/** Each notes pass reads one file (or one batch of slides) and nothing else, so it needs far less context than a summary. */
const NOTES_NUM_CTX = 16_384;

export function toMaterialDTO(row: MaterialRow): MaterialDTO {
  return {
    id: row.id,
    filename: row.filename,
    kind: row.kind,
    status: row.notes ? 'ready' : row.error ? 'error' : 'pending',
    notesModel: row.notes_model,
    notes: row.notes,
    error: row.error,
    addedAt: row.added_at,
  };
}

/** Validates renderer-supplied paths: absolute, existing, a supported type, and not huge. */
export function validateMaterialPaths(value: unknown): string[] {
  if (!Array.isArray(value) || value.length === 0) throw new Error('Choose at least one file to attach.');
  const out = new Set<string>();
  for (const file of value) {
    if (typeof file !== 'string' || file.includes('\0') || !path.isAbsolute(file)) {
      throw new Error('Attachments must be absolute file paths.');
    }
    if (!materialKind(file)) throw new Error(`${path.basename(file)} is not a slide deck, PDF or image.`);
    out.add(path.normalize(file));
  }
  return [...out];
}

export async function attachMaterials(
  state: State,
  recordingId: string,
  files: string[],
  materialsRoot: string,
): Promise<{ added: number; duplicates: number }> {
  let added = 0;
  let duplicates = 0;
  const dir = path.join(materialsRoot, recordingId);
  fs.mkdirSync(dir, { recursive: true });
  for (const file of files) {
    const kind = materialKind(file)!;
    const stat = await fs.promises.stat(file);
    if (!stat.isFile()) throw new Error(`${path.basename(file)} is not a file.`);
    if (stat.size > MAX_MATERIAL_BYTES) throw new Error(`${path.basename(file)} is larger than 200 MB.`);
    const bytes = await fs.promises.readFile(file);
    const sha1 = crypto.createHash('sha1').update(bytes).digest('hex');
    const id = crypto.randomUUID();
    const stored = path.join(dir, `${id}${path.extname(file).toLowerCase()}`);
    await fs.promises.writeFile(stored, bytes);
    const inserted = state.addMaterial({
      id, recording_id: recordingId, filename: path.basename(file), kind, stored_path: stored, sha1, added_at: Date.now(),
    });
    if (inserted) added++;
    else {
      duplicates++;
      await fs.promises.rm(stored, { force: true });
    }
  }
  return { added, duplicates };
}

export async function removeMaterial(state: State, id: string): Promise<void> {
  const row = state.getMaterial(id);
  if (!row) return;
  state.deleteMaterial(id);
  await fs.promises.rm(row.stored_path, { force: true });
}

function run(binary: string, args: string[], signal?: AbortSignal): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn(binary, args, { signal });
    let out = '';
    let err = '';
    proc.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    proc.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    proc.once('error', reject);
    proc.once('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(err.trim().split('\n').pop()?.slice(0, 300) || `exit ${code}`)),
    );
  });
}

async function extractSlides(row: MaterialRow, ctx: MaterialsContext, signal: AbortSignal): Promise<ExtractedSlide[]> {
  const stdout = await run(ctx.pythonBinary, ['-I', ctx.extractScript, row.stored_path], signal);
  return (JSON.parse(stdout) as { slides: ExtractedSlide[] }).slides;
}

/** JPEG, longest edge at most IMAGE_MAX_EDGE, via macOS `sips` — also turns HEIC and TIFF into something the model reads. */
async function imageForModel(row: MaterialRow, signal: AbortSignal): Promise<string> {
  const tmp = path.join(os.tmpdir(), `distill-material-${row.id}.jpg`);
  try {
    await run('/usr/bin/sips', ['-s', 'format', 'jpeg', '-Z', String(IMAGE_MAX_EDGE), row.stored_path, '--out', tmp], signal);
    return (await fs.promises.readFile(tmp)).toString('base64');
  } finally {
    await fs.promises.rm(tmp, { force: true });
  }
}

async function notesPass(
  ctx: MaterialsContext,
  system: string,
  user: string,
  images: string[] | undefined,
  signal: AbortSignal,
): Promise<{ text: string; model: string }> {
  const response = await ctx.ollama.chat(
    {
      model: ctx.ollamaConfig.model,
      messages: [
        { role: 'system', content: system },
        { role: 'user', content: user, ...(images ? { images } : {}) },
      ],
      think: false,
      keep_alive: ctx.ollamaConfig.keepAlive,
      options: { temperature: 0, num_ctx: NOTES_NUM_CTX },
    },
    signal,
  );
  const text = response.message.content.trim();
  if (!text) throw new Error('The model returned no notes.');
  return { text, model: response.model };
}

/** Notes for one file; throws on failure (the caller records it). */
export async function makeMaterialNotes(
  row: MaterialRow,
  ctx: MaterialsContext,
  signal: AbortSignal,
): Promise<{ notes: string; model: string }> {
  if (row.kind === 'image') {
    const image = await imageForModel(row, signal);
    const { text, model } = await notesPass(ctx, IMAGE_NOTES_PROMPT, `Screenshot: ${row.filename}`, [image], signal);
    return { notes: text, model };
  }
  const slides = await extractSlides(row, ctx, signal);
  const all = formatSlides(slides);
  if (!all.trim()) throw new Error('No text found — a deck of pictures only. Attach screenshots of the slides instead.');
  if (all.length <= VERBATIM_MAX_CHARS) return { notes: all, model: 'verbatim' };
  // A long deck in batches of slides, one pass each, so no pass is cut short.
  const batches = batchSlides(slides);
  const parts: string[] = [];
  let model = '';
  for (const [i, batch] of batches.entries()) {
    throwIfAborted(signal, 'summarise');
    const label = batches.length > 1 ? ` (part ${i + 1} of ${batches.length})` : '';
    const result = await notesPass(ctx, SLIDES_NOTES_PROMPT, `Material: ${row.filename}${label}\n\n${batch}`, undefined, signal);
    parts.push(result.text);
    model = result.model;
  }
  return { notes: parts.join('\n\n'), model };
}

/**
 * Make notes for every attached file that has none yet, one file at a
 * time, then return all usable notes in attachment order. A file that
 * fails keeps its error and is left out; it never fails the summary.
 * Cancellation does propagate, so stopping a run stops here too.
 */
export async function ensureMaterialNotes(
  recordingId: string,
  ctx: MaterialsContext,
  signal: AbortSignal,
): Promise<MaterialNotes[]> {
  for (const row of ctx.state.listMaterials(recordingId)) {
    if (row.notes || row.error) continue;
    throwIfAborted(signal, 'summarise');
    const started = Date.now();
    try {
      const result = await makeMaterialNotes(row, ctx, signal);
      ctx.state.setMaterialNotes(row.id, result);
      ctx.logger.info(
        { recordingId, materialId: row.id, kind: row.kind, model: result.model, chars: result.notes.length, ms: Date.now() - started },
        'material notes made',
      );
    } catch (e) {
      if (signal.aborted) throw e;
      const error = e instanceof Error ? e.message : String(e);
      ctx.state.setMaterialNotes(row.id, { error });
      ctx.logger.warn({ recordingId, materialId: row.id, kind: row.kind, err: error }, 'material notes failed');
    }
  }
  return ctx.state
    .listMaterials(recordingId)
    .flatMap((r) => (r.notes ? [{ filename: r.filename, notes: r.notes }] : []));
}

import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { describe, expect, it } from 'vitest';
import {
  MATERIALS_TOTAL_MAX_CHARS,
  MATERIAL_NOTES_MAX_CHARS,
  VERBATIM_MAX_CHARS,
  batchSlides,
  buildMaterialsContext,
  formatSlides,
  materialKind,
  type ExtractedSlide,
} from '../src/shared/materials.js';
import { buildSummaryUserContent } from '../src/shared/summaryInput.js';
import { ensureMaterialNotes, validateMaterialPaths, type MaterialsContext } from '../src/main/materials.js';
import type { MaterialRow, State } from '../src/main/state.js';

const slide = (n: number, text: string, notes = ''): ExtractedSlide => ({ n, text, notes, hidden: false });

describe('materials rules', () => {
  it('recognises decks, PDFs and images by extension', () => {
    expect(materialKind('Deck.PPTX')).toBe('slides');
    expect(materialKind('a.pdf')).toBe('slides');
    expect(materialKind('shot.HEIC')).toBe('image');
    expect(materialKind('notes.docx')).toBeNull();
    expect(() => validateMaterialPaths(['/tmp/x.docx'])).toThrow(/not a slide deck/);
    expect(() => validateMaterialPaths(['relative.png'])).toThrow(/absolute/);
  });

  it('formats slides with notes and skips empty ones', () => {
    expect(formatSlides([slide(1, 'Title', 'Say hello'), slide(2, ''), { ...slide(3, 'Backup'), hidden: true }])).toBe(
      '[Slide 1]\nTitle\nSpeaker notes: Say hello\n\n[Slide 3, hidden]\nBackup',
    );
  });

  it('batches consecutive slides without exceeding the limit', () => {
    const slides = Array.from({ length: 10 }, (_, i) => slide(i + 1, 'x'.repeat(90)));
    const batches = batchSlides(slides, 300);
    expect(batches.length).toBeGreaterThan(1);
    expect(batches.every((b) => b.length <= 300)).toBe(true);
    expect(batches.join('\n\n')).toBe(formatSlides(slides));
  });

  it('caps each file and the total, and marks material as background', () => {
    const big = 'y'.repeat(MATERIAL_NOTES_MAX_CHARS * 2);
    const block = buildMaterialsContext([1, 2, 3, 4].map((i) => ({ filename: `f${i}.pptx`, notes: big })));
    expect(block).toMatch(/not part of the conversation/);
    expect(block).toMatch(/shortened/);
    expect(block.length).toBeLessThan(MATERIALS_TOTAL_MAX_CHARS + 1_500);
    expect(buildMaterialsContext([{ filename: 'a', notes: '  ' }])).toBe('');
  });

  it('puts materials after the account context and before the transcript', () => {
    const content = buildSummaryUserContent({
      transcript: 'TRANSCRIPT',
      attendeesJson: null,
      account: { clientName: 'Acme', context: 'ACCOUNT' },
      materials: [{ filename: 'deck.pptx', notes: 'NOTES' }],
    });
    expect(content.indexOf('ACCOUNT')).toBeLessThan(content.indexOf('NOTES'));
    expect(content.indexOf('NOTES')).toBeLessThan(content.indexOf('TRANSCRIPT'));
  });
});

function fakeState(rows: MaterialRow[]): State {
  return {
    listMaterials: (id: string) => rows.filter((r) => r.recording_id === id),
    setMaterialNotes: (id: string, result: { notes: string; model: string } | { error: string }) => {
      const r = rows.find((x) => x.id === id)!;
      if ('notes' in result) Object.assign(r, { notes: result.notes, notes_model: result.model, error: null });
      else Object.assign(r, { error: result.error });
    },
  } as unknown as State;
}

const logger = { info() {}, warn() {} } as unknown as MaterialsContext['logger'];
const python = ['/usr/bin/python3', '/opt/homebrew/bin/python3'].find((p) => fs.existsSync(p));
const script = path.join(__dirname, '..', 'python', 'materials_extract.py');

/** A minimal .pptx: two slides, the second with speaker notes, in presentation order 2 → 1 to prove order comes from presentation.xml. */
function writePptx(file: string, slideTexts: string[]): void {
  const py = `
import sys, zipfile
texts = sys.argv[2:]
A='xmlns:a="http://schemas.openxmlformats.org/drawingml/2006/main" xmlns:p="http://schemas.openxmlformats.org/presentationml/2006/main" xmlns:r="http://schemas.openxmlformats.org/officeDocument/2006/relationships"'
def sp(t): return '<p:sp><p:txBody><a:p><a:r><a:t>%s</a:t></a:r></a:p></p:txBody></p:sp>' % t
with zipfile.ZipFile(sys.argv[1], 'w') as z:
    ids = ''.join('<p:sldId id="%d" r:id="rId%d"/>' % (256 + i, i) for i in reversed(range(1, len(texts) + 1)))
    z.writestr('ppt/presentation.xml', '<p:presentation %s><p:sldIdLst>%s</p:sldIdLst></p:presentation>' % (A, ids))
    rels = ''.join('<Relationship Id="rId%d" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/slide" Target="slides/slide%d.xml"/>' % (i, i) for i in range(1, len(texts) + 1))
    z.writestr('ppt/_rels/presentation.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships">%s</Relationships>' % rels)
    for i, t in enumerate(texts, start=1):
        z.writestr('ppt/slides/slide%d.xml' % i, '<p:sld %s><p:cSld><p:spTree>%s</p:spTree></p:cSld></p:sld>' % (A, sp(t)))
    z.writestr('ppt/slides/_rels/slide2.xml.rels', '<Relationships xmlns="http://schemas.openxmlformats.org/package/2006/relationships"><Relationship Id="rId1" Type="http://schemas.openxmlformats.org/officeDocument/2006/relationships/notesSlide" Target="../notesSlides/notesSlide2.xml"/></Relationships>')
    z.writestr('ppt/notesSlides/notesSlide2.xml', '<p:notes %s><p:cSld><p:spTree>%s</p:spTree></p:cSld></p:notes>' % (A, sp('Mention the Q3 date')))
`;
  execFileSync(python!, ['-c', py, file, ...slideTexts]);
}

describe.skipIf(!python)('ensureMaterialNotes', () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'distill-materials-'));
  const row = (id: string, file: string, kind: MaterialRow['kind'] = 'slides'): MaterialRow => ({
    id, recording_id: 'rec', filename: path.basename(file), kind, stored_path: file, sha1: id,
    notes: null, notes_model: null, error: null, added_at: 1, notes_at: null,
  });

  it('uses a small deck verbatim, reads a long one in a pass per batch, and records failures', async () => {
    const small = path.join(dir, 'small.pptx');
    writePptx(small, ['Agenda', 'Timeline']);
    const long = path.join(dir, 'long.pptx');
    writePptx(long, Array.from({ length: 12 }, (_, i) => `Slide body ${i} ${'z'.repeat(VERBATIM_MAX_CHARS / 4)}`));
    const rows = [row('m1', small), row('m2', long), row('m3', path.join(dir, 'missing.pptx'))];
    const calls: string[] = [];
    const ctx: MaterialsContext = {
      state: fakeState(rows),
      logger,
      ollama: {
        chat: async (req: { messages: { content: string }[] }) => {
          calls.push(req.messages[1].content);
          return { model: 'test-model', message: { content: `notes ${calls.length}` } };
        },
      } as unknown as MaterialsContext['ollama'],
      ollamaConfig: { model: 'test-model', keepAlive: '5m', temperature: 0 },
      pythonBinary: python!,
      extractScript: script,
    };
    const notes = await ensureMaterialNotes('rec', ctx, new AbortController().signal);

    expect(rows[0]).toMatchObject({ notes_model: 'verbatim' });
    expect(rows[0].notes).toBe('[Slide 1]\nTimeline\nSpeaker notes: Mention the Q3 date\n\n[Slide 2]\nAgenda');
    expect(calls.length).toBeGreaterThanOrEqual(1);
    expect(calls.every((c) => c.startsWith('Material: long.pptx'))).toBe(true);
    expect(rows[1]).toMatchObject({ notes_model: 'test-model' });
    expect(rows[2].error).toBeTruthy();
    expect(notes.map((n) => n.filename)).toEqual(['small.pptx', 'long.pptx']);

    // Made once: a second run makes no new passes, and a failure is not retried until reset.
    const passes = calls.length;
    await ensureMaterialNotes('rec', ctx, new AbortController().signal);
    expect(calls.length).toBe(passes);
  });
});

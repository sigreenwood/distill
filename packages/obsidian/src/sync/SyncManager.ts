import { Notice, normalizePath, TFile } from 'obsidian';
import { join } from 'path';
import type PlaudPlugin from '../../main';
import type { PlaudFile, PlaudFileDetail, SyncStatus, TranscriptionResult } from '../types';

export class SyncManager {
  private intervalId: number | null = null;
  private isSyncing = false;
  public onStatusChange?: (status: SyncStatus) => void;

  constructor(private plugin: PlaudPlugin) {}

  start(): void {
    const { syncIntervalMinutes } = this.plugin.settings;
    if (syncIntervalMinutes === 0) return;
    this.intervalId = window.setInterval(
      () => this.syncNow(),
      syncIntervalMinutes * 60_000,
    );
  }

  stop(): void {
    if (this.intervalId !== null) {
      window.clearInterval(this.intervalId);
      this.intervalId = null;
    }
  }

  restart(): void {
    this.stop();
    this.start();
  }

  async syncNow(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync already in progress.');
      return;
    }

    this.isSyncing = true;
    this.setStatus({ state: 'syncing', message: 'Fetching recordings list…' });

    try {
      const remote: PlaudFile[] = await this.plugin.plaudClient.listRecordings();
      const newOnes = remote.filter(
        r => !r.is_trash && !this.plugin.settings.syncedIds.includes(r.id),
      );

      if (newOnes.length === 0) {
        new Notice('Plaud: no new recordings found.');
        this.setStatus({ state: 'idle', message: 'Up to date' });
        return;
      }

      new Notice(`Plaud: syncing ${newOnes.length} new recording(s)…`);

      for (let i = 0; i < newOnes.length; i++) {
        const rec = newOnes[i];
        try {
          await this.syncOne(rec, i + 1, newOnes.length);
        } catch (err: any) {
          console.error(`Plaud: failed to sync recording ${rec.id}`, err);
          new Notice(`Plaud: error syncing "${rec.filename ?? rec.id}": ${err.message}`);
        }
      }

      new Notice(`Plaud: sync complete. ${newOnes.length} note(s) created.`);
      this.setStatus({ state: 'idle', message: `Last sync: ${new Date().toLocaleTimeString()}` });
    } catch (err: any) {
      console.error('Plaud: sync failed', err);
      new Notice(`Plaud sync error: ${err.message}`);
      this.setStatus({ state: 'error', message: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  private async syncOne(rec: PlaudFile, index: number, total: number): Promise<void> {
    const label = rec.filename ?? rec.id;

    // ── Download audio ────────────────────────────────────────────────────
    this.setStatus({
      state: 'downloading',
      message: `(${index}/${total}) Downloading "${label}"…`,
      recordingId: rec.id,
    });

    const audioFolder = this.plugin.settings.audioFolder;
    await this.ensureVaultFolder(audioFolder);

    const ext = rec.fullname?.split('.').pop() ?? 'opus';
    const datePrefix = toFileDatePrefix(rec.start_time);
    const audioFilename = `${datePrefix}_${rec.id}.${ext}`;
    const audioVaultPath = normalizePath(`${audioFolder}/${audioFilename}`);

    if (!this.plugin.app.vault.getAbstractFileByPath(audioVaultPath)) {
      const buffer = await this.plugin.plaudClient.downloadAudioBuffer(rec.id);
      await this.plugin.app.vault.createBinary(audioVaultPath, buffer);
    }

    // ── Fetch MP3 (always try when original is .opus) ─────────────────────
    let bestAudioPath = audioVaultPath;

    if (ext === 'opus') {
      const mp3Filename = `${datePrefix}_${rec.id}.mp3`;
      const mp3VaultPath = normalizePath(`${audioFolder}/${mp3Filename}`);

      if (this.plugin.app.vault.getAbstractFileByPath(mp3VaultPath)) {
        bestAudioPath = mp3VaultPath;
      } else {
        this.setStatus({
          state: 'downloading',
          message: `(${index}/${total}) Fetching MP3 for "${label}"…`,
          recordingId: rec.id,
        });

        try {
          const mp3Url = await this.plugin.plaudClient.getMp3TempUrl(rec.id);
          if (mp3Url && typeof mp3Url === 'string' && mp3Url.startsWith('http')) {
            const mp3Buffer = await this.plugin.plaudClient.downloadFromUrl(mp3Url);
            await this.plugin.app.vault.createBinary(mp3VaultPath, mp3Buffer);
            bestAudioPath = mp3VaultPath;
          } else {
            const buffer = await this.plugin.plaudClient.downloadAudioBuffer(rec.id);
            const header = new Uint8Array(buffer.slice(0, 3));
            const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
                       || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
            if (isMP3) {
              await this.plugin.app.vault.createBinary(mp3VaultPath, buffer);
              bestAudioPath = mp3VaultPath;
            }
          }
        } catch (dlErr: any) {
          console.warn(`Plaud: MP3 download failed for ${rec.id}`, dlErr);
        }
      }
    }

    // ── Transcribe ────────────────────────────────────────────────────────
    this.setStatus({
      state: 'transcribing',
      message: `(${index}/${total}) Transcribing "${label}"…`,
      recordingId: rec.id,
    });

    const detail: PlaudFileDetail = await this.plugin.plaudClient.getRecordingDetail(rec.id);

    let transcription: TranscriptionResult;

    if (hasRealTranscript(detail.transcript)) {
      transcription = parseServerTranscript(detail.transcript);
    } else if (bestAudioPath.endsWith('.opus')) {
      // Still only have the encrypted .opus — can't transcribe
      transcription = {
        text: '*(No MP3 version available yet — open this recording in the Plaud app to process it, then re-sync.)*',
        segments: [],
      };
    } else {
      try {
        const vaultBasePath = (this.plugin.app.vault.adapter as any).getBasePath?.() ?? '';
        const audioAbsPath = join(vaultBasePath, bestAudioPath);
        transcription = await this.plugin.whisperBridge.transcribe(
          audioAbsPath,
          this.plugin.settings,
        );
      } catch (whisperErr: any) {
        console.warn(`Plaud: Whisper failed for ${rec.id}, creating note without transcript.`, whisperErr);
        transcription = { text: '*(Whisper transcription failed — check mlx_whisper path in settings.)*', segments: [] };
      }
    }

    // ── Create note ───────────────────────────────────────────────────────
    const notePath = await this.plugin.noteFactory.createNote(
      rec,
      detail,
      transcription,
      bestAudioPath,
      this.plugin.settings,
    );

    // ── Rename note with best available context ────────────────────────
    const context = deriveContext(detail, rec, transcription);
    if (context) {
      const noteFile = this.plugin.app.vault.getAbstractFileByPath(notePath);
      if (noteFile) {
        const date = epochMsToDate(rec.start_time).toISOString().slice(0, 10);
        const newName = `${this.plugin.settings.notesFolder}/${date}_${context}.md`;
        const normalized = normalizePath(newName);
        if (normalized !== notePath && !this.plugin.app.vault.getAbstractFileByPath(normalized)) {
          await this.plugin.app.vault.rename(noteFile, normalized);
        }
      }
    }

    // Persist dedup
    this.plugin.settings.syncedIds.push(rec.id);
    await this.plugin.saveSettings();

    this.plugin.refreshRecordingsView();
  }

  /**
   * Remove a recording: delete note + audio files, remove from syncedIds.
   * Optionally trash on Plaud servers.
   */
  async removeRecording(id: string, alsoRemote: boolean): Promise<void> {
    const vault = this.plugin.app.vault;
    const { notesFolder, audioFolder } = this.plugin.settings;

    // Find and delete the note file by scanning frontmatter for plaud_id
    const noteFiles = vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(notesFolder + '/'),
    );
    for (const file of noteFiles) {
      const cache = this.plugin.app.metadataCache.getFileCache(file);
      if (cache?.frontmatter?.plaud_id === id) {
        await vault.trash(file, true);
        break;
      }
    }

    // Find and delete audio files (.opus and .mp3 matching the ID)
    const audioFiles = vault.getFiles().filter(f =>
      f.path.startsWith(audioFolder + '/') && f.path.includes(id),
    );
    for (const file of audioFiles) {
      await vault.trash(file, true);
    }

    // Remove from syncedIds
    const idx = this.plugin.settings.syncedIds.indexOf(id);
    if (idx !== -1) {
      this.plugin.settings.syncedIds.splice(idx, 1);
      await this.plugin.saveSettings();
    }

    // Optionally trash on Plaud servers
    if (alsoRemote) {
      const ok = await this.plugin.plaudClient.trashRecording(id);
      if (!ok) {
        new Notice('Plaud: failed to trash recording on server — removed locally only.');
      }
    }

    this.plugin.refreshRecordingsView();
  }

  /**
   * Remove all synced recordings. Optionally trash on Plaud servers.
   */
  async removeAllRecordings(alsoRemote: boolean): Promise<void> {
    const ids = [...this.plugin.settings.syncedIds];
    for (const id of ids) {
      await this.removeRecording(id, alsoRemote);
    }
    new Notice(`Plaud: removed ${ids.length} recording(s).`);
  }

  private async ensureVaultFolder(folderPath: string): Promise<void> {
    const parts = folderPath.split('/');
    let current = '';
    for (const part of parts) {
      current = current ? `${current}/${part}` : part;
      if (!this.plugin.app.vault.getAbstractFileByPath(current)) {
        try { await this.plugin.app.vault.createFolder(current); } catch (_) {}
      }
    }
  }

  /**
   * Re-transcribe a single note by its plaud_id.
   * Fetches a fresh transcript (server or Whisper) and replaces the note content.
   */
  async retranscribeOne(plaudId: string): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync in progress — try again after it finishes.');
      return;
    }

    const vault = this.plugin.app.vault;
    const { notesFolder, audioFolder } = this.plugin.settings;

    // Find the note file
    const noteFiles = vault.getMarkdownFiles().filter(f =>
      f.path.startsWith(notesFolder + '/'),
    );
    let file: TFile | undefined;
    for (const f of noteFiles) {
      const cache = this.plugin.app.metadataCache.getFileCache(f);
      if (cache?.frontmatter?.plaud_id === plaudId) { file = f; break; }
    }
    if (!file) {
      new Notice('Plaud: note not found for this recording.');
      return;
    }

    this.isSyncing = true;
    this.setStatus({ state: 'transcribing', message: `Re-transcribing "${file.basename}"…` });

    try {
      const detail = await this.plugin.plaudClient.getRecordingDetail(plaudId);
      let transcription: TranscriptionResult | null = null;

      if (hasRealTranscript(detail.transcript)) {
        transcription = parseServerTranscript(detail.transcript);
      } else {
        // Find or download MP3
        let mp3Path: string | null = null;

        const existingMp3 = vault.getFiles().find(
          f => f.path.startsWith(audioFolder) && f.extension === 'mp3' && f.path.includes(plaudId),
        );

        if (existingMp3) {
          mp3Path = existingMp3.path;
        } else {
          this.setStatus({ state: 'downloading', message: `Fetching MP3 for "${file.basename}"…` });
          await this.ensureVaultFolder(audioFolder);
          const mp3Filename = `retranscribe_${plaudId}.mp3`;
          const mp3VaultPath = normalizePath(`${audioFolder}/${mp3Filename}`);

          try {
            const mp3Url = await this.plugin.plaudClient.getMp3TempUrl(plaudId);
            if (mp3Url && typeof mp3Url === 'string' && mp3Url.startsWith('http')) {
              const buffer = await this.plugin.plaudClient.downloadFromUrl(mp3Url);
              await vault.createBinary(mp3VaultPath, buffer);
              mp3Path = mp3VaultPath;
            } else {
              const buffer = await this.plugin.plaudClient.downloadAudioBuffer(plaudId);
              const header = new Uint8Array(buffer.slice(0, 3));
              const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
                         || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
              if (isMP3) {
                await vault.createBinary(mp3VaultPath, buffer);
                mp3Path = mp3VaultPath;
              }
            }
          } catch (dlErr: any) {
            console.warn(`Plaud: MP3 download failed for ${plaudId}`, dlErr);
          }
        }

        if (mp3Path) {
          this.setStatus({ state: 'transcribing', message: `Transcribing "${file.basename}"…` });
          const vaultBasePath = (vault.adapter as any).getBasePath?.() ?? '';
          const absPath = join(vaultBasePath, mp3Path);
          transcription = await this.plugin.whisperBridge.transcribe(absPath, this.plugin.settings);
        }
      }

      if (transcription && transcription.text.trim().length > 0) {
        const oldContent = await vault.read(file);
        const timestamps = transcription.segments
          .map(s => `- **${fmtTs(s.start)}** — ${s.text}`)
          .join('\n');

        let newContent = oldContent;

        // Replace existing transcript section
        newContent = newContent.replace(
          /(## Transcript\n\n)([\s\S]*?)((?=\n## )|$)/,
          `$1${transcription.text}\n\n`,
        );

        // Replace timestamps section
        if (timestamps) {
          newContent = newContent.replace(
            /(## Timestamps\n\n)([\s\S]*?)$/,
            `$1${timestamps}\n`,
          );
        }

        await vault.modify(file, newContent);
        new Notice(`Plaud: re-transcribed "${file.basename}".`);
      } else {
        new Notice('Plaud: no transcript available yet for this recording.');
      }

      this.setStatus({ state: 'idle', message: `Re-transcribed: ${new Date().toLocaleTimeString()}` });
      this.plugin.refreshRecordingsView();
    } catch (err: any) {
      console.error(`Plaud: retranscribe failed for ${plaudId}`, err);
      new Notice(`Plaud: re-transcribe error: ${err.message}`);
      this.setStatus({ state: 'error', message: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Scan notes with pending transcription placeholders, try to fetch MP3
   * from Plaud API, and transcribe locally with Whisper.
   */
  async retranscribePending(): Promise<void> {
    if (this.isSyncing) {
      new Notice('Plaud: sync in progress — try again after it finishes.');
      return;
    }

    this.isSyncing = true;
    this.setStatus({ state: 'syncing', message: 'Scanning for pending transcriptions…' });

    const PENDING_MARKERS = [
      'Awaiting Plaud server transcription',
      'No MP3 version available yet',
      'No transcript available',
      'Whisper transcription failed',
    ];

    try {
      await this.plugin.authManager.ensureToken();
      const notesFolder = this.plugin.settings.notesFolder;
      const audioFolder = this.plugin.settings.audioFolder;
      const vault = this.plugin.app.vault;

      const noteFiles = vault.getFiles().filter(
        f => f.path.startsWith(notesFolder) && f.extension === 'md',
      );

      const pending: { file: TFile; plaudId: string }[] = [];
      for (const file of noteFiles) {
        const content = await vault.cachedRead(file);
        if (!PENDING_MARKERS.some(m => content.includes(m))) continue;
        const idMatch = content.match(/plaud_id:\s*(\S+)/);
        if (idMatch) pending.push({ file, plaudId: idMatch[1] });
      }

      if (pending.length === 0) {
        new Notice('Plaud: no pending transcriptions found.');
        this.setStatus({ state: 'idle', message: 'No pending transcriptions' });
        return;
      }

      new Notice(`Plaud: retranscribing ${pending.length} recording(s)…`);
      let transcribed = 0;
      let skipped = 0;

      for (let i = 0; i < pending.length; i++) {
        const { file, plaudId } = pending[i];

        try {
          // First check if Plaud now has a server transcript
          this.setStatus({
            state: 'transcribing',
            message: `(${i + 1}/${pending.length}) Checking "${file.basename}"…`,
          });

          const detail = await this.plugin.plaudClient.getRecordingDetail(plaudId);
          let transcription: TranscriptionResult | null = null;

          if (hasRealTranscript(detail.transcript)) {
            transcription = parseServerTranscript(detail.transcript);
          } else {
            // Try to get an MP3 for local Whisper transcription
            let mp3Path: string | null = null;

            // Check if MP3 already exists in vault
            const existingMp3 = vault.getFiles().find(
              f => f.path.startsWith(audioFolder) && f.extension === 'mp3' && f.path.includes(plaudId),
            );

            if (existingMp3) {
              mp3Path = existingMp3.path;
            } else {
              // Try downloading MP3 from API
              this.setStatus({
                state: 'downloading',
                message: `(${i + 1}/${pending.length}) Fetching MP3 for "${file.basename}"…`,
              });

              await this.ensureVaultFolder(audioFolder);
              const mp3Filename = `retranscribe_${plaudId}.mp3`;
              const mp3VaultPath = normalizePath(`${audioFolder}/${mp3Filename}`);

              try {
                const mp3Url = await this.plugin.plaudClient.getMp3TempUrl(plaudId);
                if (mp3Url && typeof mp3Url === 'string' && mp3Url.startsWith('http')) {
                  const buffer = await this.plugin.plaudClient.downloadFromUrl(mp3Url);
                  await vault.createBinary(mp3VaultPath, buffer);
                  mp3Path = mp3VaultPath;
                } else {
                  const buffer = await this.plugin.plaudClient.downloadAudioBuffer(plaudId);
                  const header = new Uint8Array(buffer.slice(0, 3));
                  const isMP3 = (header[0] === 0x49 && header[1] === 0x44 && header[2] === 0x33)
                             || (header[0] === 0xFF && (header[1] & 0xE0) === 0xE0);
                  if (isMP3) {
                    await vault.createBinary(mp3VaultPath, buffer);
                    mp3Path = mp3VaultPath;
                  }
                }
              } catch (dlErr: any) {
                console.warn(`Plaud: MP3 download failed for ${plaudId}`, dlErr);
              }
            }

            if (mp3Path) {
              this.setStatus({
                state: 'transcribing',
                message: `(${i + 1}/${pending.length}) Transcribing "${file.basename}"…`,
              });
              const vaultBasePath = (vault.adapter as any).getBasePath?.() ?? '';
              const absPath = join(vaultBasePath, mp3Path);
              transcription = await this.plugin.whisperBridge.transcribe(absPath, this.plugin.settings);
            }
          }

          if (transcription && transcription.text.trim().length > 0) {
            const oldContent = await vault.read(file);
            const timestamps = transcription.segments
              .map(s => `- **${fmtTs(s.start)}** — ${s.text}`)
              .join('\n');

            let newContent = oldContent;
            for (const marker of PENDING_MARKERS) {
              // Match *(marker text…)* — use [\s\S]*? to handle ) inside the text
              newContent = newContent.replace(
                new RegExp(`\\*\\(${marker.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}[\\s\\S]*?\\)\\*`),
                transcription.text,
              );
            }
            // Update timestamps section
            newContent = newContent.replace(
              /## Timestamps\n\n\s*$/,
              `## Timestamps\n\n${timestamps}\n`,
            );

            await vault.modify(file, newContent);
            transcribed++;
          } else {
            skipped++;
          }
        } catch (err: any) {
          console.error(`Plaud: retranscribe failed for ${plaudId}`, err);
          new Notice(`Plaud: error for "${file.basename}": ${err.message}`);
          skipped++;
        }
      }

      const msg = transcribed > 0
        ? `Transcribed ${transcribed} recording(s).` + (skipped > 0 ? ` ${skipped} still pending.` : '')
        : 'No recordings could be transcribed yet — MP3 versions may not be ready on Plaud servers.';
      new Notice(`Plaud: ${msg}`);
      this.setStatus({ state: 'idle', message: `Last retranscribe: ${new Date().toLocaleTimeString()}` });
      this.plugin.refreshRecordingsView();
    } catch (err: any) {
      console.error('Plaud: retranscribe failed', err);
      new Notice(`Plaud retranscribe error: ${err.message}`);
      this.setStatus({ state: 'error', message: err.message });
    } finally {
      this.isSyncing = false;
    }
  }

  private setStatus(status: SyncStatus): void {
    this.onStatusChange?.(status);
  }
}

/**
 * Parse Plaud's server-generated transcript (markdown with [Speaker N] labels)
 * into a TranscriptionResult. No timestamps available from the server transcript.
 */
function parseServerTranscript(raw: string): TranscriptionResult {
  const lines = raw.split('\n').filter(l => l.trim().length > 0);
  const segments: { start: number; end: number; text: string }[] = [];
  let offset = 0;

  for (const line of lines) {
    // Skip markdown headings like "## Transcripció literal"
    if (line.startsWith('#')) continue;
    const text = line.replace(/^\[Speaker \d+\]\s*/, '').trim();
    if (!text) continue;
    segments.push({ start: offset, end: offset + 1, text });
    offset += 1;
  }

  const fullText = segments.map(s => s.text).join('\n\n');
  return { text: fullText, segments };
}

function fmtTs(seconds: number): string {
  const m = Math.floor(seconds / 60);
  const s = Math.floor(seconds % 60);
  return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}`;
}

function toFileDatePrefix(epochMs: number): string {
  const d = new Date(epochMs);
  if (isNaN(d.getTime())) return 'unknown';
  const date = d.toISOString().slice(0, 10);
  const time = d.toTimeString().slice(0, 5).replace(':', '');
  return `${date}_${time}`;
}

function epochMsToDate(epochMs: number): Date {
  const d = new Date(epochMs);
  return isNaN(d.getTime()) ? new Date() : d;
}

/**
 * Derive a short contextual title from the transcript.
 * Only uses the transcript text — skips placeholder markers.
 */
const MAX_CONTEXT_LEN = 60; // keep well under the 255-byte filename limit

function deriveContext(
  _detail: PlaudFileDetail,
  _rec: PlaudFile,
  transcription: TranscriptionResult,
): string {
  const text = transcription.text;
  // Skip placeholder markers
  if (!text || text.length < 20 || text.startsWith('*(')) return '';

  // Skip non-transcript payloads (e.g. Plaud "marks" JSON returned before the
  // real transcript is ready) — these aren't human-readable titles.
  if (looksLikeJson(text)) return '';

  // Collect the first ~200 chars of real text, stripping speaker labels and markdown
  const lines = text.split('\n').filter(l => l.trim().length > 0);
  let collected = '';
  for (const line of lines) {
    const clean = line
      .replace(/^\[Speaker \d+\]\s*/, '')
      .replace(/^#+\s*/, '')
      .trim();
    if (!clean) continue;
    collected += (collected ? ' ' : '') + clean;
    if (collected.length >= 200) break;
  }

  if (collected.length < 10) return '';

  // Take first ~8 words for a concise title
  const words = collected.split(/\s+/).slice(0, 8).join(' ');

  // Clean up: drop characters that are illegal or noisy in filenames, collapse
  // whitespace, trim trailing punctuation, and hard-cap the length so a
  // pathological transcript can never produce an over-long filename.
  const cleaned = words
    .replace(/[\\/:*?"<>|[\]{}]/g, '')
    .replace(/\s+/g, ' ')
    .replace(/[.,;:!?]+$/, '')
    .trim()
    .slice(0, MAX_CONTEXT_LEN)
    .trim();

  return cleaned.length >= 10 ? cleaned : '';
}

/**
 * A Plaud `transcript` field is only usable if it's non-trivial AND not a raw
 * data payload (e.g. the "marks" JSON returned before the real transcript is
 * ready). Otherwise the recording should be treated as not-yet-transcribed.
 */
function hasRealTranscript(transcript: string | undefined | null): boolean {
  return !!transcript && transcript.length > 20 && !looksLikeJson(transcript);
}

/** Heuristic: does this text look like a serialized JSON object/array? */
function looksLikeJson(text: string): boolean {
  const t = text.trim();
  if (!/^[[{]/.test(t)) return false;
  try {
    JSON.parse(t);
    return true;
  } catch {
    // Even if it doesn't parse cleanly, bail on obvious marks-data payloads.
    return /"?mark_type"?|"?mark_content"?|"?timestamp"?/.test(t);
  }
}

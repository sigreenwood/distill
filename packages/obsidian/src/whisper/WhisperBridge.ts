import { execFile } from 'child_process';
import { promisify } from 'util';
import { tmpdir, homedir } from 'os';
import { readFileSync, existsSync } from 'fs';
import { join, basename, extname, dirname } from 'path';
import { Notice } from 'obsidian';
import type { TranscriptionResult, WhisperSegment } from '../types';
import type { PlaudSettings } from '../settings';

const execFileAsync = promisify(execFile);

export class WhisperBridge {
  /**
   * Transcribe an audio file using the mlx_whisper CLI.
   * Calls the mlx_whisper binary directly (not python -m).
   */
  async transcribe(audioAbsPath: string, settings: PlaudSettings): Promise<TranscriptionResult> {
    const outputDir = tmpdir();
    const whisperBin = settings.pythonPath; // now points to mlx_whisper binary

    const args = [
      audioAbsPath,
      '--model', settings.whisperModel,
      '--output-format', 'json',
      '--output-dir', outputDir,
    ];

    if (settings.whisperLanguage !== 'auto') {
      args.push('--language', settings.whisperLanguage);
    }

    // Electron strips environment — pass HOME, PATH, and Python-related vars
    const env = {
      ...process.env,
      HOME: homedir(),
      PATH: `${dirname(whisperBin)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
    };

    const statusNotice = new Notice(`Plaud: transcribing ${basename(audioAbsPath)}…`, 0);

    let result: { stdout: string; stderr: string };
    try {
      result = await execFileAsync(whisperBin, args, {
        timeout: 600_000, // 10 minutes
        env,
        maxBuffer: 10 * 1024 * 1024, // 10 MB
      });
    } catch (err: any) {
      statusNotice.hide();
      const stderr = err.stderr ?? '';
      throw new Error(`Whisper transcription failed: ${err.message ?? err}${stderr ? `\nstderr: ${stderr}` : ''}`);
    }

    statusNotice.hide();

    const stem = basename(audioAbsPath, extname(audioAbsPath));
    const jsonPath = join(outputDir, `${stem}.json`);

    if (!existsSync(jsonPath)) {
      // Log what whisper actually output for debugging
      console.error(`Plaud/Whisper: JSON not found at ${jsonPath}`);
      console.error(`Plaud/Whisper stdout: ${result.stdout.slice(0, 500)}`);
      console.error(`Plaud/Whisper stderr: ${result.stderr.slice(0, 500)}`);
      throw new Error(`Whisper output not found at ${jsonPath}`);
    }

    return this.parseWhisperOutput(jsonPath);
  }

  private parseWhisperOutput(jsonPath: string): TranscriptionResult {
    let raw: any;
    try {
      raw = JSON.parse(readFileSync(jsonPath, 'utf-8'));
    } catch (err) {
      throw new Error(`Failed to parse Whisper JSON output: ${err}`);
    }

    const text: string = raw.text ?? '';
    const segments: WhisperSegment[] = (raw.segments ?? []).map((s: any) => ({
      start: Number(s.start ?? 0),
      end: Number(s.end ?? 0),
      text: String(s.text ?? '').trim(),
    }));

    return { text: text.trim(), segments, language: raw.language };
  }

  /** Check that mlx_whisper CLI is runnable. */
  async checkInstallation(whisperPath: string): Promise<string | null> {
    const env = {
      ...process.env,
      HOME: homedir(),
      PATH: `${dirname(whisperPath)}:/usr/local/bin:/usr/bin:/bin:/opt/homebrew/bin:${process.env.PATH ?? ''}`,
    };
    try {
      await execFileAsync(whisperPath, ['--help'], { timeout: 10_000, env });
      return null;
    } catch (err: any) {
      return `mlx_whisper not available at "${whisperPath}": ${err.message ?? err}`;
    }
  }
}

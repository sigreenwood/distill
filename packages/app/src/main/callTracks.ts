import fs from 'node:fs';

/**
 * A recorded call keeps its two source tracks next to the mixed mp3 so the
 * transcriber can tell who spoke:
 *
 *   local-ab12.mp3         the mix (what plays back, what audio_path points at)
 *   local-ab12.mic.mp3     the user's microphone only
 *   local-ab12.others.mp3  system audio: everyone else on the call
 *
 * Found by naming convention, not a database column: no migration, and a
 * recording without the sidecars (every Plaud/imported one) is unchanged.
 * Anything that deletes audio_path must delete these too — they are the same
 * meeting's audio.
 */
export interface CallTracks {
  mic: string;
  others: string;
}

export function trackPaths(audioPath: string): CallTracks {
  const base = audioPath.replace(/\.[^./\\]+$/, '');
  return { mic: `${base}.mic.mp3`, others: `${base}.others.mp3` };
}

/** Both tracks, or null. One without the other can't be labelled. */
export function existingTracks(
  audioPath: string,
  exists: (p: string) => boolean = fs.existsSync,
): CallTracks | null {
  const t = trackPaths(audioPath);
  return exists(t.mic) && exists(t.others) ? t : null;
}

/** Best-effort delete of whichever sidecars exist; returns what it removed. */
export function removeTracks(
  audioPath: string,
  fsImpl: { existsSync: (p: string) => boolean; unlinkSync: (p: string) => void } = fs,
): string[] {
  const removed: string[] = [];
  const t = trackPaths(audioPath);
  for (const p of [t.mic, t.others]) {
    try {
      if (fsImpl.existsSync(p)) {
        fsImpl.unlinkSync(p);
        removed.push(p);
      }
    } catch {
      // The meeting audio is going away regardless; a stuck sidecar is logged
      // by nobody and retried by nothing, so don't let it fail the caller.
    }
  }
  return removed;
}

/** Move freshly mixed tracks next to the imported mix. Throws on failure. */
export function adoptTracks(audioPath: string, from: CallTracks): CallTracks {
  const to = trackPaths(audioPath);
  for (const key of ['mic', 'others'] as const) {
    try {
      fs.renameSync(from[key], to[key]);
    } catch {
      fs.copyFileSync(from[key], to[key]); // cross-device
    }
  }
  return to;
}

/** Arguments that point transcribe.py at the right input(s). */
export function transcribeInputArgs(audioPath: string, tracks: CallTracks | null): string[] {
  return tracks
    ? ['--audio', tracks.others, '--mic-audio', tracks.mic]
    : ['--audio', audioPath];
}

export { hasSpeakerLabels, speakerLegend } from '../shared/speakerLabels.js';

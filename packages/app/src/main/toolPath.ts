/**
 * Make Homebrew's command-line tools reachable from the packaged app.
 *
 * An app launched from Finder, the Dock or a login item inherits
 * launchd's PATH (/usr/bin:/bin:/usr/sbin:/sbin), not the shell's, so
 * ffmpeg and ffprobe installed with Homebrew are invisible to it even
 * though they work in Terminal. That made video import fail with
 * "ffmpeg is not installed", left imported audio without a duration
 * (ffprobe), and denied transcribe.py — which inherits this environment
 * — the ffmpeg decoder it prefers.
 */

/** Apple Silicon Homebrew first, then Intel Homebrew / python.org. */
export const EXTRA_TOOL_DIRS = ['/opt/homebrew/bin', '/usr/local/bin'];

/**
 * PATH with the tool directories appended where missing. Appended, not
 * prepended, so anything the environment already resolves keeps
 * resolving to the same binary.
 */
export function withToolDirs(pathEnv: string | undefined): string {
  const parts = (pathEnv ?? '').split(':').filter((p) => p.length > 0);
  for (const dir of EXTRA_TOOL_DIRS) {
    if (!parts.includes(dir)) parts.push(dir);
  }
  return parts.join(':');
}

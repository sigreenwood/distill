/**
 * Small formatters shared between the inbox and tag renderers.
 */

export function formatDuration(seconds: number | null | undefined): string {
  if (seconds == null) return '—';
  const s = Math.round(seconds);
  const h = Math.floor(s / 3600);
  const m = Math.floor((s % 3600) / 60);
  const r = s % 60;
  if (h > 0) return `${h}h${m.toString().padStart(2, '0')}m`;
  if (m > 0) return `${m}m${r.toString().padStart(2, '0')}s`;
  return `${r}s`;
}

/**
 * Friendly relative date like "Today 14:30", "Yesterday 09:15", "Tue 3 Apr",
 * falling back to an ISO date if the epoch is null/undefined.
 *
 * Both arguments are epoch milliseconds — Plaud's start_time is already ms
 * despite the name sometimes suggesting seconds in other APIs.
 */
export function formatWhen(
  startTimeMs: number | null | undefined,
  fallbackEpochMs: number,
): string {
  const ms = startTimeMs != null ? startTimeMs : fallbackEpochMs;
  const d = new Date(ms);
  const now = new Date();

  const sameDay =
    d.getFullYear() === now.getFullYear() &&
    d.getMonth() === now.getMonth() &&
    d.getDate() === now.getDate();

  const yesterday = new Date(now);
  yesterday.setDate(now.getDate() - 1);
  const isYesterday =
    d.getFullYear() === yesterday.getFullYear() &&
    d.getMonth() === yesterday.getMonth() &&
    d.getDate() === yesterday.getDate();

  const hm = `${d.getHours().toString().padStart(2, '0')}:${d
    .getMinutes()
    .toString()
    .padStart(2, '0')}`;

  if (sameDay) return `Today ${hm}`;
  if (isYesterday) return `Yesterday ${hm}`;

  const weekday = d.toLocaleDateString(undefined, { weekday: 'short' });
  const day = d.getDate();
  const month = d.toLocaleDateString(undefined, { month: 'short' });
  return `${weekday} ${day} ${month} ${hm}`;
}

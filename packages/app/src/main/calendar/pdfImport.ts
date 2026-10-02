/**
 * Reads Outlook calendar printouts (PDF) with python/calendar_pdf.py in
 * the app's own venv. Parsing is layout rules, not a model, and runs
 * entirely on this Mac.
 */
import crypto from 'node:crypto';
import path from 'node:path';
import { spawn } from 'node:child_process';
import type { CalendarMeeting, CalendarPerson } from '../../shared/calendar.js';

export interface PrintedEvent {
  subject: string;
  date: string;
  start: string | null;
  end: string | null;
  endDate: string;
  allDay: boolean;
  location: string | null;
  organiser: string | null;
  required: CalendarPerson[];
  optional: CalendarPerson[];
  body: string | null;
}

interface ScriptOutput {
  files: { path: string; events: PrintedEvent[]; pages: number; warnings: string[] }[];
}

/**
 * Local wall-clock "2026-08-03" + "09:30" → epoch ms in the Mac's own time
 * zone, which is the zone Outlook printed in for the same user.
 */
export function localTimeToMs(date: string, time: string): number {
  const [y, m, d] = date.split('-').map(Number);
  const [hh, mm] = time.split(':').map(Number);
  return new Date(y, m - 1, d, hh, mm).getTime();
}

export function meetingId(e: Pick<PrintedEvent, 'date' | 'start' | 'subject'>): string {
  return crypto.createHash('sha1').update(`${e.date}|${e.start ?? ''}|${e.subject}`).digest('hex').slice(0, 16);
}

/** All-day entries (leave, travel, holidays) aren't meetings that get recorded, so they're dropped here. */
export function toMeetings(events: PrintedEvent[]): CalendarMeeting[] {
  const byId = new Map<string, CalendarMeeting>();
  for (const e of events) {
    if (e.allDay || !e.start || !e.end) continue;
    const id = meetingId(e);
    byId.set(id, {
      id,
      subject: e.subject,
      startMs: localTimeToMs(e.date, e.start),
      endMs: localTimeToMs(e.endDate, e.end),
      location: e.location,
      organiser: e.organiser,
      required: e.required,
      optional: e.optional,
      body: e.body,
    });
  }
  return [...byId.values()].sort((a, b) => a.startMs - b.startMs);
}

export async function readCalendarPdfs(
  pythonBinary: string,
  scriptPath: string,
  files: string[],
): Promise<{ meetings: CalendarMeeting[]; files: { name: string; meetings: number; warnings: string[] }[] }> {
  const stdout = await new Promise<string>((resolve, reject) => {
    const proc = spawn(pythonBinary, [scriptPath, ...files]);
    let out = '';
    let err = '';
    proc.stdout.setEncoding('utf8').on('data', (c: string) => (out += c));
    proc.stderr.setEncoding('utf8').on('data', (c: string) => (err += c));
    proc.once('error', reject);
    proc.once('close', (code) =>
      code === 0 ? resolve(out) : reject(new Error(`Reading the calendar failed: ${err.trim().slice(-400) || `exit ${code}`}`)),
    );
  });
  const parsed = JSON.parse(stdout) as ScriptOutput;
  const all: PrintedEvent[] = [];
  const summary = parsed.files.map((f) => {
    all.push(...f.events);
    return { name: path.basename(f.path), meetings: toMeetings(f.events).length, warnings: f.warnings };
  });
  return { meetings: toMeetings(all), files: summary };
}

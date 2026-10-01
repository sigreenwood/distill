export type ProcessingScheduleMode = 'immediate' | 'idle' | 'overnight';

export interface ProcessingSchedule {
  mode: ProcessingScheduleMode;
  /** Minutes the Mac must have been idle before 'idle' mode allows a claim. */
  idleMinutes: number;
  /** "HH:MM" 24-hour local time. May be later than overnightEnd (an overnight window crosses midnight). */
  overnightStart: string;
  overnightEnd: string;
}

import { useCallback, useEffect, useRef, useState } from 'react';
import type { CalendarCoverage } from '../shared/api.js';

export function useCalendarImport() {
  const [coverage, setCoverage] = useState<CalendarCoverage | null>(null);
  const [pending, setPending] = useState(0);
  const [messages, setMessages] = useState<string[]>([]);
  const pendingCount = useRef(0);
  const tail = useRef<Promise<void>>(Promise.resolve());

  const load = useCallback(() => {
    void window.distill.calendar.coverage().then(setCoverage).catch(() => setCoverage(null));
  }, []);
  useEffect(() => {
    load();
    return window.distill.onInboxChanged(load);
  }, [load]);

  const importPdfs = useCallback((paths?: string[]): Promise<void> => {
    if (pendingCount.current === 0) setMessages([]);
    pendingCount.current += 1;
    setPending(pendingCount.current);
    // Keep each drop together (overlapping PDFs are merged by the importer),
    // and queue further drops until the previous import has finished.
    const task = tail.current.then(async () => {
      try {
        const result = await window.distill.calendar.importPdfs(paths);
        if (!result) return;
        const warnings = result.files.flatMap((f) => f.warnings.map((w) => `${f.name}: ${w}`));
        const message =
          `Read ${result.meetings.toLocaleString()} meetings from ${result.files.length} file${result.files.length === 1 ? '' : 's'}. ` +
            `${result.matched} recording${result.matched === 1 ? '' : 's'} matched to a meeting, ${result.accountsSuggested} with an account.` +
            (warnings.length > 0 ? ` ⚠ ${warnings.join(' · ')}` : '');
        setMessages((previous) => [...previous, message]);
        load();
      } catch (e) {
        const files = paths?.map((path) => path.split('/').pop()).join(', ');
        const message = `Could not import ${files || 'calendar PDFs'}: ${e instanceof Error ? e.message : String(e)}`;
        setMessages((previous) => [...previous, message]);
      } finally {
        pendingCount.current -= 1;
        setPending(pendingCount.current);
      }
    });
    tail.current = task;
    return task;
  }, [load]);

  return { coverage, pending, messages, importPdfs };
}

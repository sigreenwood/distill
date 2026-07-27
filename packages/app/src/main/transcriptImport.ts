import { parseSimpleFrontmatter } from './poller.js';

export interface ParsedTranscriptFile {
  transcript: string;
  /** Title from the `# ` heading or frontmatter filename, when present. */
  title: string | null;
  /** Client name recorded in distill frontmatter, for pre-selecting the tag. */
  clientName: string | null;
  /** Meeting type recorded in distill frontmatter. */
  meetingTypeName: string | null;
  /** The recording this file was originally produced from, if it says. */
  sourceRecordingId: string | null;
  /** Whisper model that produced the transcript, when recorded. */
  whisperModel: string | null;
  /** True when the file carried distill frontmatter (vs a plain text dump). */
  fromDistillOutput: boolean;
}

export class TranscriptImportError extends Error {
  userMessage: string;

  constructor(userMessage: string) {
    super(userMessage);
    this.userMessage = userMessage;
    this.name = 'TranscriptImportError';
  }
}

const FRONTMATTER = /^---\r?\n([\s\S]*?)\r?\n---\r?\n?/;
/** `## Transcript` as written by buildMarkdown, tolerant of heading level. */
const TRANSCRIPT_HEADING = /^#{1,6}\s*transcript\s*$/im;

/**
 * Parse a transcript out of a distill Markdown output, or a plain text
 * file.
 *
 * The point is to re-run summarisation without re-doing the expensive
 * part: Whisper has already produced this text once. That makes it the
 * cheap way to try a different model or a different meeting-type prompt
 * against identical input, and a way to recover a transcript when only
 * the output file survived.
 */
export function parseTranscriptFile(content: string, filename: string): ParsedTranscriptFile {
  const fmMatch = content.match(FRONTMATTER);

  if (!fmMatch) {
    // No frontmatter: treat the whole file as raw transcript text. This
    // is the .txt path, and also covers transcripts exported from other
    // tools entirely.
    const text = content.trim();
    if (text.length === 0) {
      throw new TranscriptImportError(`"${filename}" is empty — nothing to summarise.`);
    }
    return {
      transcript: text,
      title: null,
      clientName: null,
      meetingTypeName: null,
      sourceRecordingId: null,
      whisperModel: null,
      fromDistillOutput: false,
    };
  }

  const meta = parseSimpleFrontmatter(fmMatch[1]);
  const body = content.slice(fmMatch[0].length);
  const headingMatch = body.match(TRANSCRIPT_HEADING);

  if (!headingMatch || headingMatch.index === undefined) {
    // A distill output written with includeTranscript: false has only a
    // summary. Say so precisely rather than silently importing the
    // summary as if it were the transcript.
    throw new TranscriptImportError(
      `"${filename}" has no Transcript section. It was probably written with ` +
        '"Embed full transcript below the summary" turned off, so the transcript ' +
        'is not in this file — re-run from the original recording instead.',
    );
  }

  const transcript = body.slice(headingMatch.index + headingMatch[0].length).trim();
  if (transcript.length === 0) {
    throw new TranscriptImportError(`"${filename}" has an empty Transcript section.`);
  }

  const titleMatch = body.match(/^#\s+(.+)$/m);
  return {
    transcript,
    title: titleMatch ? titleMatch[1].trim() : (meta.filename ?? null),
    clientName: meta.client ?? null,
    meetingTypeName: meta.meeting_type ?? null,
    sourceRecordingId: meta.recording_id ?? null,
    whisperModel: meta.whisper_model ?? null,
    fromDistillOutput: true,
  };
}

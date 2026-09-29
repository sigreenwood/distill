import { searchMeetings, validateSearch } from './meetingSearch.js';
import { loadMeetingDetail } from './meetingContent.js';
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { inspectOutputDir } from './outputDirStatus.js';
import { showAppleNote, deleteAppleNote } from './outputs.js';
import { audioFileExists } from './pipelineSteps.js';
import { app, clipboard, dialog, ipcMain, shell, BrowserWindow } from 'electron';
import { Channels, KEEPALIVE_PRESETS, WHISPER_MODEL_PRESETS } from '../shared/ipcChannels.js';
import { userVocabularyDir } from './paths.js';
import { saveConfig, type AppConfig, type OutputsConfig } from './config.js';
import { hashPrompt, parsePromptsMarkdownDetailed, readSeedPrompt } from './seed.js';
import { openSettings, openTagSheet, openMeetingReader } from './windows.js';
import { importLocalFile, LocalImportError, type LocalImportProgress } from './localImport.js';
import {
  BUILTIN_SCOPE_IDS,
  loadVocabulary,
  countVocabularyTerms,
  isBuiltinScopeId,
  parseVocabularyMarkdownTables,
  readVocabularyFile,
  writeVocabularyFile,
  WHISPER_PROMPT_CHAR_LIMIT,
  type VocabularyFile,
  type VocabularyReplacement,
} from './vocabulary.js';
import { OllamaClient, pullModel } from './ollama.js';
import { recommendModelForRam, recommendationTable } from './modelAdvisor.js';
import { readModelSuggestion, dismissModelSuggestion } from './modelUpdateCheck.js';
import os from 'node:os';
import { getPlaudAccountStatus, signInPlaud, signOutPlaud } from './plaudAccount.js';
import { readTipJarStatus, dismissBanner, TIP_JAR_URL } from './tipJar.js';
import {
  detectSystemPython,
  detectVenv,
  installVenv,
  isParakeetInstalled,
  installParakeet,
  type SetupPhase,
  type VenvStatus,
} from './pythonEnv.js';
import type { KeychainCredentialStore } from './keychain.js';
import type { Logger } from './logger.js';
import { stepPlanFor, effectiveOutputTargets } from './state.js';
import {
  parseAttendeesText,
  parseStoredAttendees,
  rankFrequentAttendees,
  suggestClientId,
} from '../shared/attendees.js';
import type {
  ClientRow,
  JoinedRecordingRow,
  MeetingTypeRow,
  PipelineStep,
  RecordingStatus,
  State,
} from './state.js';
import type { Worker } from './worker.js';
import type { Attendee } from '../shared/attendees.js';

export interface IpcContext {
  state: State;
  logger: Logger;
  resourcesDir: string;
  getConfig: () => AppConfig;
  applyConfigUpdate: (patch: Partial<AppConfig>) => AppConfig;
  getWorker: () => Worker | null;
  getPlaudStore: () => KeychainCredentialStore | null;
  onPlaudCredentialsChanged?: () => void;
  onStateChanged?: () => void;
  onSetupComplete?: () => void;
}

export function registerIpcHandlers(ctx: IpcContext): void {
  function requireMeeting(recordingId: unknown): JoinedRecordingRow {
    if (typeof recordingId !== 'string' || !recordingId.trim()) throw new Error('Invalid recording ID');
    const row = ctx.state.getRecordingJoined(recordingId);
    if (!row) throw new Error('This recording is no longer in the library.');
    return row;
  }
  ipcMain.handle(Channels.MeetingOpen, (_evt, recordingId, scope = 'summary') => {
    const row = requireMeeting(recordingId);
    if (scope !== 'summary' && scope !== 'transcript') throw new Error('Invalid meeting source');
    openMeetingReader(row.id, scope);
  });
  ipcMain.handle(Channels.MeetingGet, (_evt, recordingId) => loadMeetingDetail(requireMeeting(recordingId)));
  ipcMain.handle(Channels.InboxSearch, async (_evt, query, scope) => {
    validateSearch(query, scope);
    return searchMeetings(ctx.state.listSearchableJoined(), query, scope, ctx.getConfig().ollama);
  });
  ipcMain.handle(Channels.InboxList, () => {
    const cfg = ctx.getConfig();
    const swept = ctx.state.sweepCompletedOlderThan(cfg.autoDismissCompleteMinutes);
    if (swept > 0) {
      ctx.logger.info(
        { count: swept, thresholdMinutes: cfg.autoDismissCompleteMinutes },
        'auto-dismissed completed recordings',
      );
      ctx.onStateChanged?.();
    }
    return ctx.state.listActiveJoined().map((r) => toInboxDTO(r, cfg.outputs));
  });

  ipcMain.handle(Channels.InboxSkip, (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const changed = ctx.state.skipRecording(recordingId);
    if (changed) {
      ctx.logger.info({ recordingId }, 'recording skipped');
      ctx.onStateChanged?.();
      broadcastInboxChanged();
    }
  });

  ipcMain.handle(Channels.InboxRevealInFinder, (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    if (row.markdown_path) {
      shell.showItemInFolder(row.markdown_path);
      return;
    }
    if (row.html_path) {
      shell.showItemInFolder(row.html_path);
      return;
    }
    if (row.apple_note_id) {
      void shell.openExternal('notes://');
      return;
    }
    throw new Error('No output written yet for this recording');
  });

  ipcMain.handle(Channels.InboxRevealOutput, (_evt, recordingId, kind) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    if (kind !== 'markdown' && kind !== 'html' && kind !== 'appleNote') {
      throw new Error(`Unknown output kind: ${String(kind)}`);
    }
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    if (kind === 'appleNote') {
      if (!row.apple_note_written_at || !row.apple_note_id) {
        throw new Error('No Apple Note was written for this recording');
      }
      // Open the note itself via AppleScript. Falling back to the
      // notes:// scheme only drops the user at the app, which is what
      // this used to do for every note — fine as a backstop, not as the
      // normal path.
      return showAppleNote(row.apple_note_id).catch((e) => {
        ctx.logger.warn(
          { err: e instanceof Error ? e.message : String(e), noteId: row.apple_note_id },
          'could not show the note directly; opening Notes instead',
        );
        void shell.openExternal('notes://');
      });
    }
    const p = kind === 'markdown' ? row.markdown_path : row.html_path;
    const written = kind === 'markdown' ? row.markdown_written_at : row.html_written_at;
    if (!p || !written) throw new Error(`No ${kind} file was written for this recording`);
    if (!fs.existsSync(p)) {
      throw new Error(`The ${kind} file is no longer at ${p} — it may have been moved or deleted.`);
    }
    shell.showItemInFolder(p);
  });

  ipcMain.handle(Channels.InboxListHidden, () => {
    const cfg = ctx.getConfig();
    return {
      total: ctx.state.hiddenCount(),
      items: ctx.state.listHiddenJoined().map((r) => toInboxDTO(r, cfg.outputs)),
    };
  });

  ipcMain.handle(Channels.HistoryList, (_evt, payload) => {
    const p = (payload ?? {}) as { search?: unknown; limit?: unknown; offset?: unknown };
    const search = typeof p.search === 'string' ? p.search : '';
    const limit = typeof p.limit === 'number' ? p.limit : 50;
    const offset = typeof p.offset === 'number' ? p.offset : 0;
    const cfg = ctx.getConfig();
    return {
      total: ctx.state.listAllCount(search),
      items: ctx.state.listAllJoined(search, limit, offset).map((r) => toInboxDTO(r, cfg.outputs)),
    };
  });

  ipcMain.handle(Channels.InboxUnhide, (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const next = ctx.state.unhideRecording(recordingId);
    if (!next) throw new Error('That recording is not hidden');
    ctx.logger.info({ recordingId, status: next }, 'recording unhidden');
    ctx.onStateChanged?.();
    broadcastInboxChanged();
    return { status: next };
  });

  ipcMain.handle(Channels.InboxSetOutputTargets, (_evt, recordingId, targets) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const t = assertOutputTargetsPayload(targets);
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    ctx.state.setOutputTargets(recordingId, t);
    // A destination just turned on for a recording that's already
    // finished, and hasn't been written yet, needs the same "regenerate"
    // nudge Full re-run uses: leave transcript/summary/other *_written_at
    // columns alone, flip back to `tagged`, let the worker pick it up.
    // nextNeededStep sees the transcript+summary are already there and
    // routes straight to the write step.
    const needsWrite =
      (t.markdown && row.markdown_written_at === null) ||
      (t.html && row.html_written_at === null) ||
      (t.appleNote && row.apple_note_written_at === null);
    if (row.status === 'complete' && needsWrite) {
      ctx.state.setStatus(recordingId, 'tagged');
      ctx.getWorker()?.nudge();
    }
    ctx.logger.info({ recordingId, targets: t }, 'output targets updated');
    ctx.onStateChanged?.();
    broadcastInboxChanged();
  });

  ipcMain.handle(Channels.TagSave, (_evt, payload) => {
    const p = assertTagSavePayload(payload);
    const changed = ctx.state.tagRecording(p.recordingId, p.clientId, p.meetingTypeId, p.attendees);
    if (!changed) {
      throw new Error('Recording could not be tagged — it may already have been tagged or skipped.');
    }
    ctx.logger.info(
      {
        recordingId: p.recordingId,
        clientId: p.clientId,
        meetingTypeId: p.meetingTypeId,
        attendeeCount: p.attendees?.length ?? 0,
      },
      'recording tagged',
    );
    ctx.onStateChanged?.();
    broadcastInboxChanged();
    ctx.getWorker()?.nudge();
  });

  // People from this client's past meetings, for one-click re-adding.
  ipcMain.handle(Channels.TagFrequentAttendees, (_evt, clientId) => {
    if (typeof clientId !== 'string') throw new Error('clientId must be a string');
    const history = ctx.state
      .listTaggedAttendees(clientId)
      .map((r) => parseStoredAttendees(r.attendees_json));
    return rankFrequentAttendees(history);
  });

  ipcMain.handle(Channels.TagSuggestClient, (_evt, attendees) => {
    const list = assertAttendeesList(attendees);
    const history = ctx.state.listTaggedAttendees().map((r) => ({
      clientId: r.client_id,
      attendees: parseStoredAttendees(r.attendees_json),
    }));
    const clients = ctx.state
      .listClients()
      .filter((c) => c.id !== 'unclassified')
      .map((c) => ({ id: c.id, name: c.name }));
    return suggestClientId(list, history, clients);
  });

  // Attendees from whatever is on the clipboard, if it looks like an
  // invite's attendee list. Only addresses count: plain names parsed
  // from arbitrary copied text would be noise. The raw clipboard text
  // never leaves the main process.
  ipcMain.handle(Channels.TagClipboardAttendees, () => {
    return parseAttendeesText(clipboard.readText()).filter((a) => a.email !== null);
  });

  ipcMain.handle(Channels.TagOpenSheet, (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    if (row.status !== 'inbox') {
      throw new Error(`Recording is no longer in the inbox (status=${row.status})`);
    }
    ctx.logger.info({ recordingId }, 'opening tag sheet');
    openTagSheet(recordingId);
  });

  ipcMain.handle(Channels.PipelineCancel, (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    ctx.logger.info({ recordingId }, 'cancelling pipeline');
    ctx.getWorker()?.cancel(recordingId);
    broadcastInboxChanged();
  });

  ipcMain.handle(Channels.PipelineRetry, (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const changed = ctx.state.retry(recordingId);
    if (!changed) {
      throw new Error('Recording is not in a retryable state');
    }
    ctx.logger.info({ recordingId }, 'retrying pipeline');
    ctx.onStateChanged?.();
    broadcastInboxChanged();
    ctx.getWorker()?.nudge();
  });

  ipcMain.handle(Channels.PipelineFullRerun, async (_evt, recordingId) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);

    const localFileExists = audioFileExists(row);
    if (!localFileExists && row.source !== 'plaud') {
      throw new Error(
        'The original audio for this recording is gone and there is no cloud copy to re-fetch, so it cannot be re-run.',
      );
    }

    const { response } = await dialog.showMessageBox({
      type: 'warning',
      buttons: ['Cancel', 'Re-run'],
      defaultId: 0,
      cancelId: 0,
      message: 'Re-run this recording from the original audio?',
      detail:
        'This deletes the existing Markdown/HTML file and Apple Note for this recording, then re-transcribes and re-summarises from the original audio. This can\'t be undone.',
    });
    if (response !== 1) return { started: false };

    if (row.markdown_path) fs.rmSync(row.markdown_path, { force: true });
    if (row.html_path) fs.rmSync(row.html_path, { force: true });
    if (row.apple_note_id) {
      await deleteAppleNote(row.apple_note_id).catch((e) => {
        ctx.logger.warn(
          { err: String(e), recordingId },
          'could not delete previous Apple Note ahead of full re-run — proceeding anyway',
        );
      });
    }

    const changed = ctx.state.fullRerun(recordingId, !localFileExists);
    if (!changed) {
      throw new Error('Recording is not in a re-runnable state (must be complete or hidden).');
    }
    ctx.logger.info({ recordingId, redownload: !localFileExists }, 'full re-run started');
    ctx.onStateChanged?.();
    broadcastInboxChanged();
    ctx.getWorker()?.nudge();
    return { started: true };
  });

  ipcMain.handle(Channels.ClientsList, () => {
    return ctx.state.listClients().map(toClientDTO);
  });

  ipcMain.handle(Channels.ClientsAdd, (_evt, payload) => {
    const p = assertAddClientPayload(payload);
    const name = p.name.trim();
    if (name.length === 0) throw new Error('Client name cannot be empty');
    const existing = ctx.state.listClients().find((c) => c.name.toLowerCase() === name.toLowerCase());
    if (existing) throw new Error(`A client named "${existing.name}" already exists`);
    const id = slugify(name) || `client-${crypto.randomUUID().slice(0, 8)}`;
    ctx.state.upsertClient({ id, name, is_builtin: 0, sort_order: 500 });
    ctx.logger.info({ clientId: id, name }, 'client added');
    const saved = ctx.state.getClient(id)!;
    return toClientDTO(saved);
  });

  ipcMain.handle(Channels.MeetingTypesList, () => {
    return ctx.state.listMeetingTypes().map(toMeetingTypeDTO);
  });

  ipcMain.handle(Channels.MeetingTypesAdd, (_evt, payload) => {
    const p = assertAddMeetingTypePayload(payload);
    const name = p.name.trim();
    const prompt = p.prompt.trim();
    if (name.length === 0) throw new Error('Meeting type name cannot be empty');
    if (prompt.length === 0) throw new Error('Prompt cannot be empty');
    const existing = ctx.state
      .listMeetingTypes()
      .find((m) => m.name.toLowerCase() === name.toLowerCase());
    if (existing) throw new Error(`A meeting type named "${existing.name}" already exists`);
    const id = slugify(name) || `meeting-type-${crypto.randomUUID().slice(0, 8)}`;
    ctx.state.upsertMeetingType({
      id,
      name,
      prompt,
      is_builtin: 0,
      sort_order: 500,
      original_prompt_hash: null,
    });
    ctx.logger.info({ meetingTypeId: id, name }, 'meeting type added');
    const saved = ctx.state.getMeetingType(id)!;
    return toMeetingTypeDTO(saved);
  });

  ipcMain.handle(Channels.MeetingTypesDelete, (_evt, id) => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    const existing = ctx.state.getMeetingType(id);
    const displayName = existing?.name ?? id;
    const result = ctx.state.deleteMeetingType(id);
    switch (result.kind) {
      case 'deleted':
        ctx.logger.info(
          { meetingTypeId: id, name: displayName, detachedCount: result.detachedCount },
          result.detachedCount > 0
            ? 'meeting type deleted; existing recordings detached'
            : 'meeting type deleted',
        );
        return { deletedId: id };
      case 'not-found':
        throw new Error(`No such meeting type: ${id}`);
      case 'builtin':
        throw new Error(
          `"${displayName}" is a built-in prompt and can't be deleted. Use "Revert to default" to restore the original prompt text instead.`,
        );
    }
  });

  ipcMain.handle(Channels.LocalImportPath, async (_evt, p) => {
    if (typeof p !== 'string') throw new Error('path must be a string');
    try {
      const result = await importLocalFile(p, {
        state: ctx.state,
        logger: ctx.logger,
        onProgress: (progress) => broadcastLocalImportProgress(progress),
      });
      ctx.onStateChanged?.();
      broadcastInboxChanged();
      return { recordingId: result.recordingId };
    } catch (e) {
      if (e instanceof LocalImportError) throw e;
      ctx.logger.error({ err: String(e) }, 'local import failed unexpectedly');
      throw new Error('Import failed. See logs for details.');
    }
  });

  ipcMain.handle(Channels.LocalImportPickFiles, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import audio, video, or an existing transcript',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Audio, video and transcripts',
          extensions: [
            'mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'opus',
            'mp4', 'mov', 'm4v', 'mkv', 'webm',
            'md', 'markdown', 'txt',
          ],
        },
        { name: 'Transcripts only', extensions: ['md', 'markdown', 'txt'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  ipcMain.handle(Channels.SettingsLoad, () => {
    const cfg = ctx.getConfig();
    const totalRam = os.totalmem();
    const rec = recommendModelForRam(totalRam);
    return {
      outputs: {
        markdown: { ...cfg.outputs.markdown },
        html: { ...cfg.outputs.html },
        appleNotes: { ...cfg.outputs.appleNotes },
      },
      prompts: ctx.state.listMeetingTypes().map(toMeetingTypeDTO),
      vocabularyScopes: listVocabularyScopes(ctx),
      vocabularyBudget: vocabularyBudget(ctx),
      general: toGeneralDTO(cfg),
      performance: toPerformanceDTO(cfg),
      sources: toSourcesDTO(ctx),
      system: {
        totalRamGb: Math.round(totalRam / (1024 * 1024 * 1024)),
        recommendedModel: rec.model,
        recommendedReason: rec.reason,
        recommendationTable: recommendationTable(),
      },
      modelSuggestion: readModelSuggestion(ctx.state),
    };
  });

  ipcMain.handle(Channels.SettingsDismissModelSuggestion, () => {
    dismissModelSuggestion(ctx.state);
    ctx.logger.info('model upgrade suggestion dismissed');
  });

  ipcMain.handle(Channels.SettingsPullModel, async (_evt, model) => {
    if (typeof model !== 'string' || model.trim().length === 0) {
      throw new Error('model must be a non-empty string');
    }
    const cfg = ctx.getConfig();
    ctx.logger.info({ model }, 'pulling Ollama model at user request');
    try {
      await pullModel(cfg.ollama.host, model, (p) => {
        broadcastModelPullProgress({ model, ...p });
      });
      ctx.logger.info({ model }, 'model pull complete');
      broadcastModelPullProgress({ model, status: 'success', percent: 100 });
      return { ok: true as const };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.warn({ model, err: msg }, 'model pull failed');
      broadcastModelPullProgress({ model, status: `error: ${msg}`, percent: null });
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(Channels.SettingsSaveOutputs, (_evt, payload) => {
    const outputs = assertOutputsDTO(payload);
    if (outputs.markdown.enabled && !outputs.markdown.dir.trim()) {
      throw new Error('Markdown output is enabled but no folder is set.');
    }
    if (outputs.html.enabled && !outputs.html.dir.trim()) {
      throw new Error('HTML output is enabled but no folder is set.');
    }
    if (outputs.appleNotes.enabled && !outputs.appleNotes.parentFolder.trim()) {
      throw new Error('Apple Notes output is enabled but no folder name is set.');
    }
    if (!outputs.markdown.enabled && !outputs.html.enabled && !outputs.appleNotes.enabled) {
      throw new Error('At least one output destination must be enabled.');
    }
    const updated = ctx.applyConfigUpdate({ outputs });
    saveConfig(updated);
    ctx.logger.info({ outputs: updated.outputs }, 'outputs settings saved');
  });

  ipcMain.handle(Channels.SettingsSavePrompt, (_evt, payload) => {
    const p = assertSavePromptPayload(payload);
    const prompt = p.prompt.trim();
    if (prompt.length === 0) throw new Error('Prompt cannot be empty.');
    const existing = ctx.state.getMeetingType(p.id);
    if (!existing) throw new Error(`No such meeting type: ${p.id}`);
    const patch: { prompt: string; name?: string } = { prompt };
    if (p.name !== undefined) {
      const newName = p.name.trim();
      if (newName.length === 0) throw new Error('Name cannot be empty.');
      const clash = ctx.state
        .listMeetingTypes()
        .find((m) => m.id !== p.id && m.name.toLowerCase() === newName.toLowerCase());
      if (clash) throw new Error(`A meeting type named "${clash.name}" already exists.`);
      patch.name = newName;
    }
    const changed = ctx.state.updateMeetingType(p.id, patch);
    if (!changed) throw new Error(`Failed to update meeting type ${p.id}`);
    ctx.logger.info(
      {
        meetingTypeId: p.id,
        promptChars: prompt.length,
        renamed: patch.name !== undefined,
        isBuiltin: existing.is_builtin === 1,
      },
      'meeting-type prompt saved',
    );
    const updated = ctx.state.getMeetingType(p.id)!;
    return toMeetingTypeDTO(updated);
  });

  ipcMain.handle(Channels.SettingsRevertPromptToBuiltin, (_evt, id) => {
    if (typeof id !== 'string') throw new Error('id must be a string');
    const existing = ctx.state.getMeetingType(id);
    if (!existing) throw new Error(`No such meeting type: ${id}`);
    if (existing.is_builtin !== 1) {
      throw new Error('Only built-in meeting types have a default to revert to.');
    }
    const seeded = readSeedPrompt(ctx.resourcesDir, id);
    if (seeded === undefined) {
      throw new Error(
        `Could not find a seeded prompt for "${id}" in PROMPTS.md. This usually means the id has drifted between the seed list and PROMPTS.md — check that a "## N. \`${id}\`" heading still exists.`,
      );
    }
    const seededHash = hashPrompt(seeded);
    const changed = ctx.state.revertMeetingTypeToBuiltin(id, seeded, seededHash);
    if (!changed) throw new Error(`Failed to revert meeting type ${id}`);
    ctx.logger.info({ meetingTypeId: id }, 'meeting-type prompt reverted to default');
    if (existing.original_prompt_hash !== null && existing.original_prompt_hash !== seededHash) {
      ctx.logger.warn(
        {
          meetingTypeId: id,
          previousSeedHash: existing.original_prompt_hash,
          newSeedHash: seededHash,
        },
        'PROMPTS.md has drifted since original seed — reverted (and reseeded hash) to current file contents',
      );
    }
    const updated = ctx.state.getMeetingType(id)!;
    return toMeetingTypeDTO(updated);
  });

  ipcMain.handle(Channels.SettingsImportPrompts, async () => {
    const result = await dialog.showOpenDialog({
      title: 'Import prompts from markdown',
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        { name: 'Markdown', extensions: ['md', 'markdown'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const sourcePath = result.filePaths[0];
    let raw: string;
    try {
      raw = fs.readFileSync(sourcePath, 'utf-8');
    } catch (e) {
      throw new Error(`Could not read "${sourcePath}": ${e instanceof Error ? e.message : String(e)}`);
    }
    const parsed = parsePromptsMarkdownDetailed(raw);
    if (parsed.length === 0) {
      throw new Error(
        `No prompts found in "${sourcePath}". The file should have headings like "## 1. \`my-id\` — My Display Name" with a fenced code block underneath each heading.`,
      );
    }
    let created = 0;
    let updated = 0;
    for (const entry of parsed) {
      const trimmedPrompt = entry.prompt.trim();
      if (trimmedPrompt.length === 0) continue;
      const existing = ctx.state.getMeetingType(entry.id);
      if (existing) {
        const namePatch =
          entry.name && entry.name !== existing.name
            ? (() => {
                const clash = ctx.state
                  .listMeetingTypes()
                  .find((m) => m.id !== entry.id && m.name.toLowerCase() === entry.name.toLowerCase());
                return clash ? undefined : entry.name;
              })()
            : undefined;
        ctx.state.updateMeetingType(entry.id, {
          ...(namePatch !== undefined ? { name: namePatch } : {}),
          prompt: trimmedPrompt,
        });
        updated++;
      } else {
        let name = entry.name;
        const nameClash = ctx.state
          .listMeetingTypes()
          .find((m) => m.name.toLowerCase() === name.toLowerCase());
        if (nameClash) name = `${name} (imported)`;
        ctx.state.upsertMeetingType({
          id: entry.id,
          name,
          prompt: trimmedPrompt,
          is_builtin: 0,
          sort_order: 500,
          original_prompt_hash: null,
        });
        created++;
      }
    }
    ctx.logger.info(
      { sourcePath, parsedCount: parsed.length, created, updated },
      'prompts imported from markdown',
    );
    const prompts = ctx.state.listMeetingTypes().map(toMeetingTypeDTO);
    return { created, updated, prompts };
  });

  ipcMain.handle(Channels.SettingsLoadVocabulary, (_evt, scopeId) => {
    if (typeof scopeId !== 'string') throw new Error('scopeId must be a string');
    assertScopeIdExists(ctx, scopeId);
    const file = readVocabularyFile(vocabularyDirFor(), scopeId);
    return toVocabularyFileDTO(file);
  });

  // Live budget for hints the editor is showing but has not saved. Merging
  // stays in loadVocabulary so the number on screen is produced by the same
  // code that builds the real prompt.
  ipcMain.handle(Channels.SettingsPreviewVocabularyBudget, (_evt, payload) => {
    const p = payload as { scopeId?: unknown; hints?: unknown };
    if (typeof p?.scopeId !== 'string') throw new Error('scopeId must be a string');
    if (!Array.isArray(p.hints) || p.hints.some((h) => typeof h !== 'string')) {
      throw new Error('hints must be an array of strings');
    }
    assertScopeIdExists(ctx, p.scopeId);
    return vocabularyBudget(ctx, { scopeId: p.scopeId, hints: p.hints as string[] });
  });

  ipcMain.handle(Channels.SettingsSaveVocabulary, (_evt, payload) => {
    const p = assertSaveVocabularyPayload(payload);
    assertScopeIdExists(ctx, p.scopeId);
    const existing = readVocabularyFile(vocabularyDirFor(), p.scopeId) as VocabularyFile & {
      $description?: string;
    };
    const next: VocabularyFile & { $description?: string } = {
      $description: existing.$description,
      $version: existing.$version ?? 1,
      whisperHints: p.file.whisperHints,
      replacements: p.file.replacements.map((r) => ({
        from: r.from,
        to: r.to,
        ...(r.requiresContext && r.requiresContext.length > 0
          ? { requiresContext: r.requiresContext }
          : {}),
      })),
      notes: p.file.notes,
    };
    writeVocabularyFile(vocabularyDirFor(), p.scopeId, next);
    ctx.logger.info(
      {
        scopeId: p.scopeId,
        hints: next.whisperHints?.length ?? 0,
        replacements: next.replacements?.length ?? 0,
        builtin: isBuiltinScopeId(p.scopeId),
      },
      'vocabulary scope saved',
    );
    return scopeSummary(ctx, p.scopeId, next);
  });

  ipcMain.handle(Channels.SettingsImportVocabulary, async (_evt, scopeId) => {
    if (typeof scopeId !== 'string') throw new Error('scopeId must be a string');
    assertScopeIdExists(ctx, scopeId);
    const result = await dialog.showOpenDialog({
      title: `Import vocabulary into "${scopeId}"`,
      buttonLabel: 'Import',
      properties: ['openFile'],
      filters: [
        { name: 'Vocabulary file', extensions: ['json', 'md', 'markdown'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    const sourcePath = result.filePaths[0];
    let raw: string;
    try {
      raw = fs.readFileSync(sourcePath, 'utf-8');
    } catch (e) {
      throw new Error(`Could not read "${sourcePath}": ${e instanceof Error ? e.message : String(e)}`);
    }
    const lowerPath = sourcePath.toLowerCase();
    let importedHints: string[] = [];
    let importedReplacements: VocabularyReplacement[] = [];
    let importedNotes: string[] | undefined;
    let sourceFormat: 'json' | 'markdown';
    if (lowerPath.endsWith('.json')) {
      sourceFormat = 'json';
      let parsedJson: unknown;
      try {
        parsedJson = JSON.parse(raw);
      } catch (e) {
        throw new Error(
          `Could not parse "${sourcePath}" as JSON: ${e instanceof Error ? e.message : String(e)}`,
        );
      }
      const validated = assertSaveVocabularyPayload({ scopeId, file: parsedJson });
      importedHints = validated.file.whisperHints;
      importedReplacements = validated.file.replacements;
      importedNotes = validated.file.notes;
    } else if (lowerPath.endsWith('.md') || lowerPath.endsWith('.markdown')) {
      sourceFormat = 'markdown';
      const tableRows = parseVocabularyMarkdownTables(raw);
      if (tableRows.length === 0) {
        throw new Error(
          `No vocabulary entries found in "${sourcePath}". The file should contain one or more markdown tables with the columns "Heard as", "Should be", and (optionally) "Context cue".`,
        );
      }
      importedReplacements = tableRows.map((r) => ({
        from: r.from,
        to: r.to,
        ...(r.requiresContext && r.requiresContext.length > 0
          ? { requiresContext: r.requiresContext }
          : {}),
      }));
    } else {
      throw new Error(
        `Unsupported file type: "${sourcePath}". Pick a .json vocabulary file or a .md / .markdown file with "Heard as / Should be / Context cue" tables.`,
      );
    }
    const existing = readVocabularyFile(vocabularyDirFor(), scopeId) as VocabularyFile & {
      $description?: string;
    };
    const mergedHints = mergeHints(existing.whisperHints ?? [], importedHints);
    const mergedReplacements = mergeReplacements(existing.replacements ?? [], importedReplacements);
    const mergedNotes = mergeNotes(existing.notes, importedNotes);
    const next: VocabularyFile & { $description?: string } = {
      $description: existing.$description,
      $version: existing.$version ?? 1,
      whisperHints: mergedHints,
      replacements: mergedReplacements,
      ...(mergedNotes && mergedNotes.length > 0 ? { notes: mergedNotes } : {}),
    };
    writeVocabularyFile(vocabularyDirFor(), scopeId, next);
    ctx.logger.info(
      {
        scopeId,
        sourcePath,
        sourceFormat,
        existingHints: existing.whisperHints?.length ?? 0,
        importedHints: importedHints.length,
        mergedHints: mergedHints.length,
        existingReplacements: existing.replacements?.length ?? 0,
        importedReplacements: importedReplacements.length,
        mergedReplacements: mergedReplacements.length,
      },
      'vocabulary import merged into scope',
    );
    return toVocabularyFileDTO(next);
  });

  ipcMain.handle(Channels.SettingsExportVocabulary, async (_evt, scopeId) => {
    if (typeof scopeId !== 'string') throw new Error('scopeId must be a string');
    assertScopeIdExists(ctx, scopeId);
    const file = readVocabularyFile(vocabularyDirFor(), scopeId);
    const defaultName = `${scopeId}-vocabulary.json`;
    const result = await dialog.showSaveDialog({
      title: `Export vocabulary scope "${scopeId}"`,
      buttonLabel: 'Export',
      defaultPath: defaultName,
      filters: [
        { name: 'Vocabulary JSON', extensions: ['json'] },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled || !result.filePath) return null;
    const serialised = JSON.stringify(file, null, 2) + '\n';
    try {
      fs.writeFileSync(result.filePath, serialised, 'utf-8');
    } catch (e) {
      throw new Error(
        `Could not write to "${result.filePath}": ${e instanceof Error ? e.message : String(e)}`,
      );
    }
    ctx.logger.info(
      {
        scopeId,
        exportPath: result.filePath,
        hints: file.whisperHints?.length ?? 0,
        replacements: file.replacements?.length ?? 0,
      },
      'vocabulary scope exported',
    );
    return { path: result.filePath };
  });

  ipcMain.handle(Channels.SettingsSaveGeneral, (_evt, payload) => {
    const general = assertGeneralDTO(payload);
    const updated = ctx.applyConfigUpdate({
      audioRetentionDays: general.audioRetentionDays,
      autoDismissCompleteMinutes: general.autoDismissCompleteMinutes,
    });
    saveConfig(updated);
    // Only touch the login item when it can mean something, and only when
    // it actually differs — setLoginItemSettings prompts for approval on
    // recent macOS, so no-op saves should stay silent.
    let launchAtLogin: boolean | 'unavailable' = 'unavailable';
    if (launchAtLoginAvailable()) {
      launchAtLogin = app.getLoginItemSettings().openAtLogin;
      if (launchAtLogin !== general.launchAtLogin) {
        app.setLoginItemSettings({ openAtLogin: general.launchAtLogin });
        // Read back rather than trusting the write. distill is unsigned, and
        // macOS can decline the registration or park it behind an approval
        // in System Settings; setLoginItemSettings reports nothing either
        // way. Saying "saved" over a setting that did not take is the
        // failure mode this app keeps hitting.
        launchAtLogin = app.getLoginItemSettings().openAtLogin;
        if (launchAtLogin !== general.launchAtLogin) {
          ctx.logger.warn(
            { requested: general.launchAtLogin, actual: launchAtLogin },
            'login item did not take',
          );
          throw new Error(
            general.launchAtLogin
              ? 'macOS did not accept the login item. Open System Settings › General › Login Items and allow distill, then try again.'
              : 'macOS did not remove the login item. You can remove it under System Settings › General › Login Items.',
          );
        }
      }
    }
    ctx.logger.info(
      {
        audioRetentionDays: updated.audioRetentionDays,
        autoDismissCompleteMinutes: updated.autoDismissCompleteMinutes,
        launchAtLogin,
      },
      'general settings saved',
    );
    // Return what is actually true now, so the pane reflects the OS rather
    // than what the form asked for.
    return toGeneralDTO(updated);
  });

  ipcMain.handle(Channels.SettingsSavePerformance, (_evt, payload) => {
    const perf = assertPerformanceDTO(payload);
    const cfg = ctx.getConfig();
    const updated = ctx.applyConfigUpdate({
      ollama: {
        ...cfg.ollama,
        model: perf.ollamaModel,
        keepAlive: perf.ollamaKeepAlive,
      },
      whisperModel: perf.whisperModel,
      transcriptionEngine: perf.transcriptionEngine,
      parakeetModel: perf.parakeetModel,
    });
    saveConfig(updated);
    ctx.logger.info(
      {
        ollamaModel: updated.ollama.model,
        ollamaKeepAlive: updated.ollama.keepAlive,
        whisperModel: updated.whisperModel,
        transcriptionEngine: updated.transcriptionEngine,
        parakeetModel: updated.parakeetModel,
      },
      'performance settings saved',
    );
  });

  ipcMain.handle(Channels.SettingsInstallParakeet, async () => {
    ctx.logger.info('installing parakeet-mlx at user request');
    try {
      const result = await installParakeet({
        logger: ctx.logger,
        onProgress: (e) => {
          for (const win of BrowserWindow.getAllWindows()) {
            if (!win.isDestroyed()) win.webContents.send(Channels.PushParakeetInstallProgress, e);
          }
        },
      });
      if (result.kind === 'success') {
        ctx.logger.info('parakeet-mlx install complete');
        return { ok: true as const };
      }
      if (result.kind === 'cancelled') {
        return { ok: false as const, error: 'Install cancelled' };
      }
      ctx.logger.warn({ phase: result.phase, message: result.message }, 'parakeet-mlx install failed');
      return { ok: false as const, error: result.message };
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.warn({ err: msg }, 'parakeet-mlx install threw');
      return { ok: false as const, error: msg };
    }
  });

  ipcMain.handle(Channels.SettingsListOllamaModels, async () => {
    const cfg = ctx.getConfig();
    const client = new OllamaClient(cfg.ollama.host);
    const result = await client.listTags();
    if (!result.ok) {
      return { ok: false, reason: 'unreachable', detail: result.detail };
    }
    const models = result.models.map((m) => ({ name: m.name, sizeBytes: m.size }));
    return { ok: true, models };
  });

  ipcMain.handle(Channels.SettingsBrowseFolder, async (_evt, currentPath) => {
    const defaultPath = typeof currentPath === 'string' && currentPath ? currentPath : undefined;
    const result = await dialog.showOpenDialog({
      title: 'Choose output folder',
      buttonLabel: 'Select',
      properties: ['openDirectory', 'createDirectory'],
      defaultPath,
    });
    if (result.canceled || result.filePaths.length === 0) return null;
    return result.filePaths[0] ?? null;
  });

  ipcMain.handle(Channels.SettingsInspectOutputDir, (_evt, dir) => {
    if (typeof dir !== 'string') throw new Error('dir must be a string');
    return inspectOutputDir(dir);
  });

  ipcMain.handle(Channels.SettingsRevealPath, (_evt, dir) => {
    if (typeof dir !== 'string') throw new Error('dir must be a string');
    const status = inspectOutputDir(dir);
    // Reveal the folder itself when it exists, otherwise the nearest
    // place the user can actually look.
    const target = status.exists ? status.resolvedPath : path.dirname(status.resolvedPath);
    void shell.openPath(target).catch((e) =>
      ctx.logger.warn({ err: String(e), target }, 'failed to reveal output folder'),
    );
  });

  ipcMain.handle(Channels.SourcesPlaudSignIn, async (_evt, payload) => {
    const p = assertPlaudSignInPayload(payload);
    const store = ctx.getPlaudStore();
    if (!store) {
      throw new Error('Credential storage is not available. Restart the app and try again.');
    }
    try {
      await signInPlaud(store, { email: p.email, password: p.password, region: p.region });
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e);
      ctx.logger.warn({ err: msg, email: p.email }, 'Plaud sign-in failed');
      try {
        await store.clearCredentialsAsync();
      } catch {
        // sign-in already failed; credential cleanup is best-effort
      }
      throw new Error(`Sign in failed: ${msg}`);
    }
    ctx.logger.info({ email: p.email, region: p.region }, 'Plaud sign-in successful');
    ctx.onPlaudCredentialsChanged?.();
    return getPlaudAccountStatus(store);
  });

  ipcMain.handle(Channels.SourcesPlaudSignOut, async () => {
    const store = ctx.getPlaudStore();
    if (!store) return;
    await signOutPlaud(store);
    ctx.logger.info('Plaud signed out');
    ctx.onPlaudCredentialsChanged?.();
  });

  ipcMain.handle(Channels.SourcesPlaudStatus, () => {
    const store = ctx.getPlaudStore();
    if (!store) return { signedIn: false };
    return getPlaudAccountStatus(store);
  });

  ipcMain.handle(Channels.AppOpenSettings, (_evt, opts) => {
    const validTabs = new Set([
      'sources',
      'outputs',
      'prompts',
      'vocabulary',
      'general',
      'performance',
      'about',
    ]);
    let initialTab: string | undefined;
    if (opts && typeof opts === 'object') {
      const o = opts as { tab?: unknown };
      if (typeof o.tab === 'string' && validTabs.has(o.tab)) {
        initialTab = o.tab;
      }
    }
    openSettings(initialTab ? { initialTab } : undefined);
  });

  ipcMain.handle(Channels.AppGetTipJarStatus, () => {
    return readTipJarStatus(ctx.state);
  });

  ipcMain.handle(Channels.AppDismissTipJarBanner, () => {
    dismissBanner(ctx.state);
    ctx.logger.info('tip-jar banner dismissed');
  });

  ipcMain.handle(Channels.AppOpenTipJar, async () => {
    try {
      await shell.openExternal(TIP_JAR_URL);
      ctx.logger.info({ url: TIP_JAR_URL }, 'tip-jar URL opened');
    } catch (e) {
      ctx.logger.warn({ err: String(e), url: TIP_JAR_URL }, 'failed to open tip-jar URL');
    }
  });

  ipcMain.handle(Channels.SetupGetStatus, () => {
    const venvStatus = detectVenv();
    const systemPython = detectSystemPython();
    if (systemPython.kind === 'not-found') {
      return { kind: 'python-missing', triedPaths: systemPython.triedPaths };
    }
    return {
      kind: 'needs-setup',
      systemPython: systemPython.path,
      systemPythonVersion: systemPython.version,
      reason: describeVenvStatus(venvStatus),
    };
  });

  ipcMain.handle(Channels.SetupStart, async () => {
    const systemPython = detectSystemPython();
    if (systemPython.kind !== 'found') {
      return {
        kind: 'failed',
        phase: 'creating-venv' as SetupPhase,
        message: 'Python 3.11 was found at startup but is no longer reachable. Please re-launch distill.',
      };
    }
    ctx.logger.info(
      { systemPython: systemPython.path, version: systemPython.version },
      'starting venv install',
    );
    const result = await installVenv({
      systemPython: systemPython.path,
      logger: ctx.logger,
      onProgress: (event) => {
        if (event.log) {
          broadcastSetupProgress({ kind: 'log', phase: event.phase, log: event.log });
        } else {
          broadcastSetupProgress({ kind: 'phase', phase: event.phase });
        }
      },
    });
    if (result.kind === 'success') {
      ctx.logger.info({ pythonPath: result.pythonPath }, 'venv install succeeded');
      broadcastSetupProgress({ kind: 'done' });
      ctx.onSetupComplete?.();
      return { kind: 'success' };
    }
    if (result.kind === 'failed') {
      ctx.logger.warn({ phase: result.phase, message: result.message }, 'venv install failed');
      broadcastSetupProgress({
        kind: 'failed',
        failure: { phase: result.phase, message: result.message },
      });
      return result;
    }
    ctx.logger.info('venv install cancelled');
    return { kind: 'cancelled' };
  });

  ipcMain.handle(Channels.SetupQuit, () => {
    ctx.logger.info('user quit from setup window');
    app.quit();
  });
}

// --- broadcasts ------------------------------------------------------------

export function broadcastInboxChanged(): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushInboxChanged);
  }
}

export function broadcastFocusRecording(recordingId: string): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushFocusRecording, recordingId);
  }
}

export function broadcastLocalImportProgress(p: LocalImportProgress): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushLocalImportProgress, p);
  }
}

export interface ModelPullProgressBroadcast {
  model: string;
  status: string;
  completed?: number;
  total?: number;
  percent: number | null;
}

export function broadcastModelPullProgress(p: ModelPullProgressBroadcast): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushModelPullProgress, p);
  }
}

export interface SetupProgressBroadcast {
  kind: 'phase' | 'log' | 'done' | 'failed';
  phase?: SetupPhase;
  log?: { stream: 'stdout' | 'stderr'; text: string };
  failure?: { phase: SetupPhase; message: string };
}

export function broadcastSetupProgress(event: SetupProgressBroadcast): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushSetupProgress, event);
  }
}

function describeVenvStatus(status: VenvStatus): string {
  switch (status.kind) {
    case 'ready':
      return 'Already installed.';
    case 'missing':
      return 'Python environment not yet installed.';
    case 'broken':
      return `Existing environment is broken (${status.reason}). Will rebuild.`;
    case 'wrong-version':
      return `Existing environment uses ${status.foundVersion}; needs Python 3.11. Will rebuild.`;
    case 'incomplete':
      return 'Python environment exists but packages are missing. Will finish installing.';
  }
}

// --- DTO mappers -----------------------------------------------------------

export function toInboxDTO(r: JoinedRecordingRow, outputs: OutputsConfig) {
  const currentStep = statusToStep(r.status);
  const plan = stepPlanFor(r);
  const idx = currentStep ? plan.indexOf(currentStep) : -1;
  return {
    id: r.id,
    filename: r.filename,
    duration_seconds: r.duration_seconds,
    start_time: r.start_time,
    synced_at: r.synced_at,
    status: r.status,
    currentStep,
    // Progress as "2 of 4" rather than a bare step name. The total
    // varies by source — an imported transcript really does only have
    // two steps — so it is computed per row, not hardcoded.
    stepIndex: idx >= 0 ? idx + 1 : null,
    stepTotal: plan.length,
    // Which destinations actually produced a file, so the row can offer
    // a link per format and grey out the rest.
    outputs: {
      markdown: r.markdown_written_at !== null ? r.markdown_path : null,
      html: r.html_written_at !== null ? r.html_path : null,
      appleNote: r.apple_note_written_at !== null ? r.apple_note_id : null,
    },
    clientName: r.client_name,
    meetingTypeName: r.meeting_type_name,
    error: r.error,
    isAuthError: r.is_auth_error === 1,
    markdownPath: r.markdown_path,
    vocabularySources: r.vocabulary_sources,
    vocabularyRulesApplied: r.vocabulary_rules_applied,
    truncationWarning: r.truncation_warning === 1,
    estimatedInputTokens: r.estimated_input_tokens,
    contextWindowAtSubmit: r.context_window_at_submit,
    modelSnapshot: r.model_snapshot,
    processedExternally: r.processed_externally === 1,
    // Gates the "Full re-run" action: a local file to re-transcribe from,
    // or (Plaud rows only — retention never deletes their audio_path, but
    // the row may predate a local download, or the file may have been
    // removed by hand) a cloud copy that can be re-fetched.
    audioAvailable: audioFileExists(r) || r.source === 'plaud',
    // Effective per-destination targets: this row's override if it has
    // one, else whatever Settings -> Outputs currently says. Drives the
    // Inbox row's checkboxes.
    outputTargets: effectiveOutputTargets(r, outputs),
  };
}

function statusToStep(s: RecordingStatus): PipelineStep | null {
  switch (s) {
    case 'downloading':
      return 'download';
    case 'transcribing':
      return 'transcribe';
    case 'summarising':
      return 'summarise';
    case 'writing':
      return 'write';
    default:
      return null;
  }
}

function toClientDTO(r: ClientRow) {
  return {
    id: r.id,
    name: r.name,
    is_builtin: r.is_builtin === 1,
    sort_order: r.sort_order,
  };
}

function toMeetingTypeDTO(r: MeetingTypeRow) {
  const isBuiltin = r.is_builtin === 1;
  const is_modified =
    isBuiltin && r.original_prompt_hash !== null && hashPrompt(r.prompt) !== r.original_prompt_hash;
  return {
    id: r.id,
    name: r.name,
    prompt: r.prompt,
    is_builtin: isBuiltin,
    sort_order: r.sort_order,
    updated_at: r.updated_at,
    is_modified,
  };
}

/**
 * Launch at login is deliberately not mirrored into config.json. macOS owns
 * it — System Settings › General › Login Items can turn it off without
 * telling us, and a cached copy would then be wrong and would re-apply
 * itself on the next unrelated save. Read the OS every time.
 */
function launchAtLoginAvailable() {
  // Unpackaged, the login item registers the Electron dev binary, not
  // distill. The toggle would appear to work and do nothing useful.
  return app.isPackaged;
}

function toGeneralDTO(cfg: AppConfig) {
  return {
    audioRetentionDays: cfg.audioRetentionDays,
    autoDismissCompleteMinutes: cfg.autoDismissCompleteMinutes,
    launchAtLogin: launchAtLoginAvailable() ? app.getLoginItemSettings().openAtLogin : false,
    launchAtLoginAvailable: launchAtLoginAvailable(),
  };
}

function toPerformanceDTO(cfg: AppConfig) {
  return {
    ollamaModel: cfg.ollama.model,
    ollamaKeepAlive: cfg.ollama.keepAlive,
    whisperModel: cfg.whisperModel,
    transcriptionEngine: cfg.transcriptionEngine,
    parakeetModel: cfg.parakeetModel,
    parakeetInstalled: isParakeetInstalled(),
  };
}

function toSourcesDTO(ctx: IpcContext) {
  const store = ctx.getPlaudStore();
  return {
    plaud: store ? getPlaudAccountStatus(store) : { signedIn: false as const },
  };
}

// --- vocabulary scope helpers ---------------------------------------------

function vocabularyDirFor(): string {
  return userVocabularyDir();
}

const BUILTIN_SCOPE_LABELS: Record<string, string> = {
  global: 'Global',
  organisation: 'Organisation',
  industry: 'Industry',
};

function listVocabularyScopes(ctx: IpcContext) {
  const dir = vocabularyDirFor();
  const scopes = [];
  for (const id of BUILTIN_SCOPE_IDS) {
    scopes.push(scopeSummary(ctx, id, readVocabularyFile(dir, id)));
  }
  for (const client of ctx.state.listClients()) {
    if (isBuiltinScopeId(client.id)) continue;
    scopes.push(scopeSummary(ctx, client.id, readVocabularyFile(dir, client.id)));
  }
  return scopes;
}

/**
 * How much of the vocabulary Whisper can actually use.
 *
 * The scopes are just folders for managing keywords — they carry no
 * special meaning — but they all merge into one prompt with a hard
 * 800-character limit. Beyond that, terms are silently ignored, which
 * is invisible while curating lists in four separate files.
 */
function vocabularyBudget(ctx: IpcContext, draft?: { scopeId: string; hints: string[] }) {
  const dir = vocabularyDirFor();
  // Worst case is a client meeting: its scope plus all three shared ones.
  const clientIds = ctx.state.listClients().map((c) => c.id).filter((id) => !isBuiltinScopeId(id));
  // When a client scope is being edited, that client *is* the case to
  // report — showing some other client's worse total would be confusing
  // while typing. Editing a shared scope still reports the worst client.
  const candidates =
    draft && !isBuiltinScopeId(draft.scopeId) ? [draft.scopeId] : [null, ...clientIds];
  let worst: ReturnType<typeof loadVocabulary> | null = null;
  for (const id of candidates) {
    const v = loadVocabulary(dir, id, draft);
    if (!worst || v.hintsDropped.length > worst.hintsDropped.length) worst = v;
  }
  const w = worst!;
  return {
    limit: WHISPER_PROMPT_CHAR_LIMIT,
    used: w.whisperPrompt.length,
    hintsAvailable: w.hintsAvailable,
    hintsUsed: w.hintsUsed,
    dropped: w.hintsDropped,
  };
}

function scopeSummary(ctx: IpcContext, scopeId: string, file: VocabularyFile) {
  const builtin = isBuiltinScopeId(scopeId);
  let label: string;
  if (builtin) {
    label = BUILTIN_SCOPE_LABELS[scopeId] ?? scopeId;
  } else {
    const client = ctx.state.getClient(scopeId);
    label = client?.name ?? scopeId;
  }
  return {
    id: scopeId,
    label,
    builtin,
    termCount: countVocabularyTerms(file),
  };
}

function assertScopeIdExists(ctx: IpcContext, scopeId: string): void {
  if (isBuiltinScopeId(scopeId)) return;
  const client = ctx.state.getClient(scopeId);
  if (!client) {
    throw new Error(
      `Unknown vocabulary scope: "${scopeId}". Must be one of: ${BUILTIN_SCOPE_IDS.join(', ')}, or a client id.`,
    );
  }
}

function toVocabularyFileDTO(file: VocabularyFile) {
  return {
    whisperHints: [...(file.whisperHints ?? [])],
    replacements: (file.replacements ?? []).map((r) => ({
      from: r.from,
      to: r.to,
      ...(r.requiresContext ? { requiresContext: [...r.requiresContext] } : {}),
    })),
    ...(file.notes ? { notes: [...file.notes] } : {}),
  };
}

function mergeHints(existing: string[], imported: string[]): string[] {
  const seen = new Set<string>();
  const out: string[] = [];
  for (const h of existing) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  for (const h of imported) {
    const key = h.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push(h);
  }
  return out;
}

function mergeReplacements(
  existing: VocabularyReplacement[],
  imported: VocabularyReplacement[],
): VocabularyReplacement[] {
  const importedByKey = new Map<string, VocabularyReplacement>();
  for (const r of imported) {
    importedByKey.set(r.from.toLowerCase(), r);
  }
  const out: VocabularyReplacement[] = [];
  for (const r of existing) {
    const key = r.from.toLowerCase();
    const fromImport = importedByKey.get(key);
    if (fromImport) {
      out.push({
        from: fromImport.from,
        to: fromImport.to,
        ...(fromImport.requiresContext && fromImport.requiresContext.length > 0
          ? { requiresContext: [...fromImport.requiresContext] }
          : {}),
      });
      importedByKey.delete(key);
    } else {
      out.push({
        from: r.from,
        to: r.to,
        ...(r.requiresContext && r.requiresContext.length > 0
          ? { requiresContext: [...r.requiresContext] }
          : {}),
      });
    }
  }
  for (const r of imported) {
    if (importedByKey.has(r.from.toLowerCase())) {
      out.push({
        from: r.from,
        to: r.to,
        ...(r.requiresContext && r.requiresContext.length > 0
          ? { requiresContext: [...r.requiresContext] }
          : {}),
      });
      importedByKey.delete(r.from.toLowerCase());
    }
  }
  return out;
}

function mergeNotes(existing?: string[], imported?: string[]): string[] | undefined {
  if (!existing && !imported) return undefined;
  const seen = new Set<string>();
  const out: string[] = [];
  for (const n of existing ?? []) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  for (const n of imported ?? []) {
    if (seen.has(n)) continue;
    seen.add(n);
    out.push(n);
  }
  return out.length > 0 ? out : undefined;
}

// --- payload asserts -------------------------------------------------------

function assertTagSavePayload(v: unknown): {
  recordingId: string;
  clientId: string;
  meetingTypeId: string;
  attendees?: Attendee[];
} {
  if (!v || typeof v !== 'object') throw new Error('Invalid tag payload');
  const o = v as Record<string, unknown>;
  if (typeof o.recordingId !== 'string') throw new Error('recordingId must be a string');
  if (typeof o.clientId !== 'string') throw new Error('clientId must be a string');
  if (typeof o.meetingTypeId !== 'string') throw new Error('meetingTypeId must be a string');
  const attendees = o.attendees === undefined ? undefined : assertAttendeesList(o.attendees);
  return { recordingId: o.recordingId, clientId: o.clientId, meetingTypeId: o.meetingTypeId, attendees };
}

function assertAttendeesList(v: unknown): Attendee[] {
  if (!Array.isArray(v)) throw new Error('attendees must be an array');
  return v.map((entry, i) => {
    if (!entry || typeof entry !== 'object') throw new Error(`attendees[${i}] is invalid`);
    const e = entry as Record<string, unknown>;
    if (typeof e.name !== 'string' || e.name.trim().length === 0) {
      throw new Error(`attendees[${i}].name must be a non-empty string`);
    }
    if (e.email !== null && typeof e.email !== 'string') {
      throw new Error(`attendees[${i}].email must be a string or null`);
    }
    if (e.company !== null && typeof e.company !== 'string') {
      throw new Error(`attendees[${i}].company must be a string or null`);
    }
    return { name: e.name, email: (e.email as string | null) ?? null, company: (e.company as string | null) ?? null };
  });
}

function assertOutputTargetsPayload(v: unknown): {
  markdown: boolean;
  html: boolean;
  appleNote: boolean;
} {
  if (!v || typeof v !== 'object') throw new Error('Invalid output targets payload');
  const o = v as Record<string, unknown>;
  if (typeof o.markdown !== 'boolean') throw new Error('markdown must be a boolean');
  if (typeof o.html !== 'boolean') throw new Error('html must be a boolean');
  if (typeof o.appleNote !== 'boolean') throw new Error('appleNote must be a boolean');
  return { markdown: o.markdown, html: o.html, appleNote: o.appleNote };
}

function assertAddClientPayload(v: unknown): { name: string } {
  if (!v || typeof v !== 'object') throw new Error('Invalid client payload');
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new Error('name must be a string');
  return { name: o.name };
}

function assertAddMeetingTypePayload(v: unknown): { name: string; prompt: string } {
  if (!v || typeof v !== 'object') throw new Error('Invalid meeting-type payload');
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new Error('name must be a string');
  if (typeof o.prompt !== 'string') throw new Error('prompt must be a string');
  return { name: o.name, prompt: o.prompt };
}

function assertSavePromptPayload(v: unknown): { id: string; prompt: string; name?: string } {
  if (!v || typeof v !== 'object') throw new Error('Invalid prompt payload');
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') throw new Error('id must be a string');
  if (typeof o.prompt !== 'string') throw new Error('prompt must be a string');
  if (o.name !== undefined && typeof o.name !== 'string') {
    throw new Error('name must be a string when provided');
  }
  return { id: o.id, prompt: o.prompt, name: o.name as string | undefined };
}

function assertSaveVocabularyPayload(v: unknown): { scopeId: string; file: VocabularyFile } {
  if (!v || typeof v !== 'object') throw new Error('Invalid vocabulary payload');
  const o = v as Record<string, unknown>;
  if (typeof o.scopeId !== 'string') throw new Error('scopeId must be a string');
  if (!o.file || typeof o.file !== 'object') throw new Error('file must be an object');
  const f = o.file as Record<string, unknown>;
  if (!Array.isArray(f.whisperHints)) {
    throw new Error('file.whisperHints must be an array');
  }
  const hints: string[] = [];
  for (let i = 0; i < f.whisperHints.length; i++) {
    const h = f.whisperHints[i];
    if (typeof h !== 'string') {
      throw new Error(`file.whisperHints[${i}] must be a string`);
    }
    const trimmed = h.trim();
    if (trimmed.length === 0) continue;
    hints.push(trimmed);
  }
  if (!Array.isArray(f.replacements)) {
    throw new Error('file.replacements must be an array');
  }
  const replacements: VocabularyReplacement[] = [];
  for (let i = 0; i < f.replacements.length; i++) {
    const rRaw = f.replacements[i];
    if (!rRaw || typeof rRaw !== 'object') {
      throw new Error(`file.replacements[${i}] must be an object`);
    }
    const r = rRaw as Record<string, unknown>;
    if (typeof r.from !== 'string' || typeof r.to !== 'string') {
      throw new Error(`file.replacements[${i}]: "from" and "to" must both be strings`);
    }
    const fromTrim = r.from.trim();
    const toTrim = r.to.trim();
    if (fromTrim.length === 0 && toTrim.length === 0) continue;
    if (fromTrim.length === 0) {
      throw new Error(`file.replacements[${i}]: "from" is empty. Either fill it in or delete the row.`);
    }
    if (toTrim.length === 0) {
      throw new Error(`file.replacements[${i}] (from="${fromTrim}"): "to" is empty.`);
    }
    let requiresContext: string[] | undefined;
    if (r.requiresContext !== undefined) {
      if (!Array.isArray(r.requiresContext)) {
        throw new Error(
          `file.replacements[${i}] (from="${fromTrim}"): requiresContext must be an array`,
        );
      }
      const ctxArr = r.requiresContext
        .map((c: unknown, j: number) => {
          if (typeof c !== 'string') {
            throw new Error(`file.replacements[${i}].requiresContext[${j}] must be a string`);
          }
          return c.trim();
        })
        .filter((c: string) => c.length > 0);
      if (ctxArr.length > 0) requiresContext = ctxArr;
    }
    replacements.push({
      from: fromTrim,
      to: toTrim,
      ...(requiresContext ? { requiresContext } : {}),
    });
  }
  let notes: string[] | undefined;
  if (f.notes !== undefined) {
    if (!Array.isArray(f.notes)) {
      throw new Error('file.notes must be an array when provided');
    }
    notes = f.notes.map((n: unknown, i: number) => {
      if (typeof n !== 'string') {
        throw new Error(`file.notes[${i}] must be a string`);
      }
      return n;
    });
  }
  return {
    scopeId: o.scopeId,
    file: {
      $version: 1,
      whisperHints: hints,
      replacements,
      ...(notes ? { notes } : {}),
    },
  };
}

function assertOutputsDTO(v: unknown): OutputsConfig {
  if (!v || typeof v !== 'object') throw new Error('Invalid outputs payload');
  const o = v as Record<string, any>;
  const md = o.markdown;
  const html = o.html;
  const notes = o.appleNotes;
  if (!md || typeof md.enabled !== 'boolean' || typeof md.dir !== 'string' || typeof md.includeTranscript !== 'boolean') {
    throw new Error('outputs.markdown is malformed');
  }
  if (!html || typeof html.enabled !== 'boolean' || typeof html.dir !== 'string' || typeof html.includeTranscript !== 'boolean') {
    throw new Error('outputs.html is malformed');
  }
  if (!notes || typeof notes.enabled !== 'boolean' || typeof notes.parentFolder !== 'string' || typeof notes.includeTranscript !== 'boolean') {
    throw new Error('outputs.appleNotes is malformed');
  }
  return {
    markdown: {
      enabled: md.enabled,
      dir: md.dir,
      includeTranscript: md.includeTranscript,
    },
    html: {
      enabled: html.enabled,
      dir: html.dir,
      includeTranscript: html.includeTranscript,
    },
    appleNotes: {
      enabled: notes.enabled,
      parentFolder: notes.parentFolder,
      includeTranscript: notes.includeTranscript,
    },
  };
}

function slugify(s: string): string {
  return s
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 64);
}

function assertGeneralDTO(v: unknown): {
  audioRetentionDays: number | null;
  autoDismissCompleteMinutes: number;
  launchAtLogin: boolean;
} {
  if (!v || typeof v !== 'object') throw new Error('Invalid general payload');
  const o = v as Record<string, unknown>;

  if (typeof o.launchAtLogin !== 'boolean') {
    throw new Error('launchAtLogin must be a boolean');
  }
  const launchAtLogin = o.launchAtLogin;

  const dismiss = o.autoDismissCompleteMinutes;
  if (typeof dismiss !== 'number' || !Number.isInteger(dismiss) || dismiss < 0) {
    throw new Error('autoDismissCompleteMinutes must be a non-negative integer (0 disables auto-hide)');
  }

  const raw = o.audioRetentionDays;
  if (raw === null) return { audioRetentionDays: null, autoDismissCompleteMinutes: dismiss, launchAtLogin };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error('audioRetentionDays must be null or a non-negative integer');
  }
  if (!Number.isInteger(raw)) {
    throw new Error('audioRetentionDays must be a whole number of days');
  }
  if (raw < 0) {
    throw new Error('audioRetentionDays must be ≥ 0 (use null to disable the sweep)');
  }
  return { audioRetentionDays: raw, autoDismissCompleteMinutes: dismiss, launchAtLogin };
}

function assertPerformanceDTO(v: unknown): {
  ollamaModel: string;
  ollamaKeepAlive: string;
  whisperModel: string;
  transcriptionEngine: 'whisper' | 'parakeet';
  parakeetModel: string;
} {
  if (!v || typeof v !== 'object') throw new Error('Invalid performance payload');
  const o = v as Record<string, unknown>;
  if (typeof o.ollamaModel !== 'string') {
    throw new Error('ollamaModel must be a string');
  }
  const ollamaModel = o.ollamaModel.trim();
  if (ollamaModel.length === 0) {
    throw new Error('ollamaModel cannot be empty');
  }
  if (typeof o.ollamaKeepAlive !== 'string') {
    throw new Error('ollamaKeepAlive must be a string');
  }
  const keepAlive = o.ollamaKeepAlive;
  const allowedKeepAlive = KEEPALIVE_PRESETS.map((p) => p.value);
  if (!(allowedKeepAlive as string[]).includes(keepAlive)) {
    throw new Error(`ollamaKeepAlive must be one of: ${allowedKeepAlive.join(', ')}`);
  }
  if (typeof o.whisperModel !== 'string') {
    throw new Error('whisperModel must be a string');
  }
  const whisperModel = o.whisperModel.trim();
  const allowedWhisper = WHISPER_MODEL_PRESETS.map((p) => p.value);
  if (!(allowedWhisper as string[]).includes(whisperModel)) {
    throw new Error(
      `whisperModel must be one of the curated MLX models: ${allowedWhisper.join(', ')}`,
    );
  }
  if (o.transcriptionEngine !== 'whisper' && o.transcriptionEngine !== 'parakeet') {
    throw new Error('transcriptionEngine must be "whisper" or "parakeet"');
  }
  const transcriptionEngine = o.transcriptionEngine;
  if (typeof o.parakeetModel !== 'string' || o.parakeetModel.trim().length === 0) {
    throw new Error('parakeetModel must be a non-empty string');
  }
  const parakeetModel = o.parakeetModel.trim();
  return { ollamaModel, ollamaKeepAlive: keepAlive, whisperModel, transcriptionEngine, parakeetModel };
}

function assertPlaudSignInPayload(v: unknown): {
  email: string;
  password: string;
  region: 'us' | 'eu';
} {
  if (!v || typeof v !== 'object') throw new Error('Invalid sign-in payload');
  const o = v as Record<string, unknown>;
  if (typeof o.email !== 'string') throw new Error('email must be a string');
  if (typeof o.password !== 'string') throw new Error('password must be a string');
  if (typeof o.region !== 'string') throw new Error('region must be a string');
  const email = o.email.trim();
  if (email.length === 0) throw new Error('Email cannot be empty');
  if (o.password.length === 0) throw new Error('Password cannot be empty');
  if (o.region !== 'us' && o.region !== 'eu') {
    throw new Error('region must be "us" or "eu"');
  }
  return { email, password: o.password, region: o.region };
}

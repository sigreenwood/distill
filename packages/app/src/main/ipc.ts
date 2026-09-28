/**
 * IPC wiring for the main process.
 *
 * registerIpcHandlers() attaches one `ipcMain.handle()` per request channel
 * defined in shared/ipc-contract.ts. Handlers validate input, call into
 * State / Worker / Windows, and return DTOs. Business logic lives elsewhere.
 *
 * broadcastInboxChanged() and broadcastFocusRecording() push events to
 * every open BrowserWindow; renderers subscribe via the preload bridge.
 */

import { join } from 'node:path';
import { readFileSync, writeFileSync } from 'node:fs';
import { app, BrowserWindow, dialog, ipcMain, shell } from 'electron';
import { randomUUID } from 'node:crypto';
import type { Logger } from 'pino';
import type { AppConfig } from './config.js';
import { saveConfig } from './config.js';
import type { State, JoinedRecordingRow, MeetingTypeRow, RecordingStatus } from './state.js';
import type { Worker } from './pipeline/worker.js';
import { openTagSheet, openSettings } from './windows.js';
import { importLocalFile, LocalImportError } from './localImport.js';
import { hashPrompt, readSeedPrompt, parsePromptsMarkdownDetailed } from './seed.js';
import { parseVocabularyMarkdownTables } from './vocabularyMarkdownParser.js';
import {
  dismissBanner as dismissTipJarBanner,
  readTipJarStatus,
  TIP_JAR_URL,
} from './tipJar.js';
import { userVocabularyDir } from './paths.js';
import {
  detectSystemPython,
  detectVenv,
  type VenvStatus,
} from './pythonSetup.js';
import { installVenv } from './pythonInstaller.js';
import {
  BUILTIN_SCOPE_IDS,
  countVocabularyTerms,
  isBuiltinScopeId,
  readVocabularyFile,
  writeVocabularyFile,
  type VocabularyFile,
} from './vocabulary.js';
import {
  Channels,
  KEEPALIVE_PRESETS,
  WHISPER_MODEL_PRESETS,
  type AddClientPayload,
  type AddMeetingTypePayload,
  type ClientDTO,
  type GeneralDTO,
  type InboxRecordingDTO,
  type MeetingTypeDTO,
  type OllamaModelDTO,
  type OllamaModelsResult,
  type OutputsDTO,
  type PerformanceDTO,
  type PipelineStep,
  type PlaudAccountStatus,
  type PlaudSignInPayload,
  type SaveGeneralPayload,
  type SavePerformancePayload,
  type SavePromptPayload,
  type SaveVocabularyPayload,
  type SettingsDTO,
  type SetupInitialStatus,
  type SetupPhase,
  type SetupProgressEvent,
  type SourcesDTO,
  type TagSavePayload,
  type TipJarStatusDTO,
  type VocabularyFileDTO,
  type VocabularyReplacementDTO,
  type VocabularyScopeSummaryDTO,
} from '../shared/ipc-contract.js';
import { OllamaClient } from './ollama.js';
import { getPlaudAccountStatus, signInPlaud, signOutPlaud } from './plaud.js';
import type { KeychainCredentialStore } from './sources/keychainCredentialStore.js';

export interface IpcContext {
  state: State;
  logger: Logger;
  /**
   * Absolute path to the app package's `resources/` directory.
   * Used by the revert-prompt handler to find PROMPTS.md; the same
   * path the pipeline already uses to locate the bundled Python
   * venv, vocabulary JSON, etc.
   */
  resourcesDir: string;
  /**
   * Live reference to the current AppConfig. A getter rather than a value
   * so future config-reload flows (e.g. tray "Pause" toggling a flag) see
   * the latest values without re-registering handlers.
   */
  getConfig: () => AppConfig;
  /**
   * Called when Settings saves new values so main can swap its in-memory
   * config reference. Returns the updated config (post-normalisation).
   */
  applyConfigUpdate: (patch: Partial<AppConfig>) => AppConfig;
  /**
   * The pipeline worker. IPC handlers call into it to cancel, retry, or
   * nudge after a tag. Exposed as a getter so the handler registration can
   * happen before the worker is constructed if needed (lazy binding).
   */
  getWorker: () => Worker | null;
  /**
   * The Keychain-backed Plaud credential store. Exposed as a getter
   * for symmetry with getWorker, since the store is constructed in
   * index.ts after handler registration would have happened in a
   * stricter order. The store handles credential persistence; the
   * Sources IPC handlers call sign-in / sign-out / status helpers in
   * plaud.ts that take the store as an argument.
   */
  getPlaudStore: () => KeychainCredentialStore | null;
  /**
   * Called when Plaud sign-in or sign-out succeeds. Lets index.ts
   * (re)build the poller + pipeline worker against fresh credentials,
   * or tear them down on sign-out. Without this, signing in via the
   * UI would persist credentials but the running poller would still
   * be operating on the old (or absent) connection until restart.
   */
  onPlaudCredentialsChanged?: () => void;
  /**
   * Called after any IPC handler mutates state. Used by main to refresh
   * the tray badge / status line.
   */
  onStateChanged?: () => void;
  /**
   * Called when the first-launch setup install completes successfully.
   * Lets index.ts continue with the rest of app startup (poller, worker,
   * tray) that was deferred behind setup. Optional because in the
   * happy path (venv already exists) setup never runs and the
   * callback never fires.
   */
  onSetupComplete?: () => void;
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerIpcHandlers(ctx: IpcContext): void {
  // --- inbox -------------------------------------------------------------

  ipcMain.handle(Channels.InboxList, (): InboxRecordingDTO[] => {
    // Opportunistic sweep: dismiss 'complete' rows older than the
    // configured threshold before assembling the list. Means the UI
    // self-cleans whenever the user opens the inbox, without needing a
    // separate scheduled task. Skipping when disabled (<=0) is a no-op.
    const cfg = ctx.getConfig();
    const swept = ctx.state.sweepCompletedOlderThan(cfg.autoDismissCompleteMinutes);
    if (swept > 0) {
      ctx.logger.info(
        { count: swept, thresholdMinutes: cfg.autoDismissCompleteMinutes },
        'auto-dismissed completed recordings',
      );
      ctx.onStateChanged?.();
    }
    return ctx.state.listActiveJoined().map(toInboxDTO);
  });

  ipcMain.handle(Channels.InboxSkip, (_evt, recordingId: unknown) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const changed = ctx.state.skipRecording(recordingId);
    if (changed) {
      ctx.logger.info({ recordingId }, 'recording skipped');
      ctx.onStateChanged?.();
      broadcastInboxChanged();
    }
  });

  ipcMain.handle(Channels.InboxRevealInFinder, (_evt, recordingId: unknown) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);

    // Prefer the Markdown file; fall back to HTML. If neither landed
    // (Apple Notes only), open Notes.app to the specific note via the
    // notes:// URL scheme which uses the stored note id.
    if (row.markdown_path) {
      shell.showItemInFolder(row.markdown_path);
      return;
    }
    if (row.html_path) {
      shell.showItemInFolder(row.html_path);
      return;
    }
    if (row.apple_note_id) {
      // Notes deep-link: notes://showNote?identifier=<id>. The stored id
      // is the Notes.app noteId URI, which already contains the identifier.
      // Best-effort: open Notes.app to front and let the user navigate.
      void shell.openExternal('notes://');
      return;
    }
    throw new Error('No output written yet for this recording');
  });

  // --- tagging ------------------------------------------------------------

  ipcMain.handle(Channels.TagSave, (_evt, payload: unknown) => {
    const p = assertTagSavePayload(payload);
    const changed = ctx.state.tagRecording(p.recordingId, p.clientId, p.meetingTypeId);
    if (!changed) {
      throw new Error(
        'Recording could not be tagged \u2014 it may already have been tagged or skipped.',
      );
    }
    ctx.logger.info(
      { recordingId: p.recordingId, clientId: p.clientId, meetingTypeId: p.meetingTypeId },
      'recording tagged',
    );
    ctx.onStateChanged?.();
    broadcastInboxChanged();
    // Wake the pipeline worker so it processes the freshly-tagged row.
    ctx.getWorker()?.nudge();
  });

  ipcMain.handle(Channels.TagOpenSheet, (_evt, recordingId: unknown) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    const row = ctx.state.getRecording(recordingId);
    if (!row) throw new Error(`No such recording: ${recordingId}`);
    if (row.status !== 'inbox') {
      throw new Error(`Recording is no longer in the inbox (status=${row.status})`);
    }
    ctx.logger.info({ recordingId }, 'opening tag sheet');
    openTagSheet(recordingId);
  });

  // --- pipeline -----------------------------------------------------------

  ipcMain.handle(Channels.PipelineCancel, (_evt, recordingId: unknown) => {
    if (typeof recordingId !== 'string') throw new Error('recordingId must be a string');
    ctx.logger.info({ recordingId }, 'cancelling pipeline');
    ctx.getWorker()?.cancel(recordingId);
    // Worker.cancel fires its own onStateChanged callback; also broadcast
    // so any open renderer picks it up.
    broadcastInboxChanged();
  });

  ipcMain.handle(Channels.PipelineRetry, (_evt, recordingId: unknown) => {
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

  // --- clients -----------------------------------------------------------

  ipcMain.handle(Channels.ClientsList, (): ClientDTO[] => {
    return ctx.state.listClients().map(toClientDTO);
  });

  ipcMain.handle(Channels.ClientsAdd, (_evt, payload: unknown): ClientDTO => {
    const p = assertAddClientPayload(payload);
    const name = p.name.trim();
    if (name.length === 0) throw new Error('Client name cannot be empty');

    const existing = ctx.state.listClients().find(
      (c) => c.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) throw new Error(`A client named "${existing.name}" already exists`);

    const id = slugify(name) || `client-${randomUUID().slice(0, 8)}`;
    ctx.state.upsertClient({ id, name, is_builtin: 0, sort_order: 500 });
    ctx.logger.info({ clientId: id, name }, 'client added');

    const saved = ctx.state.getClient(id)!;
    return toClientDTO(saved);
  });

  // --- meeting types -----------------------------------------------------

  ipcMain.handle(Channels.MeetingTypesList, (): MeetingTypeDTO[] => {
    return ctx.state.listMeetingTypes().map(toMeetingTypeDTO);
  });

  ipcMain.handle(Channels.MeetingTypesAdd, (_evt, payload: unknown): MeetingTypeDTO => {
    const p = assertAddMeetingTypePayload(payload);
    const name = p.name.trim();
    const prompt = p.prompt.trim();
    if (name.length === 0) throw new Error('Meeting type name cannot be empty');
    if (prompt.length === 0) throw new Error('Prompt cannot be empty');

    const existing = ctx.state.listMeetingTypes().find(
      (m) => m.name.toLowerCase() === name.toLowerCase(),
    );
    if (existing) throw new Error(`A meeting type named "${existing.name}" already exists`);

    const id = slugify(name) || `meeting-type-${randomUUID().slice(0, 8)}`;
    // User-created types have no default to differ from — original_prompt_hash stays null.
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

  ipcMain.handle(
    Channels.MeetingTypesDelete,
    (_evt, id: unknown): { deletedId: string } => {
      if (typeof id !== 'string') throw new Error('id must be a string');
      // Look up the row first so error messages can name it ("the
      // 'Internal one-to-one' prompt is in use by 3 recordings")
      // rather than dumping the opaque slug. We do an unauthenticated
      // read here; the actual delete contract is in
      // State.deleteMeetingType which gates on is_builtin and
      // FK references inside one transaction.
      const existing = ctx.state.getMeetingType(id);
      const displayName = existing?.name ?? id;

      const result = ctx.state.deleteMeetingType(id);
      switch (result.kind) {
        case 'deleted':
          ctx.logger.info(
            {
              meetingTypeId: id,
              name: displayName,
              detachedCount: result.detachedCount,
            },
            result.detachedCount > 0
              ? 'meeting type deleted; existing recordings detached'
              : 'meeting type deleted',
          );
          return { deletedId: id };

        case 'not-found':
          throw new Error(`No such meeting type: ${id}`);

        case 'builtin':
          // Built-ins are re-seeded on next launch from PROMPTS.md so
          // any delete would silently un-do itself. Communicate that
          // honestly rather than letting the user think the delete
          // worked. The Revert button handles "I edited a built-in and
          // want it back to default"; deleting was never the intent.
          throw new Error(
            `"${displayName}" is a built-in prompt and can't be deleted. ` +
              `Use "Revert to default" to restore the original prompt text instead.`,
          );
      }
    },
  );

  // --- local import ------------------------------------------------------

  ipcMain.handle(Channels.LocalImportPath, async (_evt, path: unknown) => {
    if (typeof path !== 'string') throw new Error('path must be a string');
    try {
      const result = await importLocalFile(path, {
        state: ctx.state,
        logger: ctx.logger,
        onProgress: (p) => broadcastLocalImportProgress(p),
      });
      ctx.onStateChanged?.();
      broadcastInboxChanged();
      return { recordingId: result.recordingId };
    } catch (e) {
      // LocalImportError carries a user-readable message; any other error
      // is programmer-level so we wrap it to avoid leaking stack traces
      // into the renderer.
      if (e instanceof LocalImportError) throw e;
      ctx.logger.error({ err: String(e) }, 'local import failed unexpectedly');
      throw new Error('Import failed. See logs for details.');
    }
  });

  ipcMain.handle(Channels.LocalImportPickFiles, async (): Promise<string[]> => {
    // Multi-select picker. We deliberately don't perform the imports
    // here — the renderer queues them through LocalImportPath one at
    // a time so the UI can render a per-file queue with progress.
    const result = await dialog.showOpenDialog({
      title: 'Import audio or video',
      buttonLabel: 'Import',
      properties: ['openFile', 'multiSelections'],
      filters: [
        {
          name: 'Audio and video',
          extensions: ['mp3', 'm4a', 'wav', 'aac', 'ogg', 'flac', 'opus', 'mp4', 'mov', 'm4v', 'mkv', 'webm'],
        },
        { name: 'All files', extensions: ['*'] },
      ],
    });
    if (result.canceled) return [];
    return result.filePaths;
  });

  // --- settings ----------------------------------------------------------

  ipcMain.handle(Channels.SettingsLoad, (): SettingsDTO => {
    const cfg = ctx.getConfig();
    return {
      outputs: {
        markdown: { ...cfg.outputs.markdown },
        html: { ...cfg.outputs.html },
        appleNotes: { ...cfg.outputs.appleNotes },
      },
      prompts: ctx.state.listMeetingTypes().map(toMeetingTypeDTO),
      vocabularyScopes: listVocabularyScopes(ctx),
      general: toGeneralDTO(cfg),
      performance: toPerformanceDTO(cfg),
      sources: toSourcesDTO(ctx),
    };
  });

  ipcMain.handle(Channels.SettingsSaveOutputs, (_evt, payload: unknown) => {
    // Per-section save (DECISIONS.md §3): payload is the OutputsDTO slice
    // directly, not wrapped in { outputs }. Keeps the channel name and
    // the payload shape honest about what this call is doing.
    const outputs = assertOutputsDTO(payload);

    // Sanity checks: if a file destination is enabled, its directory must
    // be non-empty. Apple Notes needs a non-empty parent folder name.
    if (outputs.markdown.enabled && !outputs.markdown.dir.trim()) {
      throw new Error('Markdown output is enabled but no folder is set.');
    }
    if (outputs.html.enabled && !outputs.html.dir.trim()) {
      throw new Error('HTML output is enabled but no folder is set.');
    }
    if (outputs.appleNotes.enabled && !outputs.appleNotes.parentFolder.trim()) {
      throw new Error('Apple Notes output is enabled but no folder name is set.');
    }
    if (
      !outputs.markdown.enabled &&
      !outputs.html.enabled &&
      !outputs.appleNotes.enabled
    ) {
      throw new Error('At least one output destination must be enabled.');
    }

    const updated = ctx.applyConfigUpdate({ outputs });
    saveConfig(updated);
    ctx.logger.info({ outputs: updated.outputs }, 'outputs settings saved');
  });

  ipcMain.handle(Channels.SettingsSavePrompt, (_evt, payload: unknown): MeetingTypeDTO => {
    const p = assertSavePromptPayload(payload);
    const prompt = p.prompt.trim();
    if (prompt.length === 0) throw new Error('Prompt cannot be empty.');

    const existing = ctx.state.getMeetingType(p.id);
    if (!existing) throw new Error(`No such meeting type: ${p.id}`);

    // Name changes are optional; only apply if provided and non-empty.
    const patch: { name?: string; prompt: string } = { prompt };
    if (p.name !== undefined) {
      const newName = p.name.trim();
      if (newName.length === 0) throw new Error('Name cannot be empty.');
      // Guard against colliding with another type's name.
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

  ipcMain.handle(
    Channels.SettingsRevertPromptToBuiltin,
    (_evt, id: unknown): MeetingTypeDTO => {
      if (typeof id !== 'string') throw new Error('id must be a string');
      const existing = ctx.state.getMeetingType(id);
      if (!existing) throw new Error(`No such meeting type: ${id}`);
      if (existing.is_builtin !== 1) {
        throw new Error(
          'Only built-in meeting types have a default to revert to.',
        );
      }

      const seeded = readSeedPrompt(ctx.resourcesDir, id);
      if (seeded === undefined) {
        throw new Error(
          `Could not find a seeded prompt for "${id}" in PROMPTS.md. ` +
            `This usually means the id has drifted between the seed list and ` +
            `PROMPTS.md — check that a "## N. \`${id}\`" heading still exists.`,
        );
      }

      // Use the dedicated revert method, not updateMeetingType: revert
      // also rewrites original_prompt_hash so the "modified from default"
      // badge works correctly after the revert. This matters most for
      // pre-migration-7 installs where the hash column was NULL on every
      // existing row — see BACKLOG "Backfill original_prompt_hash".
      const seededHash = hashPrompt(seeded);
      const changed = ctx.state.revertMeetingTypeToBuiltin(id, seeded, seededHash);
      if (!changed) throw new Error(`Failed to revert meeting type ${id}`);

      ctx.logger.info({ meetingTypeId: id }, 'meeting-type prompt reverted to default');

      // If the seed-time hash existed and disagrees with the just-computed
      // hash, PROMPTS.md has drifted between original seed time and now.
      // That's expected as the contributor edits the source-of-truth file;
      // logging the drift is useful for debugging if something goes wrong,
      // but not an error — revert always restores to whatever PROMPTS.md
      // currently contains.
      if (
        existing.original_prompt_hash !== null &&
        existing.original_prompt_hash !== seededHash
      ) {
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
    },
  );

  ipcMain.handle(
    Channels.SettingsImportPrompts,
    async (): Promise<
      | { created: number; updated: number; prompts: MeetingTypeDTO[] }
      | null
    > => {
      // Step 1: native file picker. Markdown only. Same shape as the
      // PROMPTS.md parser expects (## N. `id` — Display Name + fenced
      // code block per section).
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
      const sourcePath = result.filePaths[0]!;

      // Step 2: read + parse. Errors here surface as inline error
      // text in the Prompts editor.
      let raw: string;
      try {
        raw = readFileSync(sourcePath, 'utf-8');
      } catch (e) {
        throw new Error(
          `Could not read "${sourcePath}": ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      const parsed = parsePromptsMarkdownDetailed(raw);
      if (parsed.length === 0) {
        throw new Error(
          `No prompts found in "${sourcePath}". The file should have ` +
            `headings like "## 1. \`my-id\` — My Display Name" with a ` +
            `fenced code block underneath each heading.`,
        );
      }

      // Step 3: upsert each parsed entry. Existing rows (matched by
      // id) get their prompt and name updated; new rows are
      // inserted as user-created (is_builtin=0). We deliberately
      // don't touch original_prompt_hash on update — the import is
      // a user action, not a seed, so a built-in's modified-from-
      // default badge will (correctly) fire after import if the
      // imported text differs from the seed.
      let created = 0;
      let updated = 0;
      for (const entry of parsed) {
        const trimmedPrompt = entry.prompt.trim();
        if (trimmedPrompt.length === 0) continue;

        const existing = ctx.state.getMeetingType(entry.id);
        if (existing) {
          // Update existing row. Use updateMeetingType so updated_at
          // bumps but is_builtin / sort_order / original_prompt_hash
          // stay as they are.
          //
          // We update the name too if the imported one differs — a
          // contributor importing fresh prompts probably wants the
          // file's display names to win. Skip if the imported name
          // would collide with a different existing row's name
          // (rare but possible if two parsed entries have the same
          // display name), preserving the existing name in that case.
          const namePatch =
            entry.name && entry.name !== existing.name
              ? (() => {
                  const clash = ctx.state
                    .listMeetingTypes()
                    .find(
                      (m) =>
                        m.id !== entry.id &&
                        m.name.toLowerCase() === entry.name.toLowerCase(),
                    );
                  return clash ? undefined : entry.name;
                })()
              : undefined;
          ctx.state.updateMeetingType(entry.id, {
            ...(namePatch !== undefined ? { name: namePatch } : {}),
            prompt: trimmedPrompt,
          });
          updated++;
        } else {
          // Insert new user-created row. Disambiguate the display
          // name if it collides with an existing row by appending
          // " (imported)" — keeps both rows distinguishable in the
          // sidebar without throwing.
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
        {
          sourcePath,
          parsedCount: parsed.length,
          created,
          updated,
        },
        'prompts imported from markdown',
      );

      // Return the full updated meeting types list so the renderer
      // refreshes its sidebar without a separate load round-trip.
      const prompts = ctx.state.listMeetingTypes().map(toMeetingTypeDTO);
      return { created, updated, prompts };
    },
  );

  ipcMain.handle(
    Channels.SettingsLoadVocabulary,
    (_evt, scopeId: unknown): VocabularyFileDTO => {
      if (typeof scopeId !== 'string') throw new Error('scopeId must be a string');
      assertScopeIdExists(ctx, scopeId);
      const file = readVocabularyFile(vocabularyDirFor(ctx), scopeId);
      return toVocabularyFileDTO(file);
    },
  );

  ipcMain.handle(
    Channels.SettingsSaveVocabulary,
    (_evt, payload: unknown): VocabularyScopeSummaryDTO => {
      const p = assertSaveVocabularyPayload(payload);
      assertScopeIdExists(ctx, p.scopeId);

      // Project the DTO onto the on-disk shape. We preserve the
      // $description / $version / notes metadata from the existing
      // file on disk (if any) so the human-authored preamble isn't
      // lost when the app re-saves. Only whisperHints, replacements,
      // and notes come from the renderer.
      const existing = readVocabularyFile(vocabularyDirFor(ctx), p.scopeId);
      const next: VocabularyFile = {
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
      writeVocabularyFile(vocabularyDirFor(ctx), p.scopeId, next);
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
    },
  );

  ipcMain.handle(
    Channels.SettingsImportVocabulary,
    async (_evt, scopeId: unknown): Promise<VocabularyFileDTO | null> => {
      if (typeof scopeId !== 'string') throw new Error('scopeId must be a string');
      assertScopeIdExists(ctx, scopeId);

      // Step 1: native file picker. Accepts JSON or markdown. The
      // chosen file's extension routes to the right parser:
      //   - .json     → full vocabulary file (hints + replacements + notes)
      //   - .md / .markdown → "Heard as / Should be / Context cue"
      //                       tables, replacement rules only
      // Single-select — the merge contract is per-scope, and merging
      // multiple files into one scope in a single click would hide
      // which file contributed what on conflict. Sequential imports
      // achieve the same thing with clearer attribution.
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
      const sourcePath = result.filePaths[0]!;

      // Step 2: read the file as text. The two parsers below disagree
      // on what to do with the bytes, but neither needs binary.
      let raw: string;
      try {
        raw = readFileSync(sourcePath, 'utf-8');
      } catch (e) {
        throw new Error(
          `Could not read "${sourcePath}": ${
            e instanceof Error ? e.message : String(e)
          }`,
        );
      }

      // Step 3: parse + validate. Branch on extension; reject
      // anything else with a clear error.
      //
      // We extract a normalised "whisperHints / replacements / notes"
      // shape regardless of which parser ran, so the merge step below
      // doesn't care about the source format.
      const lowerPath = sourcePath.toLowerCase();
      let importedHints: string[] = [];
      let importedReplacements: VocabularyReplacementDTO[] = [];
      let importedNotes: string[] | undefined;
      let sourceFormat: 'json' | 'markdown';

      if (lowerPath.endsWith('.json')) {
        sourceFormat = 'json';
        let parsedJson: unknown;
        try {
          parsedJson = JSON.parse(raw);
        } catch (e) {
          throw new Error(
            `Could not parse "${sourcePath}" as JSON: ${
              e instanceof Error ? e.message : String(e)
            }`,
          );
        }
        // Validate against the same shape rules as the regular save
        // path. We deliberately don't accept any looser format — if
        // a user pastes JSON from somewhere else it has to follow
        // the documented schema.
        const validated = assertSaveVocabularyPayload({
          scopeId,
          file: parsedJson,
        });
        importedHints = validated.file.whisperHints;
        importedReplacements = validated.file.replacements;
        importedNotes = validated.file.notes;
      } else if (
        lowerPath.endsWith('.md') ||
        lowerPath.endsWith('.markdown')
      ) {
        sourceFormat = 'markdown';
        const tableRows = parseVocabularyMarkdownTables(raw);
        if (tableRows.length === 0) {
          throw new Error(
            `No vocabulary entries found in "${sourcePath}". The file ` +
              `should contain one or more markdown tables with the ` +
              `columns "Heard as", "Should be", and (optionally) ` +
              `"Context cue".`,
          );
        }
        // Markdown tables only express replacements. Hints and notes
        // come through as empty.
        importedReplacements = tableRows.map((r) => ({
          from: r.from,
          to: r.to,
          ...(r.requiresContext && r.requiresContext.length > 0
            ? { requiresContext: r.requiresContext }
            : {}),
        }));
      } else {
        throw new Error(
          `Unsupported file type: "${sourcePath}". Pick a .json ` +
            `vocabulary file or a .md / .markdown file with ` +
            `"Heard as / Should be / Context cue" tables.`,
        );
      }

      // Step 4: merge with existing on-disk content. Import-wins on
      // conflict (the chosen merge strategy):
      //   - Hints: union, case-insensitive dedup, imports appended.
      //   - Replacements: dedupe by `from` (case-insensitive); when
      //     the same `from` exists in both, the imported version
      //     replaces existing.
      //   - Notes: union, exact-match dedup, imports appended.
      const existing = readVocabularyFile(vocabularyDirFor(ctx), scopeId);

      const mergedHints = mergeHints(
        existing.whisperHints ?? [],
        importedHints,
      );
      const mergedReplacements = mergeReplacements(
        existing.replacements ?? [],
        importedReplacements,
      );
      const mergedNotes = mergeNotes(existing.notes, importedNotes);

      const next: VocabularyFile = {
        $description: existing.$description,
        $version: existing.$version ?? 1,
        whisperHints: mergedHints,
        replacements: mergedReplacements,
        ...(mergedNotes && mergedNotes.length > 0
          ? { notes: mergedNotes }
          : {}),
      };
      writeVocabularyFile(vocabularyDirFor(ctx), scopeId, next);

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

      // Return the merged file (as a DTO) so the renderer's editor
      // refreshes without a separate loadVocabulary round-trip.
      return toVocabularyFileDTO(next);
    },
  );

  ipcMain.handle(
    Channels.SettingsExportVocabulary,
    async (_evt, scopeId: unknown): Promise<{ path: string } | null> => {
      if (typeof scopeId !== 'string') throw new Error('scopeId must be a string');
      assertScopeIdExists(ctx, scopeId);

      // Load the on-disk file. We read fresh rather than asking the
      // renderer for its current draft, because export is meant to
      // capture what's persisted — if the user has unsaved edits
      // they expect to lose them on tab-switch anyway, and a save
      // dialog that exports unsaved changes would be confusing.
      const file = readVocabularyFile(vocabularyDirFor(ctx), scopeId);

      // Suggest a sensible default filename. The native save dialog
      // will let the user override this, but a meaningful default
      // saves them typing.
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

      // Serialise with the same shape and indentation conventions as
      // the on-disk file. Trailing newline matches what
      // writeVocabularyFile produces.
      const serialised = JSON.stringify(file, null, 2) + '\n';
      try {
        writeFileSync(result.filePath, serialised, 'utf-8');
      } catch (e) {
        throw new Error(
          `Could not write to "${result.filePath}": ${
            e instanceof Error ? e.message : String(e)
          }`,
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
    },
  );

  ipcMain.handle(Channels.SettingsSaveGeneral, (_evt, payload: unknown) => {
    // Per-section save (DECISIONS.md §3). Tri-state semantics for
    // audioRetentionDays are pinned in the GeneralDTO doc and matched
    // by normaliseConfig on read. We accept null / 0 / positive
    // integer here and reject anything else with a clear message;
    // the renderer's number input + helper text should make these
    // limits visible.
    const general = assertGeneralDTO(payload);
    const updated = ctx.applyConfigUpdate({
      audioRetentionDays: general.audioRetentionDays,
    });
    saveConfig(updated);
    ctx.logger.info(
      { audioRetentionDays: updated.audioRetentionDays },
      'general settings saved',
    );
  });

  ipcMain.handle(Channels.SettingsSavePerformance, (_evt, payload: unknown) => {
    const perf = assertPerformanceDTO(payload);
    // Models aren't pre-flighted at save time — the user is allowed
    // to point at a not-yet-pulled Ollama model and pull it from a
    // terminal afterwards. The pipeline raises a clean error at
    // summarise time if the model is missing. See `preflightMessage`.
    const cfg = ctx.getConfig();
    const updated = ctx.applyConfigUpdate({
      ollama: {
        ...cfg.ollama,
        model: perf.ollamaModel,
        keepAlive: perf.ollamaKeepAlive,
      },
      whisperModel: perf.whisperModel,
    });
    saveConfig(updated);
    ctx.logger.info(
      {
        ollamaModel: updated.ollama.model,
        ollamaKeepAlive: updated.ollama.keepAlive,
        whisperModel: updated.whisperModel,
      },
      'performance settings saved',
    );
  });

  ipcMain.handle(
    Channels.SettingsListOllamaModels,
    async (): Promise<OllamaModelsResult> => {
      const cfg = ctx.getConfig();
      const client = new OllamaClient(cfg.ollama.host);
      const result = await client.listTags();
      if (!result.ok) {
        return { ok: false, reason: 'unreachable', detail: result.detail };
      }
      const models: OllamaModelDTO[] = result.models.map((m) => ({
        name: m.name,
        sizeBytes: m.size,
      }));
      return { ok: true, models };
    },
  );

  ipcMain.handle(Channels.SettingsBrowseFolder, async (_evt, currentPath: unknown) => {
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

  // --- sources -----------------------------------------------------------

  ipcMain.handle(
    Channels.SourcesPlaudSignIn,
    async (_evt, payload: unknown): Promise<PlaudAccountStatus> => {
      const p = assertPlaudSignInPayload(payload);
      const store = ctx.getPlaudStore();
      if (!store) {
        throw new Error(
          'Credential storage is not available. Restart the app and try again.',
        );
      }
      // signInPlaud writes credentials to Keychain, then performs a live
      // login() call that throws on bad creds or network errors. We let
      // that error surface so the UI can show it inline.
      try {
        await signInPlaud(store, {
          email: p.email,
          password: p.password,
          region: p.region,
        });
      } catch (e) {
        const msg = e instanceof Error ? e.message : String(e);
        ctx.logger.warn({ err: msg, email: p.email }, 'Plaud sign-in failed');
        // Roll back the partial credential write so a failed sign-in
        // doesn't leave half-state in Keychain. The store's clear is
        // best-effort; if it also fails the user can sign out from
        // the UI explicitly.
        try {
          await store.clearCredentialsAsync();
        } catch {
          // ignore
        }
        throw new Error(`Sign in failed: ${msg}`);
      }
      ctx.logger.info({ email: p.email, region: p.region }, 'Plaud sign-in successful');
      ctx.onPlaudCredentialsChanged?.();
      return getPlaudAccountStatus(store);
    },
  );

  ipcMain.handle(Channels.SourcesPlaudSignOut, async () => {
    const store = ctx.getPlaudStore();
    if (!store) return;
    await signOutPlaud(store);
    ctx.logger.info('Plaud signed out');
    ctx.onPlaudCredentialsChanged?.();
  });

  ipcMain.handle(Channels.SourcesPlaudStatus, (): PlaudAccountStatus => {
    const store = ctx.getPlaudStore();
    if (!store) return { signedIn: false };
    return getPlaudAccountStatus(store);
  });

  // --- app-level windows -------------------------------------------------

  ipcMain.handle(Channels.AppOpenSettings, (_evt, opts: unknown) => {
    // Optional payload: { tab?: SettingsTab }. Validate the tab against
    // the union here; an unknown tab is treated as no-tab rather than
    // an error since the worst that happens is the renderer falls back
    // to its default tab.
    const validTabs = new Set<string>([
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
      const o = opts as Record<string, unknown>;
      if (typeof o.tab === 'string' && validTabs.has(o.tab)) {
        initialTab = o.tab;
      }
    }
    openSettings(initialTab ? { initialTab } : undefined);
  });

  ipcMain.handle(Channels.AppGetTipJarStatus, (): TipJarStatusDTO => {
    // The DTO and the main-side TipJarStatus shape are structurally
    // identical, so a direct return is type-safe. Both interfaces
    // are duplicated rather than shared because the renderer can't
    // reach into main/tipJar.ts; see the DTO docstring in the
    // contract for the rationale.
    return readTipJarStatus(ctx.state);
  });

  ipcMain.handle(Channels.AppDismissTipJarBanner, (): void => {
    dismissTipJarBanner(ctx.state);
    ctx.logger.info('tip-jar banner dismissed');
    // No state-changed callback fires here — the inbox renderer hides
    // the banner locally on click, and getTipJarStatus on the next
    // open will reflect the dismissed state. Avoiding the broadcast
    // keeps the dismiss action quiet (no tray refresh, no inbox
    // re-render) which matches its low-stakes UX.
  });

  ipcMain.handle(Channels.AppOpenTipJar, async (): Promise<void> => {
    // shell.openExternal returns void on success; rejects on a launch
    // failure (very rare, e.g. no browser registered). We log + swallow
    // because there's nothing the renderer can usefully do with the
    // failure — the user will notice the browser didn't open.
    try {
      await shell.openExternal(TIP_JAR_URL);
      ctx.logger.info({ url: TIP_JAR_URL }, 'tip-jar URL opened');
    } catch (e) {
      ctx.logger.warn(
        { err: String(e), url: TIP_JAR_URL },
        'failed to open tip-jar URL',
      );
    }
  });

  // --- setup (first-launch venv install) --------------------------------

  ipcMain.handle(Channels.SetupGetStatus, (): SetupInitialStatus => {
    // Re-detect at call time rather than caching from the bootstrap
    // decision — this lets a Retry-after-quit-and-restart see fresh
    // state. Cheap (~50ms of spawnSync calls).
    const venvStatus = detectVenv();
    const systemPython = detectSystemPython();

    if (systemPython.kind === 'not-found') {
      return {
        kind: 'python-missing',
        triedPaths: systemPython.triedPaths,
      };
    }

    return {
      kind: 'needs-setup',
      systemPython: systemPython.path,
      systemPythonVersion: systemPython.version,
      reason: describeVenvStatus(venvStatus),
    };
  });

  ipcMain.handle(
    Channels.SetupStart,
    async (): Promise<
      | { kind: 'success' }
      | { kind: 'failed'; phase: SetupPhase; message: string }
      | { kind: 'cancelled' }
    > => {
      const systemPython = detectSystemPython();
      if (systemPython.kind !== 'found') {
        // Should be impossible — the renderer only invokes start()
        // when getStatus() returned 'needs-setup' which requires
        // systemPython.kind === 'found'. If it happens anyway,
        // surface it cleanly rather than crashing the handler.
        return {
          kind: 'failed',
          phase: 'creating-venv',
          message:
            'Python 3.11 was found at startup but is no longer reachable. ' +
            'Please re-launch distill.',
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
            broadcastSetupProgress({
              kind: 'log',
              phase: event.phase,
              log: event.log,
            });
          } else {
            broadcastSetupProgress({ kind: 'phase', phase: event.phase });
          }
        },
      });

      if (result.kind === 'success') {
        ctx.logger.info(
          { pythonPath: result.pythonPath },
          'venv install succeeded',
        );
        broadcastSetupProgress({ kind: 'done' });
        // Tell index.ts that setup finished so the rest of the app
        // can come up. The setup window stays open just long enough
        // for the renderer to show "Done" before closing itself.
        ctx.onSetupComplete?.();
        return { kind: 'success' };
      }

      if (result.kind === 'failed') {
        ctx.logger.warn(
          { phase: result.phase, message: result.message },
          'venv install failed',
        );
        broadcastSetupProgress({
          kind: 'failed',
          failure: { phase: result.phase, message: result.message },
        });
        return result;
      }

      // Cancelled (no-op for now — we don't expose Cancel during
      // install in the UI yet, but the contract supports it).
      ctx.logger.info('venv install cancelled');
      return { kind: 'cancelled' };
    },
  );

  ipcMain.handle(Channels.SetupQuit, (): void => {
    ctx.logger.info('user quit from setup window');
    app.quit();
  });
}

// ---------------------------------------------------------------------------
// Push channels
// ---------------------------------------------------------------------------

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

/**
 * Broadcast a local-import progress event to every open BrowserWindow.
 * The inbox renderer matches the event to its queue row by
 * `sourcePath`. Other windows ignore it. Pushed at most ~5 times per
 * second per active import (throttled in the import code itself).
 */
export function broadcastLocalImportProgress(p: {
  sourcePath: string;
  phase: 'probe' | 'copy' | 'extract' | 'finalise';
  percent: number | null;
}): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed()) win.webContents.send(Channels.PushLocalImportProgress, p);
  }
}

/**
 * Broadcast a setup-window progress event. Only the setup window
 * subscribes via `onSetupProgress`; other windows ignore the
 * channel name.
 */
export function broadcastSetupProgress(event: SetupProgressEvent): void {
  for (const win of BrowserWindow.getAllWindows()) {
    if (!win.isDestroyed())
      win.webContents.send(Channels.PushSetupProgress, event);
  }
}

/**
 * Convert a VenvStatus into a one-line human-readable reason
 * shown under the heading on the setup window. Used only for the
 * 'needs-setup' branch (the others have their own dedicated
 * messages).
 */
function describeVenvStatus(status: VenvStatus): string {
  switch (status.kind) {
    case 'ready':
      // Defensive — we only call this on the needs-setup branch.
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

// ---------------------------------------------------------------------------
// DTO mappers
// ---------------------------------------------------------------------------

function toInboxDTO(r: JoinedRecordingRow): InboxRecordingDTO {
  return {
    id: r.id,
    filename: r.filename,
    duration_seconds: r.duration_seconds,
    start_time: r.start_time,
    synced_at: r.synced_at,
    status: r.status,
    currentStep: statusToStep(r.status),
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

function toClientDTO(r: {
  id: string;
  name: string;
  is_builtin: 0 | 1;
  sort_order: number;
}): ClientDTO {
  return {
    id: r.id,
    name: r.name,
    is_builtin: r.is_builtin === 1,
    sort_order: r.sort_order,
  };
}

function toMeetingTypeDTO(r: MeetingTypeRow): MeetingTypeDTO {
  // `is_modified` is only meaningful for built-ins — user-created types
  // have no seed default to differ from, so they always read false.
  const isBuiltin = r.is_builtin === 1;
  const is_modified =
    isBuiltin &&
    r.original_prompt_hash !== null &&
    hashPrompt(r.prompt) !== r.original_prompt_hash;

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

function toGeneralDTO(cfg: AppConfig): GeneralDTO {
  return { audioRetentionDays: cfg.audioRetentionDays };
}

function toPerformanceDTO(cfg: AppConfig): PerformanceDTO {
  return {
    ollamaModel: cfg.ollama.model,
    ollamaKeepAlive: cfg.ollama.keepAlive,
    whisperModel: cfg.whisperModel,
  };
}

function toSourcesDTO(ctx: IpcContext): SourcesDTO {
  const store = ctx.getPlaudStore();
  return {
    plaud: store ? getPlaudAccountStatus(store) : { signedIn: false },
  };
}

// ---------------------------------------------------------------------------
// Vocabulary helpers
// ---------------------------------------------------------------------------

/**
 * Absolute path to the user-writable vocabulary directory under
 * appSupportDir. After the first-launch migration in index.ts
 * (`migrateVocabularyToUserDir`) this directory is populated; before
 * that it may not exist yet, but `readVocabularyFile` returns an
 * empty-shape file in that case so the UI still renders sanely.
 *
 * Earlier shapes computed `<bundledResourcesDir>/vocabulary` here
 * which is read-only inside the .app bundle on packaged installs and
 * gets blown away on every reinstall. Per BACKLOG "Settings editor
 * in packaged builds".
 */
function vocabularyDirFor(_ctx: IpcContext): string {
  return userVocabularyDir();
}

/**
 * Built-in scope labels (hard-coded; the files themselves have
 * `$description` fields but those are prose, not short labels).
 */
const BUILTIN_SCOPE_LABELS: Record<string, string> = {
  global: 'Global',
  organisation: 'Organisation',
  industry: 'Industry',
};

/**
 * Compose the list of every vocabulary scope visible to the Settings
 * pane: three built-ins + one per client. Order: built-ins first
 * (stable), then clients by their sort_order (matching the rest of
 * the app).
 */
function listVocabularyScopes(ctx: IpcContext): VocabularyScopeSummaryDTO[] {
  const dir = vocabularyDirFor(ctx);
  const scopes: VocabularyScopeSummaryDTO[] = [];

  for (const id of BUILTIN_SCOPE_IDS) {
    scopes.push(scopeSummary(ctx, id, readVocabularyFile(dir, id)));
  }

  for (const client of ctx.state.listClients()) {
    // Skip if a client id collides with a built-in name — extremely
    // unlikely in practice but the built-in wins because it's global.
    if (isBuiltinScopeId(client.id)) continue;
    scopes.push(scopeSummary(ctx, client.id, readVocabularyFile(dir, client.id)));
  }

  return scopes;
}

/**
 * Build a summary for a single scope. Split from listVocabularyScopes
 * so the save handler can return the updated summary without
 * re-listing every scope.
 */
function scopeSummary(
  ctx: IpcContext,
  scopeId: string,
  file: VocabularyFile,
): VocabularyScopeSummaryDTO {
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

/**
 * Confirm that a scope id refers to either a built-in pack or an
 * existing client. Rejects unknown ids at the IPC boundary so
 * renderer bugs or bad payloads can't trigger arbitrary file
 * reads/writes under resources/vocabulary/.
 */
function assertScopeIdExists(ctx: IpcContext, scopeId: string): void {
  if (isBuiltinScopeId(scopeId)) return;
  const client = ctx.state.getClient(scopeId);
  if (!client) {
    throw new Error(
      `Unknown vocabulary scope: "${scopeId}". ` +
        `Must be one of: ${BUILTIN_SCOPE_IDS.join(', ')}, or a client id.`,
    );
  }
}

function toVocabularyFileDTO(file: VocabularyFile): VocabularyFileDTO {
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

// ---------------------------------------------------------------------------
// Vocabulary merge helpers (used by the import-vocabulary IPC handler)
//
// Import-wins on conflicts (the chosen merge strategy). Three sub-cases:
//
//   - Hints: case-insensitive dedup. Same hint imported twice doesn't
//     duplicate. Hints already in the scope keep their existing
//     position; new imports get appended.
//
//   - Replacements: dedupe by `from` (case-insensitive). When the
//     same `from` exists in both, the imported `to` and
//     `requiresContext` win. Imported entries with new `from`
//     values get appended.
//
//   - Notes: exact-match dedup. Imported notes appended.
//
// All three helpers are pure data manipulation — no I/O, no logging.
// They take and return plain arrays so they're easy to unit-test if
// we add coverage for them later.
// ---------------------------------------------------------------------------

function mergeHints(
  existing: readonly string[],
  imported: readonly string[],
): string[] {
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
  existing: readonly { from: string; to: string; requiresContext?: string[] }[],
  imported: readonly VocabularyReplacementDTO[],
): { from: string; to: string; requiresContext?: string[] }[] {
  // Build a lookup of imported entries keyed by lowercase `from`.
  // Then walk existing first, replacing any whose key is in the
  // imported map (and removing them from the map as we go), then
  // append the remaining imported entries that didn't conflict.
  const importedByKey = new Map<string, VocabularyReplacementDTO>();
  for (const r of imported) {
    importedByKey.set(r.from.toLowerCase(), r);
  }

  const out: { from: string; to: string; requiresContext?: string[] }[] = [];
  for (const r of existing) {
    const key = r.from.toLowerCase();
    const fromImport = importedByKey.get(key);
    if (fromImport) {
      // Conflict: import wins. Use the imported entry's full shape.
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
  // Append any imports that didn't conflict, preserving order.
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

function mergeNotes(
  existing: readonly string[] | undefined,
  imported: readonly string[] | undefined,
): string[] | undefined {
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

// ---------------------------------------------------------------------------
// Payload validation
// ---------------------------------------------------------------------------

function assertTagSavePayload(v: unknown): TagSavePayload {
  if (!v || typeof v !== 'object') throw new Error('Invalid tag payload');
  const o = v as Record<string, unknown>;
  if (typeof o.recordingId !== 'string') throw new Error('recordingId must be a string');
  if (typeof o.clientId !== 'string') throw new Error('clientId must be a string');
  if (typeof o.meetingTypeId !== 'string') throw new Error('meetingTypeId must be a string');
  return { recordingId: o.recordingId, clientId: o.clientId, meetingTypeId: o.meetingTypeId };
}

function assertAddClientPayload(v: unknown): AddClientPayload {
  if (!v || typeof v !== 'object') throw new Error('Invalid client payload');
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new Error('name must be a string');
  return { name: o.name };
}

function assertAddMeetingTypePayload(v: unknown): AddMeetingTypePayload {
  if (!v || typeof v !== 'object') throw new Error('Invalid meeting-type payload');
  const o = v as Record<string, unknown>;
  if (typeof o.name !== 'string') throw new Error('name must be a string');
  if (typeof o.prompt !== 'string') throw new Error('prompt must be a string');
  return { name: o.name, prompt: o.prompt };
}

function assertSavePromptPayload(v: unknown): SavePromptPayload {
  if (!v || typeof v !== 'object') throw new Error('Invalid prompt payload');
  const o = v as Record<string, unknown>;
  if (typeof o.id !== 'string') throw new Error('id must be a string');
  if (typeof o.prompt !== 'string') throw new Error('prompt must be a string');
  if (o.name !== undefined && typeof o.name !== 'string') {
    throw new Error('name must be a string when provided');
  }
  return {
    id: o.id,
    prompt: o.prompt,
    name: o.name as string | undefined,
  };
}

function assertSaveVocabularyPayload(v: unknown): SaveVocabularyPayload {
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
    if (trimmed.length === 0) continue; // silently drop empty rows from the UI
    hints.push(trimmed);
  }

  if (!Array.isArray(f.replacements)) {
    throw new Error('file.replacements must be an array');
  }
  const replacements: VocabularyReplacementDTO[] = [];
  for (let i = 0; i < f.replacements.length; i++) {
    const rRaw = f.replacements[i];
    if (!rRaw || typeof rRaw !== 'object') {
      throw new Error(`file.replacements[${i}] must be an object`);
    }
    const r = rRaw as Record<string, unknown>;
    if (typeof r.from !== 'string' || typeof r.to !== 'string') {
      throw new Error(
        `file.replacements[${i}]: "from" and "to" must both be strings`,
      );
    }
    const fromTrim = r.from.trim();
    const toTrim = r.to.trim();
    // A row with both fields empty is a blank the user never filled
    // in — drop silently rather than reject, same logic as hints.
    if (fromTrim.length === 0 && toTrim.length === 0) continue;
    if (fromTrim.length === 0) {
      throw new Error(
        `file.replacements[${i}]: "from" is empty. Either fill it in or delete the row.`,
      );
    }
    if (toTrim.length === 0) {
      throw new Error(
        `file.replacements[${i}] (from="${fromTrim}"): "to" is empty.`,
      );
    }
    let requiresContext: string[] | undefined;
    if (r.requiresContext !== undefined) {
      if (!Array.isArray(r.requiresContext)) {
        throw new Error(
          `file.replacements[${i}] (from="${fromTrim}"): requiresContext must be an array`,
        );
      }
      const ctx = r.requiresContext
        .map((c, j) => {
          if (typeof c !== 'string') {
            throw new Error(
              `file.replacements[${i}].requiresContext[${j}] must be a string`,
            );
          }
          return c.trim();
        })
        .filter((c) => c.length > 0);
      if (ctx.length > 0) requiresContext = ctx;
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
    notes = f.notes.map((n, i) => {
      if (typeof n !== 'string') {
        throw new Error(`file.notes[${i}] must be a string`);
      }
      return n;
    });
  }

  return {
    scopeId: o.scopeId,
    file: {
      whisperHints: hints,
      replacements,
      ...(notes ? { notes } : {}),
    },
  };
}

function assertOutputsDTO(v: unknown): OutputsDTO {
  if (!v || typeof v !== 'object') throw new Error('Invalid outputs payload');
  const o = v as Record<string, unknown>;

  const md = o.markdown as Record<string, unknown> | undefined;
  const html = o.html as Record<string, unknown> | undefined;
  const notes = o.appleNotes as Record<string, unknown> | undefined;
  if (
    !md ||
    typeof md.enabled !== 'boolean' ||
    typeof md.dir !== 'string' ||
    typeof md.includeTranscript !== 'boolean'
  ) {
    throw new Error('outputs.markdown is malformed');
  }
  if (
    !html ||
    typeof html.enabled !== 'boolean' ||
    typeof html.dir !== 'string' ||
    typeof html.includeTranscript !== 'boolean'
  ) {
    throw new Error('outputs.html is malformed');
  }
  if (
    !notes ||
    typeof notes.enabled !== 'boolean' ||
    typeof notes.parentFolder !== 'string' ||
    typeof notes.includeTranscript !== 'boolean'
  ) {
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

/**
 * Validate a SaveGeneralPayload (which is structurally GeneralDTO).
 * Tri-state contract for audioRetentionDays: null, 0, or positive
 * integer. We reject anything else here so a malformed renderer
 * payload can't end up at rest in config.json. NaN, negative, and
 * non-integer all throw with a clear message rather than silently
 * coercing to null — normaliseConfig is lenient on hand-edited config,
 * but a save through the UI should be exact.
 */
function assertGeneralDTO(v: unknown): GeneralDTO {
  if (!v || typeof v !== 'object') throw new Error('Invalid general payload');
  const o = v as Record<string, unknown>;
  const raw = o.audioRetentionDays;
  if (raw === null) return { audioRetentionDays: null };
  if (typeof raw !== 'number' || !Number.isFinite(raw)) {
    throw new Error('audioRetentionDays must be null or a non-negative integer');
  }
  if (!Number.isInteger(raw)) {
    throw new Error('audioRetentionDays must be a whole number of days');
  }
  if (raw < 0) {
    throw new Error('audioRetentionDays must be ≥ 0 (use null to disable the sweep)');
  }
  return { audioRetentionDays: raw };
}

/**
 * Validate a SavePerformancePayload. Whisper model and keepAlive
 * are checked against the curated dropdown lists — mistyping a
 * Whisper id is a silent failure mode (the python script downloads
 * whatever you tell it to), so we don't accept anything outside
 * the curated list. Ollama model is free text because it's a real
 * picker populated from /api/tags at runtime; we just require it
 * non-empty.
 */
function assertPerformanceDTO(v: unknown): PerformanceDTO {
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
  if (!allowedKeepAlive.includes(keepAlive)) {
    throw new Error(
      `ollamaKeepAlive must be one of: ${allowedKeepAlive.join(', ')}`,
    );
  }
  if (typeof o.whisperModel !== 'string') {
    throw new Error('whisperModel must be a string');
  }
  const whisperModel = o.whisperModel.trim();
  const allowedWhisper = WHISPER_MODEL_PRESETS.map((p) => p.value);
  if (!allowedWhisper.includes(whisperModel)) {
    throw new Error(
      `whisperModel must be one of the curated MLX models: ${allowedWhisper.join(', ')}`,
    );
  }
  return {
    ollamaModel,
    ollamaKeepAlive: keepAlive,
    whisperModel,
  };
}

/**
 * Validate a PlaudSignInPayload. Email and password are user-provided
 * strings; we trim email but never trim password (passwords with
 * leading/trailing whitespace are user error but not ours to silently
 * fix). Region must be 'us' or 'eu' — the only two values @plaud/core
 * understands.
 */
function assertPlaudSignInPayload(v: unknown): PlaudSignInPayload {
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

import {
  maxVisualNovelSubjectQueryLength,
  type Instance,
  type VisualNovelSubjectMatch,
} from '@rezics/launcher-contract';
import { visualNovelInstallationKey, type Launcher } from '@rezics/launcher-core';
import { realpath } from 'node:fs/promises';
import { basename, dirname, extname, isAbsolute, relative, resolve } from 'node:path';
import type { VisualNovelBatchResult } from '../../shared/desktop';
import { automationError, type PluginAutomationHandlers } from '../automation-types';
import { optionalText, record, text, visualNovelSettingsPatch, visualNovelSettingsReview } from '../rpc-values';

function batchRequest(value: unknown, message: string) {
  const { base: folder, batch } = record(value);
  const base = text(folder, 32_767);
  if (!isAbsolute(base) || !Array.isArray(batch)) throw new Error(message);
  return { base, batch };
}

export const visualNovelCommands = {
  'search-vn': {
    run: async (core, query, signal) => ({
      value: await core.searchVisualNovelSubjects(text(query, maxVisualNovelSubjectQueryLength), signal),
    }),
  },
  'search-vn-batch': {
    async run(core, argument, signal) {
      if (!Array.isArray(argument) || argument.length > 100) {
        throw new Error('Supply a JSON array of up to 100 visual novel queries.');
      }
      const value = await searchVisualNovelBatch(core, argument, signal);
      return { value, partial: value.some(({ status }) => status === 'error') };
    },
  },
  'discover-vn': {
    async run(core, directory, signal) {
      const value = await core.discoverVisualNovels(text(directory, 32_767), signal);
      return { value, partial: value.errors.length > 0 };
    },
  },
  'inspect-vn': {
    async run(core, argument, signal) {
      const { base, batch } = batchRequest(argument, 'Supply a folder and visual novel installations.');
      const value = await visualNovels(core, batch, base, { signal });
      return { value, partial: value.some(({ status }) => status === 'error') };
    },
  },
  'import-vn': {
    async run(_core, argument, _signal, { importVisualNovels }) {
      const { base, batch } = batchRequest(argument, 'Supply a folder and visual novel installations.');
      const value = await importVisualNovels(batch, base);
      return { value, partial: value.some(({ status }) => status === 'error') };
    },
  },
  'link-vn': {
    async run(core, argument) {
      if (!Array.isArray(argument)) throw new Error('Supply a JSON array of visual novel associations.');
      const value = await linkVisualNovels(core, argument);
      return {
        value,
        partial: value.some(({ status }) => status === 'error' || status === 'conflict'),
        installedChanged: value.some(({ status }) => status === 'changed'),
      };
    },
  },
  'read-vn-settings': {
    async run(core, argument, signal) {
      if (!Array.isArray(argument)) throw new Error('Supply a JSON array of visual novel instance IDs.');
      const value = await visualNovelSettingsBatch(
        argument,
        async (instanceId) => ({
          status: 'ready',
          settings: await core.readVisualNovelSettings(instanceId),
        }),
        signal,
      );
      return { value, partial: value.some(({ status }) => status === 'error') };
    },
  },
  'edit-vn': {
    async run(core, argument) {
      const { base, batch } = batchRequest(argument, 'Supply a folder and visual novel settings edits.');
      const value = await visualNovelSettingsBatch(batch, async (instanceId, input) => {
        const revision = visualNovelSettingsReview(input.revision);
        const patch = visualNovelSettingsPatch(input.patch, (path) => resolve(base, text(path, 32_767)));
        if (patch.subjectId !== undefined) throw new Error('Use link-vn to change REZICS associations.');
        if (!Object.keys(patch).length) throw new Error('Supply at least one visual novel setting to change.');
        return core.editVisualNovelSettings(instanceId, patch, revision);
      });
      return {
        value,
        partial: value.some(({ status }) => status === 'error' || status === 'conflict'),
        installedChanged: value.some(({ status }) => status === 'changed'),
      };
    },
  },
} satisfies PluginAutomationHandlers<'visual-novel'>;

type SearchResult =
  | { status: 'ready'; query: string; matches: VisualNovelSubjectMatch[] }
  | { status: 'error'; query?: string; message: string };

async function searchVisualNovelBatch(core: Launcher, rows: unknown[], signal?: AbortSignal) {
  const pending = rows.entries();
  const lookups = new Map<string, Promise<VisualNovelSubjectMatch[]>>();
  const results: (SearchResult & { index: number })[] = [];

  async function worker() {
    for (const [index, row] of pending) {
      signal?.throwIfAborted();
      let query: string | undefined;
      try {
        query = text(row, maxVisualNovelSubjectQueryLength).trim();
        let lookup = lookups.get(query);
        if (!lookup) {
          lookup = core.searchVisualNovelSubjects(query, signal);
          lookups.set(query, lookup);
        }
        results[index] = { index, status: 'ready', query, matches: await lookup };
      } catch (error) {
        signal?.throwIfAborted();
        results[index] = { index, status: 'error', ...(query && { query }), message: automationError(error) };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(rows.length, 4) }, () => worker()));
  return results;
}

async function visualNovelSettingsBatch<T extends { status: string }>(
  rows: unknown[],
  run: (instanceId: string, row: Record<string, unknown>) => Promise<T>,
  signal?: AbortSignal,
) {
  const results = [];
  for (const [index, row] of rows.entries()) {
    signal?.throwIfAborted();
    let instanceId: string | undefined;
    try {
      const input = record(row);
      instanceId = text(input.instanceId, 120);
      results.push({ index, instanceId, ...(await run(instanceId, input)) });
    } catch (error) {
      results.push({ index, ...(instanceId && { instanceId }), status: 'error', message: automationError(error) });
    }
  }
  return results;
}

async function linkVisualNovels(core: Launcher, edits: unknown[]) {
  const results = [];
  for (const [index, row] of edits.entries()) {
    let instanceId: string | undefined;
    try {
      const input = record(row);
      instanceId = text(input.instanceId, 120);
      const result = await core.setVisualNovelAssociation(instanceId, {
        expectedSubjectId: input.expectedSubjectId === null ? null : text(input.expectedSubjectId, 36),
        subjectId: input.subjectId === null ? null : text(input.subjectId, 36),
      });
      results.push({ index, instanceId, ...result });
    } catch (error) {
      results.push({ index, ...(instanceId && { instanceId }), status: 'error', message: automationError(error) });
    }
  }
  return results;
}

export async function visualNovels(
  core: Launcher,
  batch: unknown[],
  base: string,
  { apply, fromScan, signal }: { apply?: true; fromScan?: true; signal?: AbortSignal | undefined },
): Promise<VisualNovelBatchResult[]> {
  const existing = new Map<string, { instance: Instance; archived?: true }>();
  for (const item of await core.visualNovelInstallations()) {
    existing.set(visualNovelInstallationKey(item.executable, item.workingDirectory), item);
  }
  const results: VisualNovelBatchResult[] = [];
  for (const [index, row] of batch.entries()) {
    signal?.throwIfAborted();
    let source: string | undefined;
    try {
      const input = record(row);
      source = text(input.executable, 32_767);
      const name = optionalText(input.name, 120);
      const folder = optionalText(input.workingDirectory, 32_767);
      const saveFolder = optionalText(input.saveDirectory, 32_767);
      const renpySaveName = optionalText(input.renpySaveName);
      const subjectId = optionalText(input.subjectId, 36);
      const executablePath = resolve(base, source);
      const workingPath = folder && resolve(base, folder);
      const executable = await realpath(executablePath);
      const workingDirectory = workingPath ? await realpath(workingPath) : dirname(executable);
      if (
        fromScan &&
        (relative(executablePath, executable) || !workingPath || relative(workingPath, workingDirectory))
      ) {
        throw new Error('This installation moved after the scan. Scan the folder again.');
      }
      const key = visualNovelInstallationKey(executable, workingDirectory);
      const registration = existing.get(key);
      const instance = registration?.instance;
      const metadata = await core.inspectVisualNovel({ executable, workingDirectory });
      const title =
        name ??
        instance?.name ??
        metadata.title ??
        (basename(workingDirectory) || basename(executable, extname(executable)));
      const settings = {
        executable,
        workingDirectory,
        name: title.slice(0, 120),
        ...(saveFolder && { saveDirectory: resolve(base, saveFolder) }),
        ...(renpySaveName && { renpySaveName }),
        ...(subjectId && { subjectId }),
      };
      if (!apply || instance) {
        results.push({
          index,
          ...settings,
          metadata,
          ...(registration
            ? { status: registration.archived ? 'archived' : 'existing', instance: registration.instance }
            : { status: 'inspected' }),
        });
        continue;
      }
      const imported = await core.importInstance({ ...settings, kind: 'visual-novel' });
      existing.set(key, { instance: imported });
      results.push({ index, ...settings, status: 'imported', instance: imported, metadata });
    } catch (error) {
      results.push({
        index,
        ...(source !== undefined && { executable: source }),
        status: 'error',
        message: automationError(error),
      });
    }
  }
  return results;
}

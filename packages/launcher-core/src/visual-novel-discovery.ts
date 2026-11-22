import type { VisualNovelDiscovery, VisualNovelInstallation } from '@rezics/launcher-contract';
import { constants } from 'node:fs';
import { access, readdir } from 'node:fs/promises';
import { extname, join, relative } from 'node:path';
import { fileInfo } from './storage.ts';
import { hasRenpyBootstrap } from './visual-novel.ts';
import type { LocalVisualNovelInspection } from './visual-novel-metadata.ts';

const executableExtensions = new Set(['.exe', '.sh', '.py']);
const pathKey = (path: string) => (process.platform === 'win32' ? path.toLowerCase() : path);
type Candidates = VisualNovelDiscovery['installations'][number]['candidates'];

export function visualNovelInstallationKey(executable: string, workingDirectory: string) {
  return pathKey(JSON.stringify([executable, workingDirectory]));
}

async function platformMatch(executable: string, extension: string) {
  if (process.platform === 'win32') return extension === '.exe';
  if (extension === '.exe') return false;
  return access(executable, constants.X_OK).then(
    () => true,
    () => false,
  );
}

function recommendation(candidates: Candidates) {
  if (candidates.some(({ instance }) => instance)) return undefined;
  const eligible = candidates.filter(({ platformMatch, metadata }) => platformMatch && metadata.engine !== 'unknown');
  const evidenced = eligible.filter(({ launchEvidence }) => launchEvidence);
  const choices = evidenced.length ? evidenced : eligible;
  if (choices.length === 1) return choices[0]?.executable;
}

export async function scanVisualNovelFolders(
  root: string,
  launcherData: string,
  installed: VisualNovelInstallation[],
  inspect: (executable: string, directory: string) => Promise<LocalVisualNovelInspection>,
  signal?: AbortSignal,
): Promise<VisualNovelDiscovery> {
  const result: VisualNovelDiscovery = { root, installations: [], errors: [] };
  const instances = new Map(
    installed.map(({ executable, workingDirectory, instance, archived }) => [
      visualNovelInstallationKey(executable, workingDirectory),
      { instance, ...(archived && { archived }) },
    ]),
  );
  const pending = [root];
  const packageFolders = new Set<string>();

  function recordError(path: string, error: unknown) {
    signal?.throwIfAborted();
    result.errors.push({ path, message: error instanceof Error ? error.message : 'Could not inspect this path.' });
  }

  for (let directory = pending.pop(); directory !== undefined; directory = pending.pop()) {
    signal?.throwIfAborted();
    if (relative(launcherData, directory) === '' || packageFolders.has(pathKey(directory))) continue;
    let entries;
    try {
      if (!(await fileInfo(directory))?.isDirectory()) throw new Error('This folder is no longer available.');
      entries = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      recordError(directory, error);
      continue;
    }
    entries.sort((left, right) => (left.name < right.name ? -1 : left.name > right.name ? 1 : 0));

    const candidates: Candidates = [];
    const startingErrors = result.errors.length;
    for (const entry of entries) {
      signal?.throwIfAborted();
      const extension = extname(entry.name).toLowerCase();
      if (!entry.isFile() || !executableExtensions.has(extension)) continue;
      const executable = join(directory, entry.name);
      try {
        const { metadata, packageDirectories, launchEvidence } = await inspect(executable, directory);
        const evidence =
          launchEvidence ??
          (metadata.engine === 'renpy' && (await hasRenpyBootstrap(executable, extension))
            ? 'renpy-bootstrap'
            : undefined);
        for (const folder of packageDirectories) packageFolders.add(pathKey(folder));
        const registration = instances.get(visualNovelInstallationKey(executable, directory));
        candidates.push({
          executable,
          workingDirectory: directory,
          metadata,
          platformMatch: await platformMatch(executable, extension),
          ...(evidence && { launchEvidence: evidence }),
          ...registration,
        });
      } catch (error) {
        recordError(executable, error);
      }
    }

    const recognized = candidates.filter(({ metadata }) => metadata.engine !== 'unknown').length;
    if (candidates.length) {
      const status =
        result.errors.length > startingErrors
          ? 'incomplete'
          : recognized > 1
            ? 'multiple'
            : recognized === 1
              ? 'single'
              : 'unrecognized';
      const recommendedExecutable = status === 'incomplete' ? undefined : recommendation(candidates);
      result.installations.push({
        directory,
        status,
        candidates,
        ...(recommendedExecutable && { recommendedExecutable }),
      });
    }
    for (const entry of entries.reverse()) {
      if (entry.isDirectory()) pending.push(join(directory, entry.name));
    }
  }
  signal?.throwIfAborted();
  return result;
}

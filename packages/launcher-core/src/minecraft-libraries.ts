import { checksum, type MinecraftFolder, type ResolvedLibrary } from '@xmcl/core';
import { DownloadTask, installResolvedLibrariesTask } from '@xmcl/installer';
import { randomUUID } from 'node:crypto';
import { rename, rm } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { isPortableSaveName } from './saved-worlds.ts';
import { fileInfo } from './storage.ts';

type Dispatcher = NonNullable<ConstructorParameters<typeof DownloadTask>[0]['dispatcher']>;
const centralRepositories = ['https://repo.maven.apache.org/maven2/', 'https://repo1.maven.org/maven2/'];
const sha1Pattern = /^[a-f\d]{40}$/u;

async function installPinnedLibrary(
  library: ResolvedLibrary,
  folder: MinecraftFolder,
  dispatcher: Dispatcher,
  signal: AbortSignal,
) {
  const { path, url, sha1 } = library.download;
  if (!sha1Pattern.test(sha1)) throw new Error('A Minecraft library supplied an invalid checksum.');
  const destination = folder.getLibraryByPath(path);
  if ((await fileInfo(destination))?.isFile() && (await checksum(destination, 'sha1')) === sha1) return;

  const artifact = path.split('/').map(encodeURIComponent).join('/');
  const sources = new Set([url, ...centralRepositories.map((repository) => repository + artifact)]);
  const staged = join(dirname(destination), `.rezics-library-${randomUUID()}.part`);
  let failure: unknown;
  try {
    for (const source of sources) {
      if (!source) continue;
      signal.throwIfAborted();
      try {
        // A separate task truncates the staging file before starting the next source.
        await new DownloadTask({
          url: source,
          destination: staged,
          dispatcher,
          skipPrevalidate: true,
          validator: { algorithm: 'sha1', hash: sha1 },
        }).startAndWait();
      } catch (error) {
        signal.throwIfAborted();
        failure = error;
        continue;
      }
      signal.throwIfAborted();
      await rename(staged, destination);
      return;
    }
    throw new Error('A Minecraft library could not be downloaded with its published checksum.', { cause: failure });
  } finally {
    await rm(staged, { force: true });
  }
}

export async function installMinecraftLibraries(
  libraries: ResolvedLibrary[],
  folder: MinecraftFolder,
  dispatcher: Dispatcher,
  signal: AbortSignal,
) {
  signal.throwIfAborted();
  if (libraries.some(({ download }) => !download.path.split('/').every(isPortableSaveName))) {
    throw new Error('Minecraft returned an invalid library path.');
  }
  const work = libraries
    .filter(({ download }) => download.sha1)
    .map((library) => installPinnedLibrary(library, folder, dispatcher, signal));
  const legacy = libraries.filter(({ download }) => !download.sha1);
  if (legacy.length) work.push(installResolvedLibrariesTask(legacy, folder, { dispatcher }).startAndWait());
  for (const result of await Promise.allSettled(work)) if (result.status === 'rejected') throw result.reason;
}

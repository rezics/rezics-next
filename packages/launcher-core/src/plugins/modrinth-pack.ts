import type { MinecraftSelection, ModrinthPackInstallControl } from '@rezics/launcher-contract';
import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { copyFile, link, mkdir, rm } from 'node:fs/promises';
import { dirname, join, resolve } from 'node:path';
import { downloadArtifact, hashArtifactFile } from '../artifact.ts';
import { fileInfo, Locks } from '../storage.ts';
import { copyPackArchive, inspectPackArchive, withPackArchive, writePackArchive } from './modrinth-pack-archive.ts';
import {
  comparePaths,
  maxPackDownload,
  matchesSelection,
  packDownloadUrl,
  packFingerprintEqual,
  packPath,
  packPreview,
  requiredResources,
  selectMinecraft,
  type PackFile,
  type PackResource,
} from './modrinth-pack-format.ts';
import { matchesPackFile, PackStorage, type PackChange, type PackLedger } from './modrinth-pack-storage.ts';

export class ModrinthPacks {
  private readonly locks = new Locks();

  constructor(private readonly fetcher: typeof fetch = fetch) {}

  inspect(source: string, signal?: AbortSignal) {
    return inspectPackArchive(source, signal);
  }

  async current(instanceDir: string, gameDir: string) {
    return this.locks.run(resolve(instanceDir), async () => {
      const store = new PackStorage(instanceDir, gameDir);
      await store.recover();
      const current = await store.read();
      return current ? packPreview(current.manifest, current.overrides) : null;
    });
  }

  committedModNames(instanceDir: string, gameDir: string): Promise<string[]> {
    return this.locks.run(resolve(instanceDir), async () => {
      const current = await new PackStorage(instanceDir, gameDir).read();
      return (current?.files ?? []).flatMap(({ path }) => {
        const [folder, file, child] = packPath(path);
        return folder === 'mods' && file && child === undefined ? [file] : [];
      });
    });
  }

  async recover(instanceDir: string, gameDir: string) {
    return this.locks.run(resolve(instanceDir), () => new PackStorage(instanceDir, gameDir).recover());
  }

  async firstDamagedDownload(instanceDir: string, gameDir: string) {
    return this.locks.run(resolve(instanceDir), async () => {
      const store = new PackStorage(instanceDir, gameDir);
      await store.recover();
      const current = await store.read();
      if (!current) return;
      for (const resource of requiredResources(current.manifest)) {
        const path = await store.game.file(resource.path, true);
        if (!(await matchesPackFile(path, { bytes: resource.fileSize, sha512: resource.hashes.sha512 }))) {
          return resource.path;
        }
      }
    });
  }

  async apply(
    instanceDir: string,
    gameDir: string,
    source: string,
    expectedDigest: string,
    expectedSelection?: MinecraftSelection,
    control?: ModrinthPackInstallControl,
  ) {
    const { signal } = control ?? {};
    return this.locks.run(
      resolve(instanceDir),
      async () => {
        const store = new PackStorage(instanceDir, gameDir);
        await store.recover();
        const previous = await store.read();
        try {
          signal?.throwIfAborted();
          await store.begin();
          const archive = join(store.stage, 'source.mrpack');
          if ((await copyPackArchive(source, archive, signal)) !== expectedDigest) {
            throw new Error('The Modrinth archive changed. Open its preview again.');
          }
          const draft = await withPackArchive(
            archive,
            async (manifest, overrides, copyOverrides) => {
              const selection = selectMinecraft(manifest);
              if (
                (expectedSelection && !matchesSelection(selection, expectedSelection)) ||
                (previous && !matchesSelection(selection, selectMinecraft(previous.manifest)))
              ) {
                throw new Error('The pack must use the instance’s exact Minecraft and loader versions.');
              }
              const resources = requiredResources(manifest);
              const files = await copyOverrides(store.original);
              for (const resource of resources) {
                files.push({ path: resource.path, bytes: resource.fileSize, sha512: resource.hashes.sha512 });
              }
              return {
                transaction: randomUUID(),
                manifest,
                overrides,
                files: files.sort(comparePaths),
              } satisfies PackLedger;
            },
            signal,
          );
          const changes = await this.plan(store, previous, draft, signal);
          await this.stageFiles(store, draft, changes, signal);
          signal?.throwIfAborted();
          control?.beginCommit?.();
          await store.commit(draft, changes, previous?.transaction);
          return packPreview(draft.manifest, draft.overrides);
        } finally {
          await store.recover();
        }
      },
      signal,
    );
  }

  async repair(
    instanceDir: string,
    gameDir: string,
    selection: MinecraftSelection,
    control?: ModrinthPackInstallControl,
  ) {
    const { signal } = control ?? {};
    return this.locks.run(
      resolve(instanceDir),
      async () => {
        const store = new PackStorage(instanceDir, gameDir);
        await store.recover();
        const current = await store.read();
        if (!current) throw new Error('There is no installed Modrinth pack to repair.');
        if (!matchesSelection(selectMinecraft(current.manifest), selection)) {
          throw new Error('The installed pack requires different Minecraft or loader versions.');
        }
        const changes = await this.plan(store, current, current, signal);
        signal?.throwIfAborted();
        if (!changes.length) return 0;
        try {
          await store.begin();
          for (const [path, source] of await originalOverrides(store, current, signal)) {
            signal?.throwIfAborted();
            const target = join(store.original, ...packPath(path));
            await mkdir(dirname(target), { recursive: true });
            await link(source, target);
          }
          await this.stageFiles(store, current, changes, signal);
          signal?.throwIfAborted();
          control?.beginCommit?.();
          await store.commit({ ...current, transaction: randomUUID() }, changes, current.transaction);
          return changes.length;
        } finally {
          await store.recover();
        }
      },
      signal,
    );
  }

  async export(instanceDir: string, gameDir: string, destination: string) {
    return this.locks.run(resolve(instanceDir), async () => {
      const store = new PackStorage(instanceDir, gameDir);
      await store.recover();
      const current = await store.read();
      if (!current) throw new Error('Import a Modrinth pack before exporting it.');
      const sources = await originalOverrides(store, current);
      try {
        return await writePackArchive(
          destination,
          instanceDir,
          current.manifest,
          current.overrides,
          (path) => sources.get(path)!,
          (folder) => store.reserveExport(folder),
        );
      } finally {
        await store.recover();
      }
    });
  }

  private async plan(store: PackStorage, current: PackLedger | undefined, draft: PackLedger, signal?: AbortSignal) {
    const owned = new Map(current?.files.map((file) => [file.path, file]));
    const incoming = new Map(draft.files.map((file) => [file.path, file]));
    const resources = new Map(requiredResources(draft.manifest).map((file) => [file.path, file]));
    const previousResources = new Map(current && requiredResources(current.manifest).map((file) => [file.path, file]));
    const samePack =
      current?.manifest.name === draft.manifest.name && current?.manifest.versionId === draft.manifest.versionId;
    const paths = new Set([...owned.keys(), ...incoming.keys()]);
    const changes: PackChange[] = [];

    for (const path of paths) {
      signal?.throwIfAborted();
      const previous = fingerprint(owned.get(path));
      const next = fingerprint(incoming.get(path));
      const target = await store.game.file(path, true);
      const exists = await fileInfo(target);
      const settings = path === 'options.txt' || path.startsWith('config/');
      if (exists && !previous) {
        if (settings) continue;
        throw new Error(`An unmanaged file occupies the Modrinth path (${path}).`);
      }
      if (exists && previous) {
        if (packFingerprintEqual(previous, next)) {
          const resource = resources.get(path);
          if (!resource) continue;
          const sha512 =
            exists.size <= maxPackDownload ? await hashArtifactFile(target, exists.size, 'sha512', signal) : undefined;
          const actual = sha512 ? { bytes: exists.size, sha512 } : null;
          if (packFingerprintEqual(actual, previous)) {
            if ((await hashArtifactFile(target, previous.bytes, 'sha1', signal)) === resource.hashes.sha1) continue;
            throw new Error(`The installed Modrinth resource could not be verified (${path}).`);
          }
          // A repair records what is physically present so interruption can restore that exact file.
          if (!actual || !samePack || previousResources.get(path)?.hashes.sha1 !== resource.hashes.sha1) {
            throw new Error(
              `The installed Modrinth resource could not be verified (${path}). Repair the installed pack before changing versions.`,
            );
          }
          changes.push({ path, previous: actual, next });
          continue;
        }
        const stillOwned = await matchesPackFile(target, previous, signal);
        if (!stillOwned && (!next || settings)) continue;
        if (!stillOwned) throw new Error(`The pack cannot replace a locally edited file (${path}).`);
      }
      const live = exists ? previous : null;
      if (!packFingerprintEqual(live, next)) changes.push({ path, previous: live, next });
    }
    return changes.sort(comparePaths);
  }

  private async stageFiles(store: PackStorage, draft: PackLedger, changes: PackChange[], cancellation?: AbortSignal) {
    const resources = new Map(requiredResources(draft.manifest).map((file) => [file.path, file]));
    const timeout = AbortSignal.timeout(20 * 60_000);
    const signal = cancellation ? AbortSignal.any([cancellation, timeout]) : timeout;
    const request = (async (input, init) => {
      const requested = input instanceof URL ? input : typeof input === 'string' ? input : input.url;
      const url = packDownloadUrl(requested, true);
      return this.fetcher(url, { ...init, credentials: 'omit' });
    }) as typeof fetch;

    for (const { path, next } of changes) {
      signal.throwIfAborted();
      if (!next) continue;
      const parts = packPath(path);
      const target = join(store.next, ...parts);
      await mkdir(dirname(target), { recursive: true });
      const resource = resources.get(path);
      if (resource) await downloadResource(request, resource, target, signal);
      else await copyFile(join(store.original, ...parts), target, constants.COPYFILE_EXCL);
    }
  }
}

async function originalOverrides(store: PackStorage, current: PackLedger, signal?: AbortSignal) {
  const overrides = new Set(current.overrides.map((override) => override.path));
  const sources = new Map<string, string>();
  for (const record of current.files) {
    if (!overrides.has(record.path)) continue;
    signal?.throwIfAborted();
    const source = await store.retained(current.transaction, record.path);
    if (!(await matchesPackFile(source, record, signal))) {
      throw new Error(`An original Modrinth pack override could not be verified (${record.path}).`);
    }
    sources.set(record.path, source);
  }
  return sources;
}

function fingerprint(file?: PackFile) {
  return file ? { bytes: file.bytes, sha512: file.sha512 } : null;
}

async function downloadResource(fetcher: typeof fetch, resource: PackResource, target: string, signal: AbortSignal) {
  let failure: unknown;
  for (const url of resource.downloads) {
    signal.throwIfAborted();
    try {
      await downloadArtifact(
        fetcher,
        {
          url,
          size: resource.fileSize,
          digest: resource.hashes.sha512,
          algorithm: 'sha512',
        },
        target,
        signal,
      );
      if ((await hashArtifactFile(target, resource.fileSize, 'sha1', signal)) !== resource.hashes.sha1) {
        throw new Error('The SHA-1 digest does not match the pack index.');
      }
      return;
    } catch (error) {
      await rm(target, { force: true });
      signal.throwIfAborted();
      failure = error;
    }
  }
  const detail = failure instanceof Error ? failure.message : 'The download failed.';
  throw new Error(`Could not verify the Modrinth resource (${resource.path}). ${detail}`);
}

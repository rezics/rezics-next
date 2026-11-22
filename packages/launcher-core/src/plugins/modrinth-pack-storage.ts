import { randomUUID } from 'node:crypto';
import { link, lstat, mkdir, readdir, realpath, rename, rm, rmdir } from 'node:fs/promises';
import { dirname, isAbsolute, join, resolve } from 'node:path';
import * as v from 'valibot';
import { hashArtifactFile } from '../artifact.ts';
import { fileInfo, isMissing, readJson, writeJson } from '../storage.ts';
import {
  comparePaths,
  maxPackArchive,
  maxPackEntries,
  maxPackIndex,
  overrideSchema,
  packFileSchema,
  packFingerprintEqual,
  packFingerprintSchema,
  packPath,
  pathKey,
  PackPaths,
  parsePackManifest,
  requireClientPath,
  requiredResources,
  type PackFile,
  type PackFingerprint,
  type PackManifest,
  type PackOverride,
} from './modrinth-pack-format.ts';

const transactionId = v.pipe(v.string(), v.uuid());
const exportSchema = v.strictObject({ folder: v.pipe(v.string(), v.check(isAbsolute)), id: transactionId });
const journalSchema = v.strictObject({
  transaction: transactionId,
  previousTransaction: v.optional(transactionId),
  changes: v.pipe(
    v.array(
      v.strictObject({
        path: v.string(),
        previous: v.nullable(packFingerprintSchema),
        next: v.nullable(packFingerprintSchema),
      }),
    ),
    v.maxLength(maxPackEntries * 2),
  ),
});
const ledgerSchema = v.strictObject({
  transaction: transactionId,
  manifest: v.unknown(),
  overrides: v.pipe(v.array(overrideSchema), v.maxLength(maxPackEntries)),
  files: v.pipe(v.array(packFileSchema), v.maxLength(maxPackEntries)),
});

export type PackJournal = v.InferOutput<typeof journalSchema>;
export type PackChange = PackJournal['changes'][number];
export type PackLedger = Omit<v.InferOutput<typeof ledgerSchema>, 'manifest'> & { manifest: PackManifest };
type PackExport = v.InferOutput<typeof exportSchema>;

function exportScratch({ folder, id }: PackExport) {
  return join(folder, `.modrinth-export-${id}`);
}

async function readMetadata(path: string) {
  const info = await fileInfo(path);
  if (!info) return undefined;
  if (!info.isFile() || info.size > 4 * maxPackIndex) {
    throw new Error('Launcher’s Modrinth pack metadata is unavailable or invalid.');
  }
  return readJson<unknown>(path);
}

async function directory(path: string, create = false) {
  const info = await fileInfo(path);
  if (info && !info.isDirectory()) throw new Error('A Modrinth pack folder is unavailable or linked.');
  if (!info && create) await mkdir(path, { recursive: true });
}

async function regularFile(path: string, message: string) {
  const info = await fileInfo(path);
  if (info && !info.isFile()) throw new Error(message);
  return info;
}

export async function matchesPackFile(path: string, expected: PackFingerprint, signal?: AbortSignal) {
  const info = await regularFile(path, 'A Modrinth pack file is unavailable or linked.');
  return (
    info?.size === expected.bytes &&
    (await hashArtifactFile(path, expected.bytes, 'sha512', signal)) === expected.sha512
  );
}

export class GamePackPaths {
  private readonly listing = new Map<string, Map<string, string[]>>();

  constructor(private readonly game: string) {}

  async file(path: string, checkAliases = false, createParents = false) {
    const parts = packPath(path);
    await directory(this.game, createParents);
    let location = this.game;
    for (const [index, part] of parts.entries()) {
      if (checkAliases) await this.checkAlias(location, part);
      location = join(location, part);
      if (index < parts.length - 1) await directory(location, createParents);
    }
    await regularFile(location, `A linked or non-file entry occupies the Modrinth path (${path}).`);
    return location;
  }

  async findLiveFile(path: string) {
    let location = this.game;
    for (const part of packPath(path)) {
      if (!(await fileInfo(location))?.isDirectory()) return;
      location = join(location, part);
    }
    if ((await fileInfo(location))?.isFile()) return location;
  }

  private async checkAlias(directory: string, part: string) {
    let entries = this.listing.get(directory);
    if (!entries) {
      entries = new Map();
      if ((await fileInfo(directory))?.isDirectory()) {
        for (const name of await readdir(directory)) {
          const key = pathKey(name);
          const same = entries.get(key);
          if (same) same.push(name);
          else entries.set(key, [name]);
        }
      }
      this.listing.set(directory, entries);
    }
    const names = entries.get(pathKey(part));
    if (names && (names.length !== 1 || names[0] !== part)) {
      throw new Error(`An existing entry conflicts with the Modrinth path (${part}).`);
    }
  }
}

export class PackStorage {
  readonly stage: string;
  readonly next: string;
  readonly original: string;
  readonly game: GamePackPaths;
  private readonly previous: string;
  private readonly ledger: string;
  private readonly content: string;
  private readonly journal: string;
  private readonly exportJournals: string;

  constructor(
    private readonly instance: string,
    game: string,
  ) {
    if (resolve(game) !== join(resolve(instance), 'game'))
      throw new Error('Choose the Minecraft instance game folder.');
    this.stage = join(instance, 'modrinth-pack-staging');
    this.next = join(this.stage, 'next');
    this.previous = join(this.stage, 'previous');
    this.original = join(this.stage, 'original');
    this.ledger = join(instance, 'modrinth-pack.json');
    this.content = join(instance, 'modrinth-pack-content');
    this.journal = join(this.stage, 'journal.json');
    this.exportJournals = join(instance, 'modrinth-pack-exports');
    this.game = new GamePackPaths(game);
  }

  async retained(transaction: string, path: string) {
    await directory(this.content);
    return new GamePackPaths(join(this.content, transaction)).file(path);
  }

  async read(): Promise<PackLedger | undefined> {
    const raw = await readMetadata(this.ledger);
    if (raw === undefined) return;
    const data = v.parse(ledgerSchema, raw);
    const manifest = parsePackManifest(data.manifest);
    const paths = new PackPaths();
    const expected = new Map<string, { bytes: number; sha512?: string }>();
    for (const resource of manifest.files) paths.add(resource.path);
    for (const resource of requiredResources(manifest)) {
      expected.set(resource.path, { bytes: resource.fileSize, sha512: resource.hashes.sha512 });
    }
    let overrideBytes = 0;
    for (const override of data.overrides) {
      requireClientPath(override.path, 'override');
      paths.add(override.path);
      overrideBytes += override.bytes;
      expected.set(override.path, override);
    }
    if (overrideBytes > maxPackArchive || manifest.files.length + data.overrides.length > maxPackEntries) {
      throw new Error('Launcher’s Modrinth pack file ledger is invalid.');
    }
    for (const file of data.files) {
      const record = expected.get(file.path);
      if (!record || record.bytes !== file.bytes || (record.sha512 && record.sha512 !== file.sha512)) {
        throw new Error('Launcher’s Modrinth pack file ledger is invalid.');
      }
      expected.delete(file.path);
    }
    if (expected.size) throw new Error('Launcher’s Modrinth pack file ledger is incomplete.');
    return { ...data, files: data.files.sort(comparePaths), overrides: data.overrides.sort(comparePaths), manifest };
  }

  async begin() {
    await directory(this.instance, true);
    await mkdir(this.stage);
    await mkdir(this.original);
  }

  async reserveExport(folder: string) {
    const reservation = { folder, id: randomUUID() };
    await directory(this.exportJournals, true);
    await writeJson(join(this.exportJournals, `${reservation.id}.json`), reservation);
    const scratch = exportScratch(reservation);
    await mkdir(scratch, { mode: 0o700 });
    return join(scratch, 'pack.mrpack');
  }

  async commit(ledger: PackLedger, changes: PackChange[], previousTransaction?: string) {
    const transaction = ledger.transaction;
    await writeJson(this.journal, { transaction, previousTransaction, changes } satisfies PackJournal);
    for (const change of changes) {
      const { path, previous, next } = change;
      const parts = packPath(path);
      const target = await this.game.file(path, false, Boolean(next));
      if (previous) {
        if (!(await matchesPackFile(target, previous))) {
          throw new Error(`The Modrinth pack file changed before it could be updated (${path}).`);
        }
        const backup = join(this.previous, ...parts);
        await mkdir(dirname(backup), { recursive: true });
        await rename(target, backup);
      }
      if (next) {
        try {
          await link(join(this.next, ...parts), target);
        } catch (error) {
          if (error && typeof error === 'object' && 'code' in error && error.code === 'EEXIST') {
            throw new Error(`Another file already occupies the Modrinth path (${path}).`, { cause: error });
          }
          throw error;
        }
      }
    }

    await directory(this.content, true);
    await rename(this.original, join(this.content, transaction));
    await writeJson(this.ledger, ledger);
  }

  async recover() {
    await directory(this.instance);
    await directory(this.stage);
    const raw = await readMetadata(this.journal);
    if (raw !== undefined) {
      const journal = v.parse(journalSchema, raw);
      const paths = new PackPaths();
      for (const { path, previous, next } of journal.changes) {
        requireClientPath(path, 'owned');
        paths.add(path);
        if (packFingerprintEqual(previous, next)) throw new Error('Launcher’s Modrinth pack journal is invalid.');
      }
      const current = await this.read();
      const complete = current?.transaction === journal.transaction;
      if (!complete) {
        if (current?.transaction !== journal.previousTransaction) {
          throw new Error('Launcher’s Modrinth pack ledger changed during recovery.');
        }
        await directory(this.previous);
        await directory(this.next);
        let failure: unknown;
        for (const change of journal.changes.slice().reverse()) {
          try {
            await this.rollback(change);
          } catch (error) {
            failure ??= error;
          }
        }
        if (failure !== undefined) throw failure;
      }
      const discard = complete ? journal.previousTransaction : journal.transaction;
      if (discard) {
        await directory(this.content);
        await rm(join(this.content, discard), { recursive: true, force: true });
      }
    }
    await rm(this.stage, { recursive: true, force: true });
    await this.cleanExports();
  }

  private async cleanExports() {
    if (!(await fileInfo(this.exportJournals))?.isDirectory()) return;
    for (const name of await readdir(this.exportJournals)) {
      const id = name.slice(0, -5);
      if (!name.endsWith('.json') || !v.is(transactionId, id)) continue;
      const journal = join(this.exportJournals, name);
      const parsed = v.safeParse(exportSchema, await readMetadata(journal));
      if (!parsed.success || parsed.output.id !== id) continue;
      if (await this.cleanExport(parsed.output).catch(() => false)) await rm(journal, { force: true });
    }
    if ((await readdir(this.exportJournals)).length === 0) await rmdir(this.exportJournals);
  }

  private async cleanExport(reservation: PackExport) {
    const folder = await realpath(reservation.folder).catch((error: unknown) => {
      if (!isMissing(error)) throw error;
      return undefined;
    });
    if (folder !== reservation.folder) return false;
    const scratch = exportScratch(reservation);
    if (!(await fileInfo(scratch))?.isDirectory()) return true;
    const archive = join(scratch, 'pack.mrpack');
    if ((await fileInfo(archive))?.isFile()) await rm(archive, { force: true });
    if ((await readdir(scratch)).length === 0) await rmdir(scratch);
    return true;
  }

  private async rollback({ path, previous, next }: PackChange) {
    const parts = packPath(path);
    const backup = join(this.previous, ...parts);
    const original = previous && (await fileInfo(backup)) ? previous : undefined;
    const target = await this.game.findLiveFile(path);
    const incoming = join(this.next, ...parts);

    // Publication moves the original into the journal and hard-links the staged file into the game.
    const published = target && next && (await sameFile(target, incoming)) ? target : undefined;
    const restore = original && (await this.game.file(path, true));
    if (original && restore) {
      if (!published) {
        if (await sameFile(restore, backup)) return;
        if (await matchesPackFile(restore, original)) return;
        if (await fileInfo(restore)) throw new Error(`A different file occupies the Modrinth recovery path (${path}).`);
      }
      if (!(await matchesPackFile(backup, original))) {
        throw new Error(`A Modrinth recovery file is damaged (${path}).`);
      }
    } else if (previous && published) {
      throw new Error(`A Modrinth recovery file is missing (${path}).`);
    }

    if (published && next) {
      if (!(await matchesPackFile(published, next)) || !(await sameFile(published, incoming))) {
        throw new Error(`The staged Modrinth file changed during recovery (${path}).`);
      }
      await rm(published);
    }
    if (restore) await link(backup, restore);
  }
}

async function sameFile(first: string, second: string) {
  try {
    const [left, right] = await Promise.all([lstat(first, { bigint: true }), lstat(second, { bigint: true })]);
    return left.isFile() && right.isFile() && left.ino !== 0n && left.ino === right.ino && left.dev === right.dev;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return false;
  }
}

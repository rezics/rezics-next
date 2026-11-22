import { createHash, type Hash } from 'node:crypto';
import { createReadStream, createWriteStream } from 'node:fs';
import { mkdir, opendir } from 'node:fs/promises';
import { join } from 'node:path';
import { Transform, Writable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { isPortableSaveName } from './saved-worlds.ts';
import { fileInfo } from './storage.ts';

export const portableSaveLimits = { entries: 250_000, bytes: 64 * 1024 ** 3, depth: 64 };

type TreeCounts = { files: number; bytes: number };
type TreeDigest = TreeCounts & { sha256: string };
export type SnapshotRoot = TreeCounts & { id: string; sha256?: string };
type CopyOptions = { portable?: { entries: number; bytes: number }; signal?: AbortSignal | undefined };

export function matchesSaveTree(expected: SnapshotRoot, copied: TreeDigest) {
  return (
    copied.files === expected.files &&
    copied.bytes === expected.bytes &&
    (expected.sha256 === undefined || copied.sha256 === expected.sha256)
  );
}

async function readFileWithHash(
  from: string,
  to: string | undefined,
  size: number,
  mode: number,
  hash: Hash,
  signal?: AbortSignal,
) {
  let copied = 0;
  const through = new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      copied += chunk.length;
      if (copied > size) return callback(new Error('A backup file changed while copying.'));
      hash.update(chunk);
      callback(null, chunk);
    },
  });
  const output = to
    ? createWriteStream(to, { flags: 'wx', mode })
    : new Writable({ write: (_chunk, _encoding, callback) => callback() });
  await pipeline(createReadStream(from), through, output, { signal });
  if (copied !== size) throw new Error('A backup file changed while copying.');
}

async function readSaveTree(source: string, target: string | undefined, { portable, signal }: CopyOptions = {}) {
  const hash = createHash('sha256');
  const counts: TreeCounts = { files: 0, bytes: 0 };
  async function walk(from: string, to: string | undefined, key: string, depth: number) {
    signal?.throwIfAborted();
    if (portable && depth > portableSaveLimits.depth) throw new Error('A backup folder is nested too deeply.');
    if (!(await fileInfo(from))?.isDirectory()) throw new Error('A backup directory is unavailable or linked.');
    if (to) await mkdir(to);
    hash.update(JSON.stringify(['dir', key]) + '\n');

    const entries: { name: string; normalized: string }[] = [];
    const identities = new Set<string>();
    const dir = await opendir(from);
    for await (const { name } of dir) {
      signal?.throwIfAborted();
      const normalized = name.normalize('NFC');
      if (portable) {
        if (++portable.entries > portableSaveLimits.entries) throw new Error('The backup contains too many entries.');
        const identity = normalized.toUpperCase();
        if (!isPortableSaveName(name) || identities.has(identity)) {
          throw new Error('A backup has an incompatible or duplicate filename.');
        }
        identities.add(identity);
      }
      entries.push({ name, normalized });
    }
    entries.sort((a, b) => {
      if (a.normalized !== b.normalized) return a.normalized < b.normalized ? -1 : 1;
      return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
    });

    for (const { name, normalized } of entries) {
      signal?.throwIfAborted();
      const child = join(from, name);
      const destination = to ? join(to, name) : undefined;
      const childKey = key + '/' + normalized;
      const file = await fileInfo(child);
      if (file?.isDirectory()) {
        await walk(child, destination, childKey, depth + 1);
      } else if (file?.isFile()) {
        if (portable) {
          portable.bytes += file.size;
          if (portable.bytes > portableSaveLimits.bytes) {
            throw new Error('The backup is larger than the supported portable size.');
          }
        }
        hash.update(JSON.stringify(['file', childKey, file.size]) + '\n');
        await readFileWithHash(child, destination, file.size, portable ? 0o600 : file.mode & 0o777, hash, signal);
        counts.files++;
        counts.bytes += file.size;
      } else {
        throw new Error('A backup contains a missing file, link, or special file.');
      }
    }
  }
  await walk(source, target, '', 0);
  return { ...counts, sha256: hash.digest('hex') };
}

export function copySaveTree(source: string, target: string, options?: CopyOptions) {
  return readSaveTree(source, target, options);
}

export function hashSaveTree(source: string) {
  return readSaveTree(source, undefined);
}

import { minecraftReleaseIdPattern } from '@rezics/launcher-contract';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { buffer } from 'node:stream/consumers';
import { gunzipSync } from 'node:zlib';
import { fileInfo } from './storage.ts';

export const minecraftLevelFileLimit = 4 * 1024 ** 2;
const fixedSizes = [0, 1, 2, 4, 8, 4, 8];
type Scope = 'root' | 'data' | 'version';

/** Read the release label from Java Edition NBT without materializing the rest of the level. */
function minecraftLevelRelease(nbt: Buffer): string | undefined {
  let offset = 0;
  let release: string | undefined;
  let snapshot: number | undefined;
  let series: string | undefined;

  function take(size: number) {
    const start = offset;
    if (size < 0 || size > nbt.length - start) throw new RangeError('Invalid NBT length.');
    offset += size;
    return start;
  }

  function string(decode: boolean) {
    const length = nbt.readUInt16BE(take(2));
    const start = take(length);
    return decode ? nbt.toString('utf8', start, offset) : undefined;
  }

  function compound(depth: number, scope?: Scope) {
    if (depth > 64) throw new RangeError('NBT is nested too deeply.');
    for (let type = nbt.readUInt8(take(1)); type !== 0; type = nbt.readUInt8(take(1))) {
      const name = string(scope !== undefined);
      if (scope === 'root' && name === 'Data' && type === 10) compound(depth + 1, 'data');
      else if (scope === 'data' && name === 'Version' && type === 10) compound(depth + 1, 'version');
      else if (scope === 'version' && name === 'Name' && type === 8) release = string(true);
      else if (scope === 'version' && name === 'Snapshot' && type === 1) snapshot = nbt.readUInt8(take(1));
      else if (scope === 'version' && name === 'Series' && type === 8) series = string(true);
      else skip(type, depth + 1);
    }
  }

  function skip(type: number, depth: number) {
    if (depth > 64) throw new RangeError('NBT is nested too deeply.');
    const width = fixedSizes[type];
    if (width) take(width);
    else if (type === 7 || type === 11 || type === 12) {
      const count = nbt.readInt32BE(take(4));
      take(count * (type === 7 ? 1 : type === 11 ? 4 : 8));
    } else if (type === 8) string(false);
    else if (type === 9) {
      const item = nbt.readUInt8(take(1));
      const count = nbt.readInt32BE(take(4));
      if (count < 0 || count > nbt.length - offset || item > 12 || (item === 0 && count !== 0)) {
        throw new RangeError('Invalid NBT list.');
      }
      const itemWidth = fixedSizes[item];
      if (itemWidth) take(count * itemWidth);
      else for (let index = 0; index < count; index++) skip(item, depth + 1);
    } else if (type === 10) compound(depth);
    else throw new RangeError('Invalid NBT tag.');
  }

  try {
    if (nbt.readUInt8(take(1)) !== 10) return undefined;
    string(false);
    compound(0, 'root');
    if (offset === nbt.length && snapshot === 0 && (series === undefined || series === 'main')) {
      if (release && minecraftReleaseIdPattern.test(release)) return release;
    }
  } catch {
    // Unreadable or unusually nested metadata leaves the world version unknown.
  }
}

export function inspectMinecraftLevel(data: Buffer) {
  try {
    const nbt = gunzipSync(data, { maxOutputLength: 16 * 1024 ** 2 });
    if (nbt.length > 4 && nbt[0] === 10 && nbt[nbt.length - 1] === 0) {
      return { release: minecraftLevelRelease(nbt) };
    }
  } catch {
    // Unreadable level data has no version to compare.
  }
}

export async function readMinecraftLevelRelease(path: string): Promise<string | undefined> {
  try {
    const expected = await fileInfo(path);
    if (!expected?.isFile() || !expected.size || expected.size > minecraftLevelFileLimit) return;
    const handle = await open(path, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    try {
      const info = await handle.stat();
      if (!info.isFile() || info.ino !== expected.ino || info.dev !== expected.dev || info.size !== expected.size)
        return;
      const bytes = await buffer(handle.createReadStream({ start: 0, end: info.size - 1, autoClose: false }));
      return inspectMinecraftLevel(bytes)?.release;
    } finally {
      await handle.close();
    }
  } catch {
    // An unreadable level does not prevent backing up its other files.
  }
}

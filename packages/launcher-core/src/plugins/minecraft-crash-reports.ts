import { constants } from 'node:fs';
import { open, opendir, realpath } from 'node:fs/promises';
import { join, relative } from 'node:path';
import { credentialRedactor } from '../launch-redaction.ts';
import { checkLocalDirectory, fileInfo, isMissing, storagePath } from '../storage.ts';

const crashName = /^crash-\d{4}-\d{2}-\d{2}_\d{2}\.\d{2}\.\d{2}(?:-[a-z0-9_-]{1,32})?\.txt$/iu;
const header = /^\uFEFF?---- Minecraft Crash Report ----\r?\n/u;
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
const scanLimit = 4096;
const candidateLimit = 8;
export const crashExcerptLimit = 24_576;

async function reportNames(game: string, folder: string) {
  await checkLocalDirectory(game, 'Minecraft game');
  await checkLocalDirectory(folder, 'Minecraft crash reports');
  const names: string[] = [];
  try {
    const entries = await opendir(folder);
    let count = 0;
    for await (const { name } of entries) {
      if (++count > scanLimit) throw new Error('Too many files in the Minecraft crash reports folder.');
      if (crashName.test(name)) names.push(name);
    }
  } catch (error) {
    if (!isMissing(error)) throw error;
  }
  return names;
}

async function readCrashExcerpt(path: string, secret?: string) {
  const original = await fileInfo(path);
  if (!original?.isFile() || original.nlink !== 1 || relative(path, await realpath(path))) return;
  const file = await open(path, fileFlags);
  try {
    const opened = await file.stat();
    if (!opened.isFile() || opened.dev !== original.dev || opened.ino !== original.ino || opened.nlink !== 1) return;
    const buffer = Buffer.alloc(crashExcerptLimit);
    let size = 0;
    while (size < buffer.length) {
      const { bytesRead } = await file.read(buffer, size, buffer.length - size, size);
      if (!bytesRead) break;
      size += bytesRead;
    }
    const after = await file.stat();
    if (after.size !== opened.size || after.mtimeMs !== opened.mtimeMs || relative(path, await realpath(path))) return;
    const excerpt = buffer.toString('utf8', 0, size);
    if (!header.test(excerpt)) return;
    const truncated = size < opened.size;
    const lines = excerpt.split('\n');
    if (truncated) lines.pop();
    const text = lines.map(credentialRedactor(secret)).join('\n').trimEnd();
    return { text: text.slice(0, crashExcerptLimit), truncated: truncated || text.length > crashExcerptLimit };
  } finally {
    await file.close();
  }
}

export async function observeMinecraftCrashes(path: string) {
  const game = await checkLocalDirectory(path, 'Minecraft game')
    .then(() => storagePath(path))
    .catch(() => undefined);
  if (!game) return;
  const folder = join(game, 'crash-reports');
  const existing = await reportNames(game, folder).then(
    (names) => new Set(names),
    () => undefined,
  );
  if (!existing) return;
  return async (secret?: string) => {
    const names = await reportNames(game, folder).catch(() => []);
    const candidates = names
      .filter((name) => !existing.has(name))
      .sort()
      .reverse()
      .slice(0, candidateLimit);
    for (const name of candidates) {
      const report = await readCrashExcerpt(join(folder, name), secret).catch(() => undefined);
      if (report) return report;
    }
  };
}

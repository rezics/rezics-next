import { randomUUID } from 'node:crypto';
import { lstat, mkdir, opendir, readFile, realpath, rename, rm, rmdir, unlink, writeFile } from 'node:fs/promises';
import { basename, dirname, join, resolve } from 'node:path';

export function isMissing(error: unknown): boolean {
  return Boolean(error && typeof error === 'object' && 'code' in error && error.code === 'ENOENT');
}

export async function fileInfo(file: string) {
  try {
    return await lstat(file);
  } catch (error) {
    if (!isMissing(error)) throw error;
    return undefined;
  }
}

export async function reclaimLocalTree(path: string) {
  const parent = await fileInfo(dirname(path));
  if (!parent?.isDirectory()) return;
  await reclaimEntry(path, parent.dev);
}

async function reclaimEntry(path: string, device: number) {
  const info = await fileInfo(path);
  if (!info) return;
  if (info.dev !== device) throw new Error('Disconnect the mounted folder before reclaiming this directory.');
  if (!info.isDirectory()) {
    await unlink(path);
    return;
  }
  const entries = await opendir(path);
  for await (const entry of entries) await reclaimEntry(join(path, entry.name), device);
  await rmdir(path);
}

export async function storagePath(path: string): Promise<string> {
  try {
    return await realpath(path);
  } catch (error) {
    if (!isMissing(error)) throw error;
    const absolute = resolve(path);
    const parent = dirname(absolute);
    if (absolute === parent) return absolute;
    return join(await storagePath(parent), basename(absolute));
  }
}

export async function checkLocalDirectory(path: string, name: string) {
  const entry = await fileInfo(path);
  if (entry && !entry.isDirectory()) throw new Error(`The ${name} folder is unavailable or is a link.`);
}

export async function readJson<T>(file: string): Promise<T | undefined> {
  try {
    return JSON.parse(await readFile(file, 'utf8')) as T;
  } catch (error) {
    if (!isMissing(error)) throw error;
    return undefined;
  }
}

export async function writeJson(file: string, value: unknown) {
  await mkdir(dirname(file), { recursive: true });
  const temporary = join(dirname(file), `.rezics-${randomUUID()}.tmp`);
  try {
    await writeFile(temporary, JSON.stringify(value), { flush: true, mode: 0o600, flag: 'wx' });
    await rename(temporary, file);
  } finally {
    await rm(temporary, { force: true });
  }
}

export function pathnameId(id: string): string {
  if (!/^[a-zA-Z0-9][a-zA-Z0-9_-]{0,119}$/.test(id)) throw new Error('Invalid identifier.');
  return id;
}

export function humanText(value: string, length: number, field: string): string {
  if (typeof value !== 'string' || !value.trim() || value.trim().length > length || value.includes('\0')) {
    throw new Error(`Enter a ${field} between 1 and ${length} characters.`);
  }
  return value.trim();
}

/** Serialize related writes, and let unrelated instance operations proceed. */
export class Locks {
  private readonly queues = new Map<string, Promise<void>>();

  async run<T>(key: string, work: () => Promise<T>, signal?: AbortSignal): Promise<T> {
    signal?.throwIfAborted();
    const previous = this.queues.get(key) ?? Promise.resolve();
    let entered = false;
    const result = previous.then(() => {
      signal?.throwIfAborted();
      entered = true;
      return work();
    });
    const tail = result.then(
      () => undefined,
      () => undefined,
    );
    this.queues.set(key, tail);
    void tail.then(() => {
      if (this.queues.get(key) === tail) this.queues.delete(key);
    });
    if (!signal) return result;

    const cancelled = Promise.withResolvers<never>();
    const abort = () => {
      if (!entered) cancelled.reject(signal.reason);
    };
    signal.addEventListener('abort', abort, { once: true });
    try {
      // Early cancellation returns to the caller while the tail still protects the active work.
      return await Promise.race([result, cancelled.promise]);
    } finally {
      signal.removeEventListener('abort', abort);
    }
  }
}

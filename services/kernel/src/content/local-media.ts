import { randomUUID } from 'node:crypto';
import { constants } from 'node:fs';
import { open, lstat, mkdir, realpath, rename, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { resolve } from 'node:path';
import type { MediaStorage } from './media-storage.ts';

const REPOSITORY_ROOT = fileURLToPath(new URL('../../../../', import.meta.url));
const LOCAL_STACK_ROOT = resolve(REPOSITORY_ROOT, '.temp/local-stack');
export const LOCAL_MEDIA_ROOT = resolve(LOCAL_STACK_ROOT, 'content-media');
export const LOCAL_MEDIA_MAX_OBJECT_BYTES = 20 * 1024 * 1024;

const UUID = '[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}';
const WIDTHS = new Set([320, 640, 960, 1280, 1920, 2560]);
const CHUNK_BYTES = 64 * 1024;

type ParsedKey = Readonly<{ mediaId: string; variant: string }>;

function parsedKey(key: string): ParsedKey {
  const match = new RegExp(`^m/(${UUID})/(original|(?:avif|webp)-([1-9][0-9]{0,3}))$`).exec(key);
  if (!match) throw new TypeError('Invalid local media key');
  const width = match[3] === undefined ? null : Number(match[3]);
  if (width !== null && !(width < 320 || WIDTHS.has(width))) throw new TypeError('Invalid local media key');
  return { mediaId: match[1]!, variant: match[2]! };
}

function parsedPrefix(prefix: string): string {
  const match = new RegExp(`^m/(${UUID})/$`).exec(prefix);
  if (!match) throw new TypeError('Invalid local media prefix');
  return match[1]!;
}

function missing(error: unknown): boolean {
  return (error as NodeJS.ErrnoException).code === 'ENOENT';
}

async function checkDirectory(path: string, create: boolean): Promise<boolean> {
  if (create) {
    try {
      await mkdir(path, { mode: 0o700 });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'EEXIST') throw error;
    }
  }
  let info;
  try {
    info = await lstat(path);
  } catch (error) {
    if (!create && missing(error)) return false;
    throw error;
  }
  if (!info.isDirectory() || info.isSymbolicLink()) throw new Error('Local media path is not a confined directory');
  return true;
}

async function checkLocalRoot(create: boolean): Promise<boolean> {
  if ((await realpath(REPOSITORY_ROOT)) !== REPOSITORY_ROOT)
    throw new Error('Local media repository root is not canonical');
  for (const path of [resolve(REPOSITORY_ROOT, '.temp'), LOCAL_STACK_ROOT, LOCAL_MEDIA_ROOT]) {
    if (!(await checkDirectory(path, create))) return false;
  }
  return true;
}

async function checkMediaDirectory(mediaId: string, create: boolean): Promise<string | null> {
  if (!(await checkLocalRoot(create))) return null;
  const objectRoot = resolve(LOCAL_MEDIA_ROOT, 'm');
  if (!(await checkDirectory(objectRoot, create))) return null;
  const directory = resolve(objectRoot, mediaId);
  return (await checkDirectory(directory, create)) ? directory : null;
}

async function boundedBytes(file: Awaited<ReturnType<typeof open>>, maximum: number): Promise<Uint8Array> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (true) {
    const buffer = new Uint8Array(Math.min(CHUNK_BYTES, maximum + 1 - size));
    const { bytesRead } = await file.read(buffer, 0, buffer.byteLength, null);
    if (bytesRead === 0) break;
    size += bytesRead;
    if (size > maximum) throw new RangeError('Local media object exceeds its byte limit');
    chunks.push(buffer.slice(0, bytesRead));
  }
  const output = new Uint8Array(size);
  let offset = 0;
  for (const chunk of chunks) {
    output.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return output;
}

/** Persistent local-only bytes for the documented development stack. */
export class LocalMediaStorage implements MediaStorage {
  #tail: Promise<void> = Promise.resolve();

  constructor(private readonly options: Readonly<{ root: string; maxObjectBytes: number }>) {
    if (options.root !== LOCAL_MEDIA_ROOT || options.maxObjectBytes !== LOCAL_MEDIA_MAX_OBJECT_BYTES)
      throw new TypeError('Invalid local content media configuration');
  }

  async get(key: string): Promise<Uint8Array | null> {
    const { mediaId, variant } = parsedKey(key);
    const directory = await checkMediaDirectory(mediaId, false);
    if (directory === null) return null;
    let file;
    try {
      file = await open(resolve(directory, variant), constants.O_RDONLY | constants.O_NOFOLLOW);
    } catch (error) {
      if (missing(error)) return null;
      throw error;
    }
    try {
      const info = await file.stat();
      if (!info.isFile() || info.nlink !== 1) throw new Error('Invalid local media object');
      if (info.size > this.options.maxObjectBytes) throw new RangeError('Local media object exceeds its byte limit');
      return await boundedBytes(file, this.options.maxObjectBytes);
    } finally {
      await file.close();
    }
  }

  put(key: string, bytes: Uint8Array, _options: { mediaType: string }): Promise<void> {
    const { mediaId, variant } = parsedKey(key);
    if (bytes.byteLength > this.options.maxObjectBytes)
      throw new RangeError('Local media object exceeds its byte limit');
    return this.#exclusive(async () => {
      const directory = await checkMediaDirectory(mediaId, true);
      if (directory === null) throw new Error('Local media directory is unavailable');
      const destination = resolve(directory, variant);
      try {
        const existing = await lstat(destination);
        if (!existing.isFile() || existing.isSymbolicLink() || existing.nlink !== 1)
          throw new Error('Invalid local media object');
      } catch (error) {
        if (!missing(error)) throw error;
      }
      const temporary = resolve(directory, `.${variant}.${randomUUID()}.tmp`);
      let file: Awaited<ReturnType<typeof open>> | undefined;
      let published = false;
      try {
        file = await open(
          temporary,
          constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
          0o600,
        );
        await file.writeFile(bytes);
        await file.sync();
        await file.close();
        file = undefined;
        await rename(temporary, destination);
        published = true;
      } finally {
        if (file) await file.close();
        if (!published) await rm(temporary, { force: true });
      }
    });
  }

  deletePrefix(prefix: string): Promise<void> {
    const mediaId = parsedPrefix(prefix);
    return this.#exclusive(async () => {
      const directory = await checkMediaDirectory(mediaId, false);
      if (directory === null) return;
      await rm(directory, { recursive: true });
    });
  }

  async #exclusive<T>(operation: () => Promise<T>): Promise<T> {
    let release!: () => void;
    const next = new Promise<void>((resolveTurn) => {
      release = resolveTurn;
    });
    const previous = this.#tail;
    this.#tail = previous.then(() => next);
    await previous;
    try {
      return await operation();
    } finally {
      release();
    }
  }
}

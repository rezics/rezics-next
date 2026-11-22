import type { VisualNovelInspection, VisualNovelLaunchEvidence } from '@rezics/launcher-contract';
import { constants } from 'node:fs';
import { open } from 'node:fs/promises';
import { fileInfo } from './storage.ts';

export const metadataByteLimit = 65_536;
export const quotedMetadataString = /(?:"((?:[^"\\]|\\["'\\])*)"|'((?:[^'\\]|\\["'\\])*)')/.source;

export type LocalVisualNovelInspection = {
  metadata: VisualNovelInspection;
  packageDirectories: readonly string[];
  launchEvidence?: VisualNovelLaunchEvidence;
};

export function unknownVisualNovel(): LocalVisualNovelInspection {
  return { metadata: { engine: 'unknown' }, packageDirectories: [] };
}

export type MetadataReader = {
  size: number;
  read(offset: number, length: number): Promise<Buffer>;
};

export function displayMetadata(input: unknown) {
  if (typeof input !== 'string') return;
  const value = input.trim();
  if (value && value.length <= 120 && !/[\p{Cc}]/u.test(value)) return value;
}

export async function withMetadataReader<T>(
  path: string,
  inspect: (reader: MetadataReader) => Promise<T>,
): Promise<T | undefined> {
  try {
    const item = await fileInfo(path);
    if (!item?.isFile()) return;

    const flags = constants.O_RDONLY | (process.platform === 'win32' ? 0 : constants.O_NONBLOCK | constants.O_NOFOLLOW);
    const file = await open(path, flags);
    try {
      const opened = await file.stat();
      if (!opened.isFile() || opened.dev !== item.dev || opened.ino !== item.ino || !Number.isSafeInteger(opened.size))
        return;
      return await inspect({
        size: opened.size,
        async read(offset, length) {
          const buffer = Buffer.alloc(Math.max(0, Math.min(length, opened.size - offset)));
          let read = 0;
          while (read < buffer.length) {
            const { bytesRead } = await file.read(buffer, read, buffer.length - read, offset + read);
            if (!bytesRead) break;
            read += bytesRead;
          }
          return buffer.subarray(0, read);
        },
      });
    } finally {
      await file.close();
    }
  } catch (error) {
    const code = error && typeof error === 'object' && 'code' in error ? error.code : undefined;
    if (code !== 'ENOENT' && code !== 'ENOTDIR' && code !== 'ELOOP' && code !== 'EACCES' && code !== 'EPERM')
      throw error;
  }
}

export function readMetadataBytes(path: string) {
  return withMetadataReader(path, async (reader) => {
    if (reader.size > metadataByteLimit) return;
    const bytes = await reader.read(0, reader.size);
    if (bytes.length === reader.size) return { bytes, size: reader.size };
  });
}

export function metadataText(bytes: Buffer, encoding: string) {
  try {
    return new TextDecoder(encoding, { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
  }
}

import type { Buffer } from 'node:buffer';
import { once } from 'node:events';
import { close, constants, open } from 'node:fs';
import { addAbortSignal } from 'node:stream';
import { buffer } from 'node:stream/consumers';
import { promisify } from 'node:util';
import { fromFdPromise, type Entry, type ZipFile } from 'yauzl';

const openFile = promisify(open);
const closeFile = promisify(close);
const fileFlags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);

export async function withZipFile<T>(file: string, read: (zip: ZipFile, descriptor: number) => Promise<T>): Promise<T> {
  const descriptor = await openFile(file, fileFlags);
  let zip: ZipFile | undefined;
  try {
    zip = await fromFdPromise(descriptor, { autoClose: false, strictFileNames: true, validateEntrySizes: true });
    return await read(zip, descriptor);
  } finally {
    if (zip) {
      const closed = once(zip, 'close');
      zip.close();
      await closed;
    } else {
      await closeFile(descriptor);
    }
  }
}

export async function readZipEntry(zip: ZipFile, entry: Entry, limit: number, signal?: AbortSignal): Promise<Buffer> {
  signal?.throwIfAborted();
  if (entry.uncompressedSize > limit) throw new Error('The ZIP entry exceeds its read limit.');
  const stream = await zip.openReadStreamPromise(entry);
  return buffer(signal ? addAbortSignal(signal, stream) : stream);
}

import { createHash } from 'node:crypto';
import type { FileHandle } from 'node:fs/promises';
import type { SourceRecord } from '@rezics/conversion';
import {
  DumpInputError,
  fileChunks,
  openLibraryMetadata,
  openRegularFile,
  ownedChunks,
  throwIfAborted,
  type DumpByteProgress,
  type DumpInputObserver,
} from './dump-input.ts';
import { createDumpCounters, type DumpCounters } from './dumps-bytes.ts';
import { readDump } from './dumps.ts';
import { OpenLibraryDumpSetError, type OpenLibraryDumpSetAdmission } from './open-library-dump-set.ts';

export type OpenLibraryDumpSetStreamOptions = Readonly<{
  signal: AbortSignal;
  handleCount: { value: number };
  observer?: DumpInputObserver;
  progress?: DumpByteProgress;
  counters?: DumpCounters;
  maxRecordBytes?: number;
  maxChunkBytes?: number;
}>;

export type OpenLibraryDumpSetStream = Readonly<{
  records: AsyncIterable<SourceRecord>;
  consumedBytes(): number;
  /** SHA-256 of each member's consumed bytes followed by its 8-byte length, in manifest order. */
  digestHex(): string | null;
}>;

function failMember(index: number, reason: string): never {
  throw new OpenLibraryDumpSetError(reason, index);
}

function lengthPrefix(bytes: number): Uint8Array {
  const prefix = new Uint8Array(8);
  const view = new DataView(prefix.buffer);
  view.setBigUint64(0, BigInt(bytes));
  return prefix;
}

async function closeHandle(handle: FileHandle | undefined, handleCount: { value: number }): Promise<void> {
  if (!handle) return;
  try {
    await handle.close();
  } catch {
    // Preserve the original framing, cancellation or staging failure.
  } finally {
    handleCount.value--;
  }
}

/**
 * Compose one production decoder/metadata adapter per admitted member into a
 * single record iterator. Each member keeps its own line/UTF-8 decoder; EOF
 * ends that member's last record even without a trailing newline.
 */
export function readOpenLibraryDumpSet(
  admission: OpenLibraryDumpSetAdmission,
  options: OpenLibraryDumpSetStreamOptions,
): OpenLibraryDumpSetStream {
  const counters = options.counters ?? createDumpCounters();
  const hash = createHash('sha256');
  let consumed = 0;
  let digest: string | null = null;
  const records = (async function* (): AsyncGenerator<SourceRecord> {
    throwIfAborted(options.signal);
    try {
      for (const member of admission.members) {
        throwIfAborted(options.signal);
        let handle: FileHandle | undefined;
        let memberBytes = 0;
        try {
          try {
            handle = await openRegularFile(member.path, options.handleCount);
          } catch (error) {
            if (error instanceof OpenLibraryDumpSetError) throw error;
            failMember(member.index, 'unavailable');
          }
          const hashed = (async function* (): AsyncGenerator<Uint8Array> {
            for await (const chunk of ownedChunks(
              fileChunks(handle!, options.signal),
              options.signal,
              'dump',
              options.observer,
              true,
              options.progress,
            )) {
              hash.update(chunk);
              memberBytes += chunk.byteLength;
              consumed += chunk.byteLength;
              yield chunk;
            }
          })();
          const native = openLibraryMetadata(hashed, options.signal);
          try {
            for await (const record of readDump('openlibrary', native, {
              ...(options.maxRecordBytes === undefined ? {} : { maxRecordBytes: options.maxRecordBytes }),
              ...(options.maxChunkBytes === undefined ? {} : { maxChunkBytes: options.maxChunkBytes }),
              counters,
              openLibraryFamily: member.family,
            })) {
              throwIfAborted(options.signal);
              yield record;
            }
          } catch (error) {
            if (error instanceof OpenLibraryDumpSetError) throw error;
            if (options.signal.aborted) throw options.signal.reason ?? new DOMException('Import interrupted', 'AbortError');
            failMember(member.index, 'framing');
          }
          hash.update(lengthPrefix(memberBytes));
        } finally {
          await closeHandle(handle, options.handleCount);
        }
      }
      digest = hash.digest('hex');
    } catch (error) {
      if (error instanceof OpenLibraryDumpSetError) throw error;
      if (options.signal.aborted || (error instanceof DOMException && error.name === 'AbortError')) throw error;
      throw error instanceof DumpInputError ? error : new OpenLibraryDumpSetError('unavailable');
    }
  })();
  return {
    records,
    consumedBytes: () => consumed,
    digestHex: () => digest,
  };
}

import { createHash } from 'node:crypto';
import { constants } from 'node:fs';
import { mkdir, open, rename, rm, stat, type FileHandle } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { StateBackupFailure } from './state-backup-errors.ts';

export const COPY_BUFFER_BYTES = 64 * 1024;
export const MAX_MANIFEST_BYTES = 16 * 1024;
export const SNAPSHOT_DATABASE_NAME = 'importer-state.sqlite';
export const SNAPSHOT_MANIFEST_NAME = 'snapshot.json';
const STAGED_DATABASE_NAME = 'importer-state.sqlite.part';
const STAGED_MANIFEST_NAME = 'snapshot.json.part';

export type FileIdentity = Readonly<{ path: string; handle: FileHandle; dev: number; ino: number; size: number }>;
export type TransferObserver = Readonly<{
  onBuffer?(bytes: number): void;
  onHashedBytes?(total: number): void;
  onCopiedBytes?(total: number): void;
}>;

function roleError(role: string, detail: string, status: StateBackupFailure['status'] = 'unsafe-file'): never {
  throw new StateBackupFailure(`${role}: ${detail}`, status);
}

export function sameIdentity(left: { dev: number; ino: number }, right: { dev: number; ino: number }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

export function throwIfAborted(signal: AbortSignal | undefined): void {
  if (signal?.aborted) throw new StateBackupFailure('Stopped-state snapshot work was cancelled.', 'cancelled');
}

export async function admitRegularFile(path: string, role: string): Promise<FileIdentity> {
  const resolved = resolve(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0));
    const identity = await handle.stat();
    if (!identity.isFile()) roleError(role, 'path is not a regular file.');
    const after = await stat(resolved);
    if (!after.isFile() || !sameIdentity(identity, after) || identity.size !== after.size)
      roleError(role, 'path changed while it was being opened.');
    const admitted = { path: resolved, handle, dev: identity.dev, ino: identity.ino, size: identity.size };
    handle = undefined;
    return admitted;
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof StateBackupFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') roleError(role, 'file does not exist.');
    if (code === 'ELOOP') roleError(role, 'path must not be a symbolic link.');
    if (code === 'ENXIO' || code === 'EAGAIN' || code === 'ENOTSUP')
      roleError(role, 'path is a special file and cannot be used as importer state.');
    roleError(role, code ? `unable to open (${code}).` : 'unable to open.');
  }
}

export async function admitExistingDirectory(
  path: string,
  role: string,
): Promise<{ path: string; dev: number; ino: number }> {
  const resolved = resolve(path);
  let handle: FileHandle | undefined;
  try {
    handle = await open(resolved, constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_DIRECTORY ?? 0));
    const identity = await handle.stat();
    if (!identity.isDirectory()) roleError(role, 'path is not a directory.');
    const after = await stat(resolved);
    if (!after.isDirectory() || !sameIdentity(identity, after))
      roleError(role, 'path changed while it was being opened.');
    await handle.close();
    handle = undefined;
    return { path: resolved, dev: identity.dev, ino: identity.ino };
  } catch (error) {
    await handle?.close().catch(() => {});
    if (error instanceof StateBackupFailure) throw error;
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'ENOENT') roleError(role, 'directory does not exist.');
    if (code === 'ELOOP') roleError(role, 'path must not be a symbolic link.');
    if (code === 'ENOTDIR') roleError(role, 'path is not a directory.');
    roleError(role, code ? `unable to open (${code}).` : 'unable to open.');
  }
}

export async function refuseExistingDestination(path: string, role: string): Promise<string> {
  const resolved = resolve(path);
  try {
    await stat(resolved);
    roleError(role, 'destination already exists and will not be replaced.');
  } catch (error) {
    if (error instanceof StateBackupFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return resolved;
    roleError(role, 'destination cannot be used.');
  }
}

export async function createPrivateDirectory(path: string, role: string): Promise<string> {
  const resolved = await refuseExistingDestination(path, role);
  const parent = dirname(resolved);
  try {
    const parentStat = await stat(parent);
    if (!parentStat.isDirectory()) roleError(role, 'parent path is not a directory.');
  } catch (error) {
    if (error instanceof StateBackupFailure) throw error;
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') roleError(role, 'parent directory does not exist.');
    roleError(role, 'parent directory cannot be used.');
  }
  try {
    await mkdir(resolved, { recursive: false, mode: 0o700 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'EEXIST')
      roleError(role, 'destination already exists and will not be replaced.');
    roleError(role, 'unable to create destination directory.', 'failed-output');
  }
  return resolved;
}

export async function createExclusiveFile(path: string, role: string): Promise<FileHandle> {
  try {
    return await open(path, constants.O_RDWR | constants.O_CREAT | constants.O_EXCL, 0o600);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === 'EEXIST') roleError(role, 'destination already exists and will not be replaced.');
    roleError(
      role,
      code ? `unable to create exclusive file (${code}).` : 'unable to create exclusive file.',
      'failed-output',
    );
  }
}

export async function fsyncPath(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY);
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function fsyncDirectory(path: string): Promise<void> {
  const handle = await open(path, constants.O_RDONLY | (constants.O_DIRECTORY ?? 0));
  try {
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function hashHandle(
  handle: FileHandle,
  expectedBytes: number | undefined,
  signal: AbortSignal | undefined,
  observer?: TransferObserver,
): Promise<{ bytes: number; sha256: string }> {
  throwIfAborted(signal);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  observer?.onBuffer?.(buffer.byteLength);
  let offset = 0;
  for (;;) {
    throwIfAborted(signal);
    const read = await handle.read(buffer, 0, buffer.byteLength, offset);
    if (read.bytesRead === 0) break;
    hash.update(buffer.subarray(0, read.bytesRead));
    offset += read.bytesRead;
    observer?.onHashedBytes?.(offset);
  }
  if (expectedBytes !== undefined && offset !== expectedBytes)
    throw new StateBackupFailure('Snapshot database size does not match its manifest.', 'mismatched');
  return { bytes: offset, sha256: hash.digest('hex') };
}

export async function copyHandle(
  source: FileHandle,
  destination: FileHandle,
  signal: AbortSignal | undefined,
  observer?: TransferObserver,
): Promise<{ bytes: number; sha256: string }> {
  throwIfAborted(signal);
  const hash = createHash('sha256');
  const buffer = Buffer.alloc(COPY_BUFFER_BYTES);
  observer?.onBuffer?.(buffer.byteLength);
  let offset = 0;
  for (;;) {
    throwIfAborted(signal);
    const read = await source.read(buffer, 0, buffer.byteLength, offset);
    if (read.bytesRead === 0) break;
    const slice = buffer.subarray(0, read.bytesRead);
    hash.update(slice);
    const written = await destination.write(slice, 0, slice.byteLength, offset);
    if (written.bytesWritten !== slice.byteLength)
      throw new StateBackupFailure('Failed to write the restored state file.', 'failed-output');
    offset += slice.byteLength;
    observer?.onCopiedBytes?.(offset);
    observer?.onHashedBytes?.(offset);
  }
  await destination.sync();
  return { bytes: offset, sha256: hash.digest('hex') };
}

export async function readBoundedUtf8(handle: FileHandle, limit: number, role: string): Promise<string> {
  const identity = await handle.stat();
  if (identity.size > limit) roleError(role, 'file exceeds the bounded manifest size.', 'corrupt');
  const buffer = Buffer.alloc(Number(identity.size));
  const read = await handle.read(buffer, 0, buffer.byteLength, 0);
  if (read.bytesRead !== buffer.byteLength) roleError(role, 'file could not be read completely.', 'truncated');
  try {
    return buffer.toString('utf8');
  } catch {
    roleError(role, 'file is not valid UTF-8.', 'corrupt');
  }
}

export async function writeExclusiveUtf8(path: string, bytes: string, role: string): Promise<void> {
  const handle = await createExclusiveFile(path, role);
  try {
    const payload = Buffer.from(bytes, 'utf8');
    const written = await handle.write(payload, 0, payload.byteLength, 0);
    if (written.bytesWritten !== payload.byteLength)
      throw new StateBackupFailure(`${role}: failed to write completely.`, 'failed-output');
    await handle.sync();
  } finally {
    await handle.close();
  }
}

export async function publishSnapshotFiles(directory: string): Promise<void> {
  await rename(`${directory}/${STAGED_DATABASE_NAME}`, `${directory}/${SNAPSHOT_DATABASE_NAME}`);
  await fsyncDirectory(directory);
  await rename(`${directory}/${STAGED_MANIFEST_NAME}`, `${directory}/${SNAPSHOT_MANIFEST_NAME}`);
  await fsyncDirectory(directory);
}

export function stagedDatabasePath(directory: string): string {
  return `${directory}/${STAGED_DATABASE_NAME}`;
}

export function stagedManifestPath(directory: string): string {
  return `${directory}/${STAGED_MANIFEST_NAME}`;
}

export function snapshotDatabasePath(directory: string): string {
  return `${directory}/${SNAPSHOT_DATABASE_NAME}`;
}

export function snapshotManifestPath(directory: string): string {
  return `${directory}/${SNAPSHOT_MANIFEST_NAME}`;
}

export async function removeIncompleteDestination(directory: string): Promise<void> {
  await rm(directory, { recursive: true, force: true });
}

export function parseExactJsonObject(text: string, role: string): Record<string, unknown> {
  const trimmed = text.trim();
  if (!trimmed) roleError(role, 'file is empty.', 'truncated');
  let value: unknown;
  try {
    value = JSON.parse(trimmed);
  } catch {
    roleError(role, 'file is not valid JSON.', 'corrupt');
  }
  if (!value || typeof value !== 'object' || Array.isArray(value))
    roleError(role, 'file is not a JSON object.', 'corrupt');
  const extra = text.slice(text.indexOf(trimmed) + trimmed.length);
  if (/[^\s]/.test(extra)) roleError(role, 'file contains trailing data.', 'corrupt');
  return value as Record<string, unknown>;
}

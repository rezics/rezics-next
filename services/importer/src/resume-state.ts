import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';
import { assertExistingRunSchema } from './run-store.ts';

export type ResumeStateKind = 'missing' | 'unavailable' | 'busy-lock';

/** Opening an existing importer state failed without creating a replacement file. */
export class ResumeStateError extends Error {
  readonly kind: ResumeStateKind;
  constructor(kind: ResumeStateKind, message: string) {
    super(message);
    this.name = 'ResumeStateError';
    this.kind = kind;
  }
}

export type ExistingImporterState = Readonly<{
  path: string;
  database: Database;
  descriptor: FileHandle;
}>;

function sameFile(left: { dev: number | bigint; ino: number | bigint }, right: { dev: number | bigint; ino: number | bigint }): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

function sqliteBusy(error: unknown): boolean {
  const code = (error as NodeJS.ErrnoException)?.code;
  return (
    code === 'SQLITE_BUSY' ||
    code === 'SQLITE_LOCKED' ||
    (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error.message))
  );
}

function sqliteMalformed(error: unknown): boolean {
  return (
    error instanceof Error && /not a database|unable to open database|database disk image is malformed/i.test(error.message)
  );
}

/** Refuse to create a database; pin the opened inode for the writable resume session. */
export async function openExistingImporterState(statePath: string): Promise<ExistingImporterState> {
  const path = resolve(statePath);
  let descriptor: FileHandle | undefined;
  let database: Database | undefined;
  try {
    const flags = constants.O_RDWR | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    descriptor = await open(path, flags);
    const identity = await descriptor.stat();
    if (!identity.isFile()) throw new ResumeStateError('unavailable', 'Importer state path is not a regular file.');
    database = new Database(path, { create: false, strict: true });
    const afterOpen = await stat(path);
    if (!sameFile(identity, afterOpen))
      throw new ResumeStateError('unavailable', 'Importer state path changed while it was being opened.');
    try {
      assertExistingRunSchema(database);
    } catch (error) {
      if (error instanceof Error && error.message.startsWith('Importer state schema is missing'))
        throw new ResumeStateError('unavailable', error.message);
      throw error;
    }
    const opened = { path, database, descriptor };
    database = undefined;
    descriptor = undefined;
    return opened;
  } catch (error) {
    database?.close();
    await descriptor?.close().catch(() => {});
    if (error instanceof ResumeStateError) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new ResumeStateError('missing', 'Importer state database does not exist.');
    if (code === 'ELOOP') throw new ResumeStateError('unavailable', 'Importer state path must not be a symbolic link.');
    if (sqliteBusy(error))
      throw new ResumeStateError('busy-lock', 'Importer state database is busy or locked.');
    if (sqliteMalformed(error) || code === 'SQLITE_CANTOPEN' || code === 'SQLITE_NOTADB')
      throw new ResumeStateError('unavailable', 'Importer state is not a supported SQLite database.');
    throw new ResumeStateError(
      'unavailable',
      `Unable to open importer state${code ? ` (${code})` : ''}.`,
    );
  }
}

export async function closeExistingImporterState(state: ExistingImporterState): Promise<void> {
  try {
    state.database.close();
  } catch {
    // The session constructor may already have closed this handle.
  } finally {
    await state.descriptor.close().catch(() => {});
  }
}

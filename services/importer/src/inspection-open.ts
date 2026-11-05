import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { open, stat, type FileHandle } from 'node:fs/promises';
import { resolve } from 'node:path';

export class InspectionFailure extends Error {
  constructor(
    message: string,
    readonly code: number = 1,
  ) {
    super(message);
  }
}

export type ReadonlySqlite = Readonly<{
  path: string;
  descriptor: FileHandle;
  database: Database;
}>;

export type OpenReadonlySqliteOptions = Readonly<{
  instrumentDatabase?: (database: Database) => Database;
}>;

function sameFile(
  left: Awaited<ReturnType<FileHandle['stat']>>,
  right: Awaited<ReturnType<FileHandle['stat']>>,
): boolean {
  return left.dev === right.dev && left.ino === right.ino;
}

/** Open an existing regular file as a read-only SQLite database. Never creates, migrates or writes. */
export async function openReadonlySqlite(
  statePath: string,
  options: OpenReadonlySqliteOptions = {},
): Promise<ReadonlySqlite> {
  const path = resolve(statePath);
  let descriptor: FileHandle | undefined;
  let database: Database | undefined;
  try {
    const flags = constants.O_RDONLY | (constants.O_NOFOLLOW ?? 0) | (constants.O_NONBLOCK ?? 0);
    descriptor = await open(path, flags);
    const identity = await descriptor.stat();
    if (!identity.isFile())
      throw new InspectionFailure(`State path is not a regular file: ${JSON.stringify(path)}.`, 2);
    database = new Database(path, { readonly: true, create: false, strict: true });
    if (options.instrumentDatabase) database = options.instrumentDatabase(database);
    const afterOpen = await stat(path);
    if (!sameFile(identity, afterOpen)) throw new InspectionFailure('State path changed while it was being opened.', 2);
    const opened = { path, descriptor, database };
    descriptor = undefined;
    database = undefined;
    return opened;
  } catch (error) {
    database?.close();
    await descriptor?.close().catch(() => {});
    if (error instanceof InspectionFailure) throw error;
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === 'ENOENT') throw new InspectionFailure(`State file does not exist: ${JSON.stringify(path)}.`, 2);
    if (code === 'ELOOP')
      throw new InspectionFailure(`State path must not be a symbolic link: ${JSON.stringify(path)}.`, 2);
    if (
      code === 'SQLITE_BUSY' ||
      code === 'SQLITE_LOCKED' ||
      (error instanceof Error && /SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(error.message))
    )
      throw new InspectionFailure('State database is busy or locked; retry the local inspection.', 1);
    if (
      error instanceof Error &&
      /not a database|unable to open database|database disk image is malformed/i.test(error.message)
    )
      throw new InspectionFailure(
        `State file is not a supported readable SQLite database: ${JSON.stringify(path)}.`,
        2,
      );
    throw new InspectionFailure(`Unable to open state file ${JSON.stringify(path)}${code ? ` (${code})` : ''}.`, 2);
  }
}

export async function closeReadonlySqlite(opened: Pick<ReadonlySqlite, 'database' | 'descriptor'>): Promise<void> {
  try {
    opened.database.close();
  } catch {
    // Continue closing the descriptor even if SQLite reports a close failure.
  } finally {
    await opened.descriptor.close().catch(() => {});
  }
}

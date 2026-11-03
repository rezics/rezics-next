import { Database } from 'bun:sqlite';
import { constants } from 'node:fs';
import { chmod, open, rm, stat } from 'node:fs/promises';
import { StateBackupFailure } from './state-backup-errors.ts';
import {
  admitExistingDirectory,
  admitRegularFile,
  copyHandle,
  createExclusiveFile,
  createPrivateDirectory,
  fsyncPath,
  hashHandle,
  parseExactJsonObject,
  publishSnapshotFiles,
  readBoundedUtf8,
  refuseExistingDestination,
  removeIncompleteDestination,
  sameIdentity,
  snapshotDatabasePath,
  snapshotManifestPath,
  stagedDatabasePath,
  stagedManifestPath,
  throwIfAborted,
  writeExclusiveUtf8,
  MAX_MANIFEST_BYTES,
  type TransferObserver,
} from './state-backup-files.ts';
import {
  integrityWork,
  parseManifest,
  quoteSqlPath,
  readRunBaselines,
  readSqliteCompatibility,
  refuseBusyOwners,
  SCHEMA_COMPATIBILITY,
  SNAPSHOT_FORMAT,
  SNAPSHOT_FORMAT_VERSION,
  validateImporterSchema,
  type RunBaseline,
  type SchemaObserver,
  type SnapshotManifest,
} from './state-backup-schema.ts';

export type BackupObserver = TransferObserver & SchemaObserver;

export type BackupOptions = Readonly<{
  signal?: AbortSignal;
  observer?: BackupObserver;
  now?: () => Date;
}>;

export type BackupDocument = Readonly<{
  version: 1;
  status: 'ready';
  operation: 'backup' | 'validate-snapshot' | 'restore';
  snapshot?: string;
  state?: string;
  createdAt?: string;
  bytes: number;
  sha256: string;
  sqliteCompatibility: SnapshotManifest['sqliteCompatibility'];
  integrityPages?: number;
  runs: readonly RunBaseline[];
  resume: string;
}>;

function resumeText(statePath: string, runs: readonly RunBaseline[]): string {
  const source = runs[0]?.source;
  const alias = source ? ` --source-alias ${JSON.stringify(source)}` : '';
  return `Restoring local state cannot undo native writes made after this snapshot, revoke receipts, retract a selected fact or guarantee that an older source dump is safe. Stop the original importer and use one state lineage. Next ordinary import: bun services/importer/src/cli.ts --source <original-source-kind>${alias} --dump <complete-input-path> --state ${JSON.stringify(statePath)} --api <https-origin> --account-key <path> --account <uuid> --client <client-id> --auth <https-origin>`;
}

function openStateDatabase(path: string, observer?: BackupObserver): Database {
  try {
    const database = new Database(path, { readonly: true, create: false, strict: true });
    observer?.onSql?.('open');
    return database;
  } catch (error) {
    const message = error instanceof Error ? error.message : '';
    if (/not a database|unable to open database|database disk image is malformed/i.test(message))
      throw new StateBackupFailure('State file is not a supported readable SQLite database.', 'incompatible');
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message))
      throw new StateBackupFailure('State database is busy or locked.', 'busy');
    throw new StateBackupFailure('Unable to open the state database.', 'unsafe-file');
  }
}

function prepareSource(path: string, observer?: BackupObserver): Database {
  const database = openStateDatabase(path, observer);
  try {
    validateImporterSchema(database, observer);
    refuseBusyOwners(database, observer);
    return database;
  } catch (error) {
    database.close();
    if (error instanceof StateBackupFailure) throw error;
    throw new StateBackupFailure('Unable to establish importer schema or owner safety.', 'incompatible');
  }
}

function snapshotSource(database: Database, destination: string, observer?: BackupObserver): void {
  observer?.onSql?.('VACUUM INTO');
  try {
    database.exec(`VACUUM INTO ${quoteSqlPath(destination)}`);
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    const message = error instanceof Error ? error.message : '';
    if (/SQLITE_BUSY|SQLITE_LOCKED|database is locked|database is busy/i.test(message))
      throw new StateBackupFailure('State database is busy or locked.', 'busy');
    throw new StateBackupFailure(
      code ? `Failed to write the snapshot database (${code}).` : 'Failed to write the snapshot database.',
      'failed-output',
    );
  }
}

export async function backupStoppedState(
  input: { state: string; output: string },
  options: BackupOptions = {},
): Promise<BackupDocument> {
  throwIfAborted(options.signal);
  const source = await admitRegularFile(input.state, 'State file');
  let directory: string | undefined;
  let published = false;
  let database: Database | undefined;
  try {
    const output = await createPrivateDirectory(input.output, 'Snapshot directory');
    directory = output;
    if (sameIdentity(source, await stat(output)))
      throw new StateBackupFailure('State file and snapshot directory resolve to the same path.', 'unsafe-file');
    const staged = stagedDatabasePath(output);
    const stagedHandle = await createExclusiveFile(staged, 'Snapshot database');
    await stagedHandle.close();
    const afterOpen = await stat(source.path);
    if (!sameIdentity(source, afterOpen))
      throw new StateBackupFailure('State file changed while it was being opened.', 'unsafe-file');
    database = prepareSource(source.path, options.observer);
    throwIfAborted(options.signal);
    snapshotSource(database, staged, options.observer);
    await fsyncPath(staged);
    throwIfAborted(options.signal);
    const hashHandleFile = await open(staged, constants.O_RDONLY);
    try {
      const digest = await hashHandle(hashHandleFile, undefined, options.signal, options.observer);
      const sqliteCompatibility = readSqliteCompatibility(database, options.observer);
      const runs = readRunBaselines(database, options.observer);
      const manifest: SnapshotManifest = {
        version: SNAPSHOT_FORMAT_VERSION,
        format: SNAPSHOT_FORMAT,
        createdAt: (options.now ?? (() => new Date())).toISOString(),
        sqliteCompatibility,
        schemaCompatibility: SCHEMA_COMPATIBILITY,
        content: { file: 'importer-state.sqlite', bytes: digest.bytes, sha256: digest.sha256 },
        runs,
      };
      await writeExclusiveUtf8(stagedManifestPath(output), `${JSON.stringify(manifest)}\n`, 'Snapshot manifest');
      throwIfAborted(options.signal);
      await publishSnapshotFiles(output);
      published = true;
      return {
        version: 1,
        status: 'ready',
        operation: 'backup',
        snapshot: output,
        state: source.path,
        createdAt: manifest.createdAt,
        bytes: digest.bytes,
        sha256: digest.sha256,
        sqliteCompatibility,
        runs,
        resume: resumeText(source.path, runs),
      };
    } finally {
      await hashHandleFile.close();
    }
  } catch (error) {
    if (directory && !published) await removeIncompleteDestination(directory).catch(() => {});
    throw error;
  } finally {
    database?.close();
    await source.handle.close();
  }
}

export async function validateStoppedStateSnapshot(
  input: { snapshot: string },
  options: BackupOptions = {},
): Promise<BackupDocument> {
  throwIfAborted(options.signal);
  const directory = await admitExistingDirectory(input.snapshot, 'Snapshot directory');
  const manifestFile = await admitRegularFile(snapshotManifestPath(directory.path), 'Snapshot manifest');
  const databaseFile = await admitRegularFile(snapshotDatabasePath(directory.path), 'Snapshot database');
  let database: Database | undefined;
  try {
    const text = await readBoundedUtf8(manifestFile.handle, MAX_MANIFEST_BYTES, 'Snapshot manifest');
    const manifest = parseManifest(parseExactJsonObject(text, 'Snapshot manifest'));
    if (databaseFile.size !== manifest.content.bytes)
      throw new StateBackupFailure('Snapshot database size does not match its manifest.', 'mismatched');
    const digest = await hashHandle(databaseFile.handle, manifest.content.bytes, options.signal, options.observer);
    if (digest.sha256 !== manifest.content.sha256)
      throw new StateBackupFailure('Snapshot database digest does not match its manifest.', 'mismatched');
    const afterOpen = await stat(databaseFile.path);
    if (!sameIdentity(databaseFile, afterOpen))
      throw new StateBackupFailure('Snapshot database changed while it was being opened.', 'unsafe-file');
    database = openStateDatabase(databaseFile.path, options.observer);
    validateImporterSchema(database, options.observer);
    const integrity = integrityWork(database, options.observer);
    if (!integrity.ok)
      throw new StateBackupFailure('Snapshot database failed SQLite integrity checking.', 'corrupt');
    refuseBusyOwners(database, options.observer);
    const runs = readRunBaselines(database, options.observer);
    return {
      version: 1,
      status: 'ready',
      operation: 'validate-snapshot',
      snapshot: directory.path,
      createdAt: manifest.createdAt,
      bytes: digest.bytes,
      sha256: digest.sha256,
      sqliteCompatibility: readSqliteCompatibility(database, options.observer),
      integrityPages: integrity.pageCount,
      runs,
      resume: resumeText('<new-state-path>', runs),
    };
  } finally {
    database?.close();
    await databaseFile.handle.close();
    await manifestFile.handle.close();
  }
}

export async function restoreStoppedStateSnapshot(
  input: { snapshot: string; state: string },
  options: BackupOptions = {},
): Promise<BackupDocument> {
  const validated = await validateStoppedStateSnapshot({ snapshot: input.snapshot }, options);
  throwIfAborted(options.signal);
  const destinationPath = await refuseExistingDestination(input.state, 'Restored state file');
  const source = await admitRegularFile(snapshotDatabasePath(validated.snapshot!), 'Snapshot database');
  let created: string | undefined;
  let handle: Awaited<ReturnType<typeof createExclusiveFile>> | undefined;
  try {
    handle = await createExclusiveFile(destinationPath, 'Restored state file');
    created = destinationPath;
    const copied = await copyHandle(source.handle, handle, options.signal, options.observer);
    if (copied.bytes !== validated.bytes || copied.sha256 !== validated.sha256)
      throw new StateBackupFailure('Restored state bytes do not match the selected snapshot.', 'mismatched');
    await handle.close();
    handle = undefined;
    await chmod(destinationPath, 0o600);
    created = undefined;
    return {
      ...validated,
      operation: 'restore',
      state: destinationPath,
      resume: resumeText(destinationPath, validated.runs),
    };
  } catch (error) {
    if (handle) await handle.close().catch(() => {});
    if (created) await rm(created, { force: true }).catch(() => {});
    throw error;
  } finally {
    await source.handle.close();
  }
}

export type { RunBaseline, SnapshotManifest };

import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { existsSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { ImportSession } from '../src/import-session.ts';
import {
  backupStoppedState,
  restoreStoppedStateSnapshot,
  validateStoppedStateSnapshot,
} from '../src/state-backup.ts';
import { StateBackupFailure } from '../src/state-backup-errors.ts';
import { SNAPSHOT_DATABASE_NAME, SNAPSHOT_MANIFEST_NAME } from '../src/state-backup-files.ts';
import type { SourceProjection } from '../src/run-store.ts';

function directory() {
  return mkdtempSync(join(tmpdir(), 'importer-backup-'));
}

function staged(source: string, key: string) {
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      state: 'present' as const,
    },
    projection: {
      sourceKind: 'wikidata' as const,
      normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
    } satisfies SourceProjection,
  };
}

function command(source: string, recordKey: string): BatchCommand {
  return {
    op: 'create',
    key: `cmd-${recordKey}`,
    source: {
      source,
      external_id: recordKey,
      record_revision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      field_group: 'facts',
    },
    subject: { type: 'item', labels: { en: 'Private request body sentinel' } },
  };
}

function stoppedState(dir: string) {
  const path = join(dir, 'state.sqlite');
  const session = new ImportSession(path);
  const baseline = session.store.begin('wikidata');
  if (baseline === 'busy') throw new Error('baseline');
  session.store.stage(baseline, staged('wikidata', 'QBASE'));
  expect(session.store.seal(baseline, { complete: true }).status).toBe('ready');
  session.store.classify(baseline, 'QBASE', { commands: [] });
  session.store.acknowledgeNoEffects(baseline, 'QBASE', { reason: 'no-owned-candidates' });
  expect(session.store.finalize(baseline, 100)).toBe('complete');
  const run = session.store.begin('wikidata');
  if (run === 'busy') throw new Error('active');
  session.store.stage(run, staged('wikidata', 'QBASE'));
  session.store.stage(run, staged('wikidata', 'QNEW'));
  expect(session.store.seal(run, { complete: true }).status).toBe('ready');
  session.store.prepare(run, 'QNEW', { commands: [command('wikidata', 'QNEW')] });
  const pending = session.store.pagePending(run, { limit: 10 });
  const acknowledged = session.store.database
    .query('SELECT record_key FROM run_acknowledged WHERE source=?')
    .all('wikidata');
  session.close();
  return { path, pending, acknowledged, runId: run.id, baselineId: baseline.id };
}

test('VACUUM INTO backup keeps committed WAL, baseline acknowledgements and exact pending bytes', async () => {
  const dir = directory();
  try {
    const fixture = stoppedState(dir);
    const live = new Database(fixture.path);
    live.exec('PRAGMA wal_autocheckpoint=0');
    live.exec('CREATE TABLE IF NOT EXISTS extra_compatible(id INTEGER PRIMARY KEY, note TEXT)');
    live.exec("INSERT INTO extra_compatible(note) VALUES('committed-wal')");
    const wal = `${fixture.path}-wal`;
    expect(statSync(wal).size).toBeGreaterThan(0);
    const ownersBefore = live.query('SELECT source,pid,birth,capability FROM import_owners ORDER BY source').all();
    const envelopesBefore = live
      .query('SELECT record_key,bytes,keys_json FROM run_envelopes WHERE source=? ORDER BY record_key')
      .all('wikidata');
    const output = join(dir, 'snapshot');
    const document = await backupStoppedState({ state: fixture.path, output });
    expect(document.status).toBe('ready');
    expect(document.runs).toEqual([
      expect.objectContaining({
        source: 'wikidata',
        baselineGeneration: fixture.baselineId,
        activeGeneration: fixture.runId,
        ownerRow: 'absent',
      }),
    ]);
    expect(statSync(wal).size).toBeGreaterThan(0);
    expect(live.query('SELECT source,pid,birth,capability FROM import_owners ORDER BY source').all()).toEqual(
      ownersBefore,
    );
    expect(
      live.query('SELECT record_key,bytes,keys_json FROM run_envelopes WHERE source=? ORDER BY record_key').all('wikidata'),
    ).toEqual(envelopesBefore);
    live.close();
    const snapshotDb = join(output, SNAPSHOT_DATABASE_NAME);
    expect(statSync(output).mode & 0o777).toBe(0o700);
    expect(statSync(snapshotDb).mode & 0o777).toBe(0o600);
    expect(statSync(join(output, SNAPSHOT_MANIFEST_NAME)).mode & 0o777).toBe(0o600);
    const copied = new Database(snapshotDb, { readonly: true, create: false });
    expect(copied.query("SELECT note FROM extra_compatible").all()).toEqual([{ note: 'committed-wal' }]);
    expect(copied.query('SELECT record_key FROM run_acknowledged').all()).toEqual([{ record_key: 'QBASE' }]);
    expect(copied.query('SELECT bytes,keys_json FROM run_envelopes WHERE record_key=?').get('QNEW')).toEqual({
      bytes: fixture.pending[0]!.bytes,
      keys_json: JSON.stringify(fixture.pending[0]!.keys),
    });
    copied.close();
    const validated = await validateStoppedStateSnapshot({ snapshot: output });
    expect(validated.sha256).toBe(document.sha256);
    expect(validated.integrityPages).toBeGreaterThan(0);
    const restored = join(dir, 'restored.sqlite');
    const installed = await restoreStoppedStateSnapshot({ snapshot: output, state: restored });
    expect(readFileSync(restored).equals(readFileSync(snapshotDb))).toBe(true);
    expect(installed.resume).toContain(restored);
    expect(installed.resume).toContain('cannot undo native writes');
    const reopened = new ImportSession(restored);
    const active = reopened.store.activeRun('wikidata');
    expect(active?.id).toBe(fixture.runId);
    expect(reopened.store.pagePending(active!, { limit: 10 }).map((row) => row.bytes)).toEqual([
      fixture.pending[0]!.bytes,
    ]);
    reopened.close();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('live and unverifiable owners are busy; a dead owner row remains recoverable', async () => {
  const dir = directory();
  try {
    const path = join(dir, 'state.sqlite');
    const session = new ImportSession(path);
    const run = session.store.begin('wikidata');
    if (run === 'busy') throw new Error('run');
    session.store.stage(run, staged('wikidata', 'Q1'));
    expect(session.store.seal(run, { complete: true }).status).toBe('ready');
    expect(session.acquire('wikidata')).not.toBe('busy');
    await expect(backupStoppedState({ state: path, output: join(dir, 'live') })).rejects.toMatchObject({
      status: 'busy',
      code: 5,
    });
    session.close();
    const db = new Database(path);
    db.exec("INSERT INTO import_owners(source,pid,birth,capability) VALUES('wikidata',1,'not-a-birth','deadbeef')");
    db.close();
    await expect(backupStoppedState({ state: path, output: join(dir, 'unknown') })).rejects.toMatchObject({
      status: 'busy',
    });
    const cleared = new Database(path);
    cleared.exec('DELETE FROM import_owners');
    cleared.exec(
      "INSERT INTO import_owners(source,pid,birth,capability) VALUES('wikidata',99999999,'00000000-0000-0000-0000-000000000000:1','deadbeef')",
    );
    cleared.close();
    const document = await backupStoppedState({ state: path, output: join(dir, 'stopped') });
    expect(document.runs[0]?.ownerRow).toBe('stopped');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('older and foreign databases are incompatible without RunStore migration', async () => {
  const dir = directory();
  try {
    const empty = join(dir, 'empty.sqlite');
    new Database(empty, { create: true }).close();
    await expect(backupStoppedState({ state: empty, output: join(dir, 'empty-out') })).rejects.toMatchObject({
      status: 'incompatible',
    });
    expect(existsSync(join(dir, 'empty-out'))).toBe(false);
    const old = join(dir, 'old.sqlite');
    const db = new Database(old, { create: true });
    db.exec(`CREATE TABLE import_owners(source TEXT PRIMARY KEY, pid INTEGER NOT NULL, birth TEXT NOT NULL, capability TEXT NOT NULL) WITHOUT ROWID`);
    db.exec(`CREATE TABLE run_sources(source TEXT PRIMARY KEY, sequence INTEGER NOT NULL, lease_run TEXT, generation TEXT, present_count INTEGER NOT NULL) WITHOUT ROWID`);
    db.close();
    await expect(backupStoppedState({ state: old, output: join(dir, 'old-out') })).rejects.toBeInstanceOf(
      StateBackupFailure,
    );
    expect(existsSync(join(dir, 'old-out'))).toBe(false);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('cancellation removes incomplete output and keeps a completed snapshot', async () => {
  const dir = directory();
  try {
    const fixture = stoppedState(dir);
    const completed = join(dir, 'completed');
    await backupStoppedState({ state: fixture.path, output: completed });
    const aborted = new AbortController();
    aborted.abort();
    await expect(
      restoreStoppedStateSnapshot({ snapshot: completed, state: join(dir, 'nope.sqlite') }, { signal: aborted.signal }),
    ).rejects.toMatchObject({ status: 'cancelled', code: 130 });
    expect(existsSync(join(completed, SNAPSHOT_MANIFEST_NAME))).toBe(true);
    const cancelling = new AbortController();
    await expect(
      backupStoppedState(
        { state: fixture.path, output: join(dir, 'partial') },
        {
          signal: cancelling.signal,
          observer: {
            onHashedBytes() {
              cancelling.abort();
            },
          },
        },
      ),
    ).rejects.toMatchObject({ status: 'cancelled' });
    expect(existsSync(join(dir, 'partial'))).toBe(false);
    expect(existsSync(fixture.path)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('corrupt and mismatched snapshots are refused without rewriting them', async () => {
  const dir = directory();
  try {
    const fixture = stoppedState(dir);
    const output = join(dir, 'snap');
    await backupStoppedState({ state: fixture.path, output });
    const dbPath = join(output, SNAPSHOT_DATABASE_NAME);
    const original = readFileSync(dbPath);
    writeFileSync(dbPath, original.subarray(0, 64));
    await expect(validateStoppedStateSnapshot({ snapshot: output })).rejects.toMatchObject({ status: 'mismatched' });
    const manifest = JSON.parse(readFileSync(join(output, SNAPSHOT_MANIFEST_NAME), 'utf8')) as { content: { sha256: string } };
    expect(manifest.content.sha256).toHaveLength(64);
    writeFileSync(dbPath, original);
    const parsed = JSON.parse(readFileSync(join(output, SNAPSHOT_MANIFEST_NAME), 'utf8')) as Record<string, unknown>;
    parsed.content = { ...(parsed.content as object), sha256: 'a'.repeat(64) };
    writeFileSync(join(output, SNAPSHOT_MANIFEST_NAME), `${JSON.stringify(parsed)}\n`);
    await expect(validateStoppedStateSnapshot({ snapshot: output })).rejects.toMatchObject({ status: 'mismatched' });
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

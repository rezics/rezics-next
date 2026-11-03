import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, statSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { ImportSession } from '../src/import-session.ts';
import { backupStoppedState, restoreStoppedStateSnapshot, validateStoppedStateSnapshot } from '../src/state-backup.ts';
import { COPY_BUFFER_BYTES, SNAPSHOT_MANIFEST_NAME } from '../src/state-backup-files.ts';
import type { SourceProjection } from '../src/run-store.ts';

function command(recordKey: string): BatchCommand {
  return {
    op: 'create',
    key: `cmd-${recordKey}`,
    source: {
      source: 'wikidata',
      external_id: recordKey,
      record_revision: 'revision-1',
      digest: 'a'.repeat(64),
      converter_revision: 'test@1',
      field_group: 'facts',
    },
    subject: { type: 'item', labels: { en: `Title ${recordKey}` }, descriptions: { en: 'x'.repeat(256) } },
  };
}

function seed(path: string, records: number) {
  const session = new ImportSession(path);
  const run = session.store.begin('wikidata');
  if (run === 'busy') throw new Error('run');
  for (let index = 0; index < records; index++) {
    const key = `Q${index}`;
    session.store.stage(run, {
      row: {
        source: 'wikidata',
        recordKey: key,
        recordRevision: 'revision-1',
        digest: 'a'.repeat(64),
        converter_revision: 'test@1',
        state: 'present' as const,
      },
      projection: {
        sourceKind: 'wikidata',
        normalizedRecord: { id: key, type: 'item', labels: {}, descriptions: {}, aliases: {}, claims: {} },
      } satisfies SourceProjection,
    });
  }
  expect(session.store.seal(run, { complete: true }).status).toBe('ready');
  for (let index = 0; index < records; index++) session.store.prepare(run, `Q${index}`, { commands: [command(`Q${index}`)] });
  session.close();
}

test('backup, validate and restore scale with database bytes and keep bounded memory', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'importer-backup-growth-'));
  try {
    const samples = [];
    for (const scale of [32, 64, 128]) {
      const state = join(dir, `state-${scale}.sqlite`);
      seed(state, scale);
      const live = (await import('bun:sqlite')).Database;
      const held = new live(state);
      held.exec('PRAGMA wal_autocheckpoint=0');
      held.exec(`INSERT INTO run_members(source,record_key,active,seen,row_json) VALUES('wikidata','QWAL${scale}',0,0,'{}')`);
      const http = 0;
      let peak = 0;
      let hashed = 0;
      let copied = 0;
      const sql: string[] = [];
      const snapshot = join(dir, `snap-${scale}`);
      const backup = await backupStoppedState(
        { state, output: snapshot },
        {
          observer: {
            onBuffer(bytes) {
              peak = Math.max(peak, bytes);
            },
            onHashedBytes(total) {
              hashed = total;
            },
            onSql(text) {
              sql.push(text);
            },
          },
        },
      );
      const validated = await validateStoppedStateSnapshot(
        { snapshot },
        {
          observer: {
            onBuffer(bytes) {
              peak = Math.max(peak, bytes);
            },
            onSql(text) {
              sql.push(text);
            },
          },
        },
      );
      const restored = join(dir, `restored-${scale}.sqlite`);
      await restoreStoppedStateSnapshot(
        { snapshot, state: restored },
        {
          observer: {
            onBuffer(bytes) {
              peak = Math.max(peak, bytes);
            },
            onCopiedBytes(total) {
              copied = total;
            },
          },
        },
      );
      const owners = held.query('SELECT COUNT(*) AS n FROM import_owners').get() as { n: number };
      held.close();
      samples.push({
        scale,
        hashed,
        copied,
        peak,
        sql: sql.length,
        summaryRows: backup.runs.length,
        manifest: statSync(join(snapshot, SNAPSHOT_MANIFEST_NAME)).size,
        pages: validated.integrityPages,
        http,
        owners,
      });
    }
    expect(samples.map((sample) => sample.summaryRows)).toEqual([1, 1, 1]);
    expect(samples.every((sample) => sample.peak <= COPY_BUFFER_BYTES)).toBe(true);
    expect(samples.every((sample) => sample.http === 0)).toBe(true);
    expect(samples[1]!.hashed).toBeGreaterThan(samples[0]!.hashed);
    expect(samples[2]!.hashed).toBeGreaterThan(samples[1]!.hashed);
    expect(samples[2]!.copied).toBe(samples[2]!.hashed);
    expect(samples[2]!.manifest).toBeLessThan(samples[0]!.hashed);
    expect(samples[2]!.pages).toBeGreaterThanOrEqual(samples[0]!.pages!);
    expect(samples.every((sample) => sample.owners.n === 0)).toBe(true);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

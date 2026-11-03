import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { Importer } from '../src/importer.ts';
import type { ImportTransport } from '../src/import-contract.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import {
  classifyObservation,
  observationDigest,
  parseObservationReason,
  type IntendedObservation,
} from '../src/source-observation.ts';
import { RUN_TABLES, RunStore } from '../src/run-store.ts';
import { parseObservationArgs, runObservationsCli } from '../src/source-observation-cli.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';
const registration = createSourceRegistration('vndb');

function vn(average: number, votes: number, key = 'v123'): SourceRecord {
  return {
    source: 'vndb',
    key,
    revision: '7',
    payload: {
      vn: { id: key, olang: 'en', c_average: average, c_votecount: votes, c_rating: 900 },
      entry_meta: { id: key, revision: 7 },
      vn_titles: [{ id: key, lang: 'en', official: true, title: 'Test visual novel', latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

test('classification distinguishes automatic, identical, equal-date, rebinding and older-date', () => {
  const intended: IntendedObservation = {
    kind: 'write',
    sourceRecordId: 'v123',
    scale: { min: 1, max: 10 },
    mean: 8,
    count: 10,
    asOf: '2026-10-25',
    licence: 'ODbL-1.0',
    attribution: 'VNDB',
  };
  expect(classifyObservation(intended, subjectId, { kind: 'absent' })).toEqual({ action: 'automatic' });
  const digest = observationDigest(subjectId, intended);
  const head = {
    provider: 'vndb' as const,
    sourceAlias: 'vndb',
    sourceRecordId: 'v123',
    asOf: '2026-10-25',
    count: 10,
    scale: { min: 1, max: 10 },
    mean: 8,
    cleared: false,
    digest,
  };
  expect(classifyObservation(intended, subjectId, { kind: 'head', head })).toEqual({ action: 'identical' });
  expect(classifyObservation({ ...intended, mean: 9 }, subjectId, { kind: 'head', head })).toEqual({
    action: 'conflict',
    reason: 'equal-date-correction',
  });
  expect(classifyObservation({ ...intended, sourceRecordId: 'v9' }, subjectId, { kind: 'head', head })).toEqual({
    action: 'conflict',
    reason: 'record-rebinding',
  });
  expect(classifyObservation({ ...intended, asOf: '2026-01-01' }, subjectId, { kind: 'head', head })).toEqual({
    action: 'refused',
    reason: 'older-date',
  });
  expect(parseObservationReason('equal-date-correction')).toBe('equal-date-correction');
});

function resultFor(request: BatchWriteRequest, sequence: { value: number }): BatchWriteResult {
  return {
    results: request.commands.map((command) => {
      sequence.value++;
      if (command.op === 'create') return { key: command.key, status: 201, value: { id: subjectId, revision: 1 } };
      if (command.op === 'propose')
        return {
          key: command.key,
          status: 201,
          value: { candidate: `00000000-0000-4000-8000-${sequence.value.toString().padStart(12, '0')}`, revision: 1 },
        };
      return { key: command.key, status: 200, value: { revision: 1 } };
    }),
  };
}

async function observationFixture() {
  const directory = await mkdtemp(join(tmpdir(), 'observation-'));
  const stored = new Map<string, Record<string, unknown>>();
  const writes: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const sequence = { value: 0 };
  let lost = false;
  const metadata = sourceRecordMetadataFixture();
  const transport = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest) {
      return resultFor(request, sequence);
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async readSourceStatistics(input: { subjectId: string }) {
      const row = stored.get(input.subjectId);
      if (!row || row.cleared) return [];
      return [
        {
          source: 'vndb',
          ...row,
          observation: { kind: 'unversioned', digest: observationDigest(input.subjectId, row as never) },
        },
      ];
    },
    async readPublicFigure(input: { subjectId: string }) {
      const row = stored.get(input.subjectId);
      if (!row || row.cleared) return { count: 0, state: 'insufficient_data', mean: null };
      return { count: row.count as number, state: 'ready', mean: row.mean as number };
    },
    async writeSourceStatistic(input: { subjectId: string; value: Record<string, unknown>; idempotencyKey: string }) {
      writes.push({
        method: 'PUT',
        path: `/v1/subjects/${input.subjectId}/source-statistics/vndb`,
        body: input.value,
        key: input.idempotencyKey,
      });
      if (lost) throw new TypeError('delivery lost');
      const { expectedObservation: _cas, ...value } = input.value;
      stored.set(input.subjectId, value);
      return {
        source: 'vndb',
        ...value,
        observation: { kind: 'unversioned', digest: observationDigest(input.subjectId, value as never) },
      };
    },
    async clearSourceStatistic(input: { subjectId: string; value: Record<string, unknown>; idempotencyKey: string }) {
      writes.push({
        method: 'POST',
        path: `/v1/subjects/${input.subjectId}/source-statistics/vndb:clear`,
        body: input.value,
        key: input.idempotencyKey,
      });
      stored.set(input.subjectId, { ...input.value, cleared: true, count: 0 });
    },
  } as unknown as ImportTransport;
  const importer = new Importer({ path: join(directory, 'state.sqlite'), transport });
  return {
    directory,
    importer,
    stored,
    writes,
    lose() {
      lost = true;
    },
    recover() {
      lost = false;
    },
    run(row: SourceRecord) {
      return importer.runRecords(
        registration,
        (async function* () {
          yield row;
        })(),
      );
    },
    async close() {
      await importer.close();
      await rm(directory, { recursive: true, force: true });
    },
  };
}

test('newer refresh is automatic; equal-date waits; stale resolve is rejected; candidates stay', async () => {
  const f = await observationFixture();
  try {
    f.stored.set(subjectId, {
      sourceRecordId: 'v123',
      scale: { min: 1, max: 10 },
      mean: 5,
      count: 4,
      asOf: '2026-01-01',
      licence: 'ODbL-1.0',
      attribution: 'VNDB',
    });
    expect((await f.run(vn(735, 20))).status).toBe('committed');
    expect(f.stored.get(subjectId)?.mean).toBe(7.35);
    const owner = { source: 'vndb', external_id: 'v123' };
    const candidates = f.importer.session.bindings.candidates(owner, 'facts', { limit: 20 });
    expect((await f.run(vn(812, 25))).status).toBe('observation-conflict');
    expect(f.importer.session.bindings.candidates(owner, 'facts', { limit: 20 })).toEqual(candidates);
    const page = await f.importer.pageObservationConflicts('vndb');
    expect(page.operations).toHaveLength(1);
    const listed = await runObservationsCli(['--state', join(f.directory, 'state.sqlite'), '--source', 'vndb']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(page.operations[0]!.operationId);
    const inspected = page.operations[0]!;
    f.stored.set(subjectId, { ...f.stored.get(subjectId)!, mean: 6.5 });
    expect(await f.importer.resolveObservation('vndb', inspected.operationId, inspected.reviewedHead!.digest)).toEqual({
      status: 'conflict',
      operationId: inspected.operationId,
    });
    const current = (await f.importer.pageObservationConflicts('vndb')).operations[0]!;
    const resolved = await f.importer.resolveObservation('vndb', current.operationId, current.reviewedHead!.digest);
    expect(resolved.status).toBe('delivered');
    expect((f.writes.at(-1)!.body as { expectedObservation: string }).expectedObservation).toBe(
      current.reviewedHead!.digest,
    );
    expect((await f.run(vn(812, 25))).status).toBe('committed');
    expect(f.stored.get(subjectId)?.mean).toBe(8.12);
  } finally {
    await f.close();
  }
});

test('interrupted delivery resumes the sealed body and key; older dates stay refused', async () => {
  const f = await observationFixture();
  try {
    f.lose();
    expect((await f.run(vn(735, 20))).status).toBe('bulk-failed');
    const sealed = f.writes[0]!;
    f.recover();
    expect((await f.run(vn(735, 20))).status).toBe('committed');
    expect(f.writes.at(-1)).toEqual(sealed);
    f.stored.set(subjectId, { ...f.stored.get(subjectId)!, asOf: '2026-12-01' });
    expect((await f.run(vn(800, 20))).status).toBe('observation-conflict');
    const refused = (await f.importer.pageObservationConflicts('vndb')).operations[0]!;
    expect(refused.status).toBe('refused');
    expect(await f.importer.resolveObservation('vndb', refused.operationId, refused.reviewedHead!.digest)).toEqual({
      status: 'refused',
      operationId: refused.operationId,
    });
  } finally {
    await f.close();
  }
});

test('aggregate journal migrates beside existing commands', () => {
  const store = new RunStore(':memory:', { projectionMode: 'source-record' });
  try {
    for (const table of ['run_aggregate_operations', 'run_aggregate_heads'] as const)
      expect(RUN_TABLES).toContain(table);
    const tables = store.database
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('run_commands','run_aggregate_operations')`,
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name).sort()).toEqual(['run_aggregate_operations', 'run_commands']);
  } finally {
    store.close();
  }
});

test('observation CLI rejects malformed, obsolete and resolve-without-review flags', async () => {
  expect(parseObservationArgs(['--help'])).toBe('help');
  expect(() => parseObservationArgs(['--state', 's.sqlite', '--source', 'vndb', '--limit', '21'])).toThrow(
    'integer from 1 through 20',
  );
  expect(() => parseObservationArgs(['--state', 's.sqlite', '--source', 'vndb', '--after', 'zz'])).toThrow(
    '64-hex operation id',
  );
  expect(() =>
    parseObservationArgs(['--state', 's.sqlite', '--source', 'vndb', '--operation', 'a'.repeat(64), '--resolve']),
  ).toThrow('--reviewed-observation');
  const help = await runObservationsCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('independent of a REZICS vote');
});

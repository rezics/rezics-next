import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { Importer } from '../src/importer.ts';
import type { ClassificationAssociation, ImportTransport } from '../src/import-contract.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import {
  classificationAssociationKey,
  classificationObservation,
  classificationOperationDigest,
  classificationPayload,
  classifyClassification,
  parseClassificationReason,
  type IntendedClassification,
} from '../src/source-classification.ts';
import { RUN_TABLES, RunStore } from '../src/run-store.ts';
import { parseClassificationArgs, runClassificationsCli } from '../src/source-classification-cli.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';
const registration = createSourceRegistration('vndb');
const association: ClassificationAssociation = {
  subjectId,
  candidateId: '00000000-0000-4000-8000-000000000201',
  contextId: '00000000-0000-4000-8000-000000000202',
  targetId: '00000000-0000-4000-8000-000000000203',
  property: 'wdt:P136',
  revision: 1,
  release: 'a'.repeat(64),
  qualifiersDigest: 'b'.repeat(64),
};

function vn(key = 'v123'): SourceRecord {
  return {
    source: 'vndb',
    key,
    revision: '7',
    payload: {
      vn: { id: key, olang: 'en', c_average: 735, c_votecount: 20, c_rating: 900 },
      entry_meta: { id: key, revision: 7 },
      vn_titles: [{ id: key, lang: 'en', official: true, title: 'Test visual novel', latin: null }],
      vn_extlinks: [],
      extlinks: [],
    },
  };
}

function admittedFacts(overrides: Record<string, unknown> = {}) {
  return {
    sourceAlias: 'trusted-fixture',
    sourceRecordId: 'v123',
    sourceRevision: '7',
    sourceAssociationId: 'g12',
    converterRevision: 'fixture@1',
    observedAt: '2026-11-03T00:00:00.000Z',
    coverage: { kind: 'unknown' },
    attribution: 'Example classification provider',
    licence: { id: 'Fixture-1.0', url: 'https://example.test/licence' },
    value: { kind: 'observation', confidence: 2.4, lie: false },
    ...overrides,
  };
}

const intendedWrite: IntendedClassification = {
  family: 'classification',
  kind: 'write',
  association,
  sourceAlias: 'trusted-fixture',
  sourceRecordId: 'v123',
  sourceAssociationId: 'g12',
  asOf: '2026-11-03T00:00:00.000Z',
  sourceVersion: { kind: 'revision', revision: '7' },
  attribution: 'Example classification provider',
  licence: 'Fixture-1.0',
  confidence: 2.4,
  lie: false,
};

test('classification distinguishes automatic, identical, equal-date, rebinding and older-date', () => {
  expect(classifyClassification(intendedWrite, { kind: 'absent' })).toEqual({ action: 'automatic' });
  const digest = classificationOperationDigest(intendedWrite);
  expect(digest).toBe(classificationObservation(association, classificationPayload(intendedWrite)).digest);
  const head = {
    associationKey: classificationAssociationKey(association),
    association,
    sourceAlias: 'trusted-fixture',
    sourceRecordId: 'v123',
    sourceAssociationId: 'g12',
    asOf: '2026-11-03T00:00:00.000Z',
    cleared: false,
    digest,
  };
  expect(classifyClassification(intendedWrite, { kind: 'head', head })).toEqual({ action: 'identical' });
  expect(classifyClassification({ ...intendedWrite, confidence: 1.2 }, { kind: 'head', head })).toEqual({
    action: 'conflict',
    reason: 'equal-date-correction',
  });
  expect(classifyClassification({ ...intendedWrite, sourceRecordId: 'v9' }, { kind: 'head', head })).toEqual({
    action: 'conflict',
    reason: 'record-rebinding',
  });
  expect(
    classifyClassification({ ...intendedWrite, asOf: '2026-11-02T00:00:00.000Z' }, { kind: 'head', head }),
  ).toEqual({ action: 'refused', reason: 'older-date' });
  expect(parseClassificationReason('equal-date-correction')).toBe('equal-date-correction');
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

async function classificationFixture(
  options: {
    facts?: unknown;
    association?: ClassificationAssociation | null;
    admit?: boolean;
  } = {},
) {
  const directory = await mkdtemp(join(tmpdir(), 'classification-'));
  const stored = new Map<string, Record<string, unknown>>();
  const writes: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const sequence = { value: 0 };
  let lost = false;
  let facts: unknown = options.facts === undefined ? admittedFacts() : options.facts;
  let bound: ClassificationAssociation | null = options.association === undefined ? association : options.association;
  const metadata = sourceRecordMetadataFixture();
  const transport = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest) {
      return resultFor(request, sequence);
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async readSourceClassifications(input: { subjectId: string; associations: readonly ClassificationAssociation[] }) {
      return input.associations.map((item) => {
        const row = stored.get(`${input.subjectId}:${JSON.stringify(item)}`);
        if (!row) return { state: 'unavailable' as const, reason: 'not_observed' as const };
        return {
          state: 'available' as const,
          value: {
            provider: 'vndb' as const,
            association: item,
            observation: { digest: row.digest as string, sourceVersion: row.sourceVersion },
            sourceAlias: row.sourceAlias as string,
            sourceRecordId: row.sourceRecordId as string,
            sourceAssociationId: row.sourceAssociationId as string,
            asOf: row.asOf as string,
            ageSeconds: 0,
            attribution: (row.attribution as string) ?? 'Example classification provider',
            licence: (row.licence as string) ?? 'Fixture-1.0',
            confidence:
              row.confidence === undefined
                ? { state: 'unavailable' as const, reason: 'not_supplied' as const }
                : {
                    state: 'available' as const,
                    value: row.confidence as number,
                    unit: 'vndb-tag-rating' as const,
                    minExclusive: 0 as const,
                    max: 3 as const,
                  },
            lie:
              row.lie === undefined
                ? { state: 'unavailable' as const, reason: 'not_supplied' as const }
                : { state: 'available' as const, value: row.lie as boolean, unit: 'boolean' as const },
          },
        };
      });
    },
    async writeSourceClassification(input: {
      subjectId: string;
      association: ClassificationAssociation;
      value: Record<string, unknown>;
      expectedObservation: string | null;
      idempotencyKey: string;
    }) {
      writes.push({
        method: 'POST',
        path: `/v1/subjects/${input.subjectId}/source-classifications:put`,
        body: {
          association: input.association,
          expectedObservation: input.expectedObservation,
          value: input.value,
        },
        key: input.idempotencyKey,
      });
      if (lost) throw new TypeError('delivery lost');
      const digest = classificationObservation(input.association, input.value as never).digest;
      stored.set(`${input.subjectId}:${JSON.stringify(input.association)}`, { ...input.value, digest });
      return { observationDigest: digest, state: 'published' as const };
    },
    async clearSourceClassification() {
      throw new TypeError('clear unused');
    },
  } as unknown as ImportTransport;
  const importer = new Importer({
    path: join(directory, 'state.sqlite'),
    transport,
    ...(options.admit === false
      ? {}
      : {
          classificationAdmission: {
            facts: () => facts,
            association: () => bound,
          },
        }),
  });
  return {
    directory,
    importer,
    stored,
    writes,
    setFacts(next: unknown) {
      facts = next;
    },
    setAssociation(next: ClassificationAssociation | null) {
      bound = next;
    },
    lose() {
      lost = true;
    },
    recover() {
      lost = false;
    },
    read() {
      return transport.readSourceClassifications!({ subjectId, associations: [association] });
    },
    run(row: SourceRecord = vn()) {
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

test('admitted classification writes through the converter, binds the association, and is independently readable', async () => {
  const f = await classificationFixture();
  try {
    expect((await f.run()).status).toBe('committed');
    expect(f.writes).toHaveLength(1);
    const body = f.writes[0]!.body as {
      expectedObservation: string | null;
      value: { confidence: number; licence: string; sourceAlias: string };
    };
    expect(body.expectedObservation).toBeNull();
    expect(body.value).toMatchObject({
      sourceAlias: 'trusted-fixture',
      confidence: 2.4,
      licence: 'Fixture-1.0',
    });
    const items = await f.read();
    expect(items).toEqual([
      expect.objectContaining({
        state: 'available',
        value: expect.objectContaining({
          sourceAlias: 'trusted-fixture',
          sourceRecordId: 'v123',
          sourceAssociationId: 'g12',
        }),
      }),
    ]);
  } finally {
    await f.close();
  }
});

test('changed payloads keep sealed intent; stale CAS is rejected; unadmitted licences have no native write', async () => {
  const f = await classificationFixture();
  try {
    expect((await f.run()).status).toBe('committed');
    f.setFacts(admittedFacts({ value: { kind: 'observation', confidence: 1.2, lie: false } }));
    expect((await f.run()).status).toBe('observation-conflict');
    const page = await f.importer.pageClassificationConflicts('vndb');
    expect(page.operations).toHaveLength(1);
    const listed = await runClassificationsCli(['--state', join(f.directory, 'state.sqlite'), '--source', 'vndb']);
    expect(listed.code).toBe(0);
    expect(listed.stdout).toContain(page.operations[0]!.operationId);
    const inspected = page.operations[0]!;
    const storedKey = [...f.stored.keys()][0]!;
    f.stored.set(storedKey, { ...f.stored.get(storedKey)!, digest: 'c'.repeat(64) });
    expect(
      await f.importer.resolveClassification('vndb', inspected.operationId, inspected.reviewedHead!.digest),
    ).toEqual({
      status: 'conflict',
      operationId: inspected.operationId,
    });
    const current = (await f.importer.pageClassificationConflicts('vndb')).operations[0]!;
    const resolved = await f.importer.resolveClassification('vndb', current.operationId, current.reviewedHead!.digest);
    expect(resolved.status).toBe('delivered');
    expect((f.writes.at(-1)!.body as { expectedObservation: string }).expectedObservation).toBe(
      current.reviewedHead!.digest,
    );
    expect((f.writes.at(-1)!.body as { value: { confidence: number } }).value.confidence).toBe(1.2);
  } finally {
    await f.close();
  }
});

test('interrupted delivery resumes the sealed body and key; older dates stay refused', async () => {
  const f = await classificationFixture();
  try {
    f.lose();
    expect((await f.run()).status).toBe('bulk-failed');
    const sealed = f.writes[0]!;
    f.recover();
    expect((await f.run()).status).toBe('committed');
    expect(f.writes.at(-1)).toEqual(sealed);
    f.setFacts(admittedFacts({ observedAt: '2026-11-01T00:00:00.000Z' }));
    expect((await f.run()).status).toBe('observation-conflict');
    const refused = (await f.importer.pageClassificationConflicts('vndb')).operations[0]!;
    expect(refused.status).toBe('refused');
    expect(await f.importer.resolveClassification('vndb', refused.operationId, refused.reviewedHead!.digest)).toEqual({
      status: 'refused',
      operationId: refused.operationId,
    });
  } finally {
    await f.close();
  }
});

test('production converter withholds classification from dump payload until admitted facts exist', () => {
  const input = { external_id: 'v123', record_revision: '7', record: vn().payload };
  expect(registration.convert(input, { source: 'vndb' }).sourceClassification).toBeUndefined();
  expect(
    registration.convert(input, { source: 'vndb', sourceClassification: admittedFacts() }).sourceClassification,
  ).toMatchObject({ state: 'available', value: { kind: 'observation', confidence: 2.4 } });
  expect(
    registration.convert(input, {
      source: 'vndb',
      sourceClassification: admittedFacts({
        licence: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
      }),
    }).sourceClassification,
  ).toEqual({ state: 'unavailable', reason: 'unadmitted' });
});

test('unadmitted licences, missing association and absent admission have zero native classification effects', async () => {
  for (const options of [
    { admit: false as const },
    { association: null },
    {
      facts: admittedFacts({
        licence: { id: 'ODbL-1.0', url: 'https://opendatacommons.org/licenses/odbl/1-0/' },
      }),
    },
    {
      facts: admittedFacts({
        licence: { id: 'LicenseRef-DbCL-1.0', url: 'https://opendatacommons.org/licenses/dbcl/1-0/' },
      }),
    },
  ]) {
    const f = await classificationFixture(options);
    try {
      expect((await f.run()).status).toBe('committed');
      expect(f.writes).toHaveLength(0);
      expect(f.stored.size).toBe(0);
    } finally {
      await f.close();
    }
  }
});

test('classification journal migrates beside existing commands', () => {
  const store = new RunStore(':memory:', { projectionMode: 'source-record' });
  try {
    expect(RUN_TABLES).toContain('run_classification_heads');
    const tables = store.database
      .query(
        `SELECT name FROM sqlite_master WHERE type='table' AND name IN ('run_commands','run_classification_heads')`,
      )
      .all() as { name: string }[];
    expect(tables.map((row) => row.name).sort()).toEqual(['run_classification_heads', 'run_commands']);
  } finally {
    store.close();
  }
});

test('classification CLI rejects malformed, obsolete and resolve-without-review flags', async () => {
  expect(parseClassificationArgs(['--help'])).toBe('help');
  expect(() => parseClassificationArgs(['--state', 's.sqlite', '--source', 'vndb', '--limit', '21'])).toThrow(
    'integer from 1 through 20',
  );
  expect(() => parseClassificationArgs(['--state', 's.sqlite', '--source', 'vndb', '--after', 'zz'])).toThrow(
    '64-hex operation id',
  );
  expect(() =>
    parseClassificationArgs(['--state', 's.sqlite', '--source', 'vndb', '--operation', 'a'.repeat(64), '--resolve']),
  ).toThrow('--reviewed-observation');
  const help = await runClassificationsCli(['--help']);
  expect(help.code).toBe(0);
  expect(help.stdout).toContain('independent of a REZICS classification ballot');
});

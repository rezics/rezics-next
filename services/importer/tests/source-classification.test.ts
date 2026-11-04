import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { join, resolve } from 'node:path';
import type { SourceRecord } from '@rezics/conversion';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { createImportTransport } from '../src/import-client.ts';
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
import { ImportSession } from '../src/import-session.ts';
import { backupStoppedState, restoreStoppedStateSnapshot } from '../src/state-backup.ts';

const subjectId = '00000000-0000-4000-8000-000000000101';
const registration = createSourceRegistration('vndb');
const association: ClassificationAssociation = {
  subjectId,
  candidateId: '00000000-0000-4000-8000-000000000201',
  contextId: '00000000-0000-4000-8000-000000000202',
  targetId: '00000000-0000-4000-8000-000000000203',
  property: 'wdt:P136',
  revision: 1,
  release: `sha256:${'a'.repeat(64)}`,
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
  expect(classifyClassification({ ...intendedWrite, sourceAlias: 'other-fixture' }, { kind: 'head', head })).toEqual({
    action: 'conflict',
    reason: 'alias-rebinding',
  });
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
  const temporaryRoot = resolve(import.meta.dir, '../../../.temp');
  await mkdir(temporaryRoot, { recursive: true });
  const directory = await mkdtemp(join(temporaryRoot, 'classification-'));
  const stored = new Map<string, Record<string, unknown>>();
  const writes: { method: string; path: string; body: unknown; key: string | null }[] = [];
  const sequence = { value: 0 };
  let lost = false;
  let facts: unknown = options.facts === undefined ? admittedFacts() : options.facts;
  let bound: ClassificationAssociation | null = options.association === undefined ? association : options.association;
  let emptyReadReason: 'not_observed' | 'not_found' = 'not_observed';
  let hideNextConfirmation = false;
  let hideConfirmationAfterWrite = false;
  const metadata = sourceRecordMetadataFixture();
  const generated = createImportTransport({
    origin: 'https://api.importer.test',
    tokenProvider: async () => 'test-token',
    maxAttempts: 1,
    fetch: (async (request: Request) => {
      const path = new URL(request.url).pathname;
      const body = JSON.parse(await request.text()) as {
        associations?: ClassificationAssociation[];
        association?: ClassificationAssociation;
        expectedObservation?: string | null;
        value?: Record<string, unknown>;
      };
      if (path.endsWith(':put') || path.endsWith(':clear')) {
        writes.push({ method: request.method, path, body, key: request.headers.get('idempotency-key') });
        if (lost) throw new TypeError('delivery lost');
        if (hideConfirmationAfterWrite) {
          hideConfirmationAfterWrite = false;
          hideNextConfirmation = true;
        }
      }
      if (path.includes('/votes') || path.includes('ballot'))
        throw new TypeError('classification import must not touch native ballots');
      const subjectIdFromPath = path.split('/')[3]!;
      if (path.endsWith(':read')) {
        if (hideNextConfirmation) {
          hideNextConfirmation = false;
          return Response.json({
            items: (body.associations ?? []).map(() => ({ state: 'unavailable', reason: 'changed' })),
          });
        }
        return Response.json({
          items: (body.associations ?? []).map((item) => {
            const row = stored.get(`${subjectIdFromPath}:${classificationAssociationKey(item)}`);
            if (!row) return { state: 'unavailable', reason: emptyReadReason };
            return {
              state: 'available',
              value: {
                provider: 'vndb',
                association: item,
                observation: { digest: row.digest, sourceVersion: row.sourceVersion },
                sourceAlias: row.sourceAlias,
                sourceRecordId: row.sourceRecordId,
                sourceAssociationId: row.sourceAssociationId,
                asOf: row.asOf,
                ageSeconds: 0,
                attribution: row.attribution ?? 'Example classification provider',
                licence: row.licence ?? 'Fixture-1.0',
                confidence:
                  row.confidence === undefined
                    ? { state: 'unavailable', reason: 'not_supplied' }
                    : {
                        state: 'available',
                        value: row.confidence,
                        unit: 'vndb-tag-rating',
                        minExclusive: 0,
                        max: 3,
                      },
                lie:
                  row.lie === undefined
                    ? { state: 'unavailable', reason: 'not_supplied' }
                    : { state: 'available', value: row.lie, unit: 'boolean' },
              },
            };
          }),
        });
      }
      const digest = classificationObservation(body.association!, body.value as never).digest;
      stored.set(`${subjectIdFromPath}:${classificationAssociationKey(body.association!)}`, { ...body.value, digest });
      return Response.json({
        observationDigest: digest,
        state: path.endsWith(':clear') ? 'cleared' : 'published',
      });
    }) as typeof fetch,
  });
  const transport = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest) {
      return resultFor(request, sequence);
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    readSourceClassifications: generated.readSourceClassifications,
    writeSourceClassification: generated.writeSourceClassification,
    clearSourceClassification: generated.clearSourceClassification,
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
    path: join(directory, 'state.sqlite'),
    importer,
    transport,
    stored,
    writes,
    setFacts(next: unknown) {
      facts = next;
    },
    setAssociation(next: ClassificationAssociation | null) {
      bound = next;
    },
    setEmptyReadReason(next: 'not_observed' | 'not_found') {
      emptyReadReason = next;
    },
    hideNextConfirmationAfterWrite() {
      hideConfirmationAfterWrite = true;
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
    run(row: SourceRecord = vn(), progress?: { onAcknowledgedEffects?(count: number): void }) {
      return importer.runRecords(
        registration,
        (async function* () {
          yield row;
        })(),
        progress ? { progress } : {},
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
  const effects: number[] = [];
  try {
    const result = await f.run(vn(), { onAcknowledgedEffects: (count) => effects.push(count) });
    expect(result.status, result.diagnostic).toBe('committed');
    expect(f.writes).toHaveLength(1);
    expect(f.writes[0]!.path).toBe(`/v1/subjects/${subjectId}/source-classifications:put`);
    expect(effects.some((count) => count >= 1)).toBe(true);
    const body = f.writes[0]!.body as {
      expectedObservation: string | null;
      value: { confidence: number; licence: string; sourceAlias: string; attribution: string };
    };
    expect(body.expectedObservation).toBeNull();
    expect(body.value).toMatchObject({
      sourceAlias: 'trusted-fixture',
      confidence: 2.4,
      licence: 'Fixture-1.0',
      attribution: 'Example classification provider',
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
    const retained = f.importer.session.store.retainedClassificationHead(
      'vndb',
      subjectId,
      classificationAssociationKey(association),
    );
    expect(retained?.sourceAlias).toBe('trusted-fixture');
    const store = new RunStore(join(f.directory, 'state.sqlite'), { projectionMode: 'source-record', existing: true });
    try {
      expect(store.retainedClassificationHead('vndb', subjectId, classificationAssociationKey(association))).toEqual(
        retained,
      );
    } finally {
      store.close();
    }
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
    const detail = await runClassificationsCli([
      '--state',
      join(f.directory, 'state.sqlite'),
      '--source',
      'vndb',
      '--operation',
      page.operations[0]!.operationId,
    ]);
    expect(detail.code).toBe(0);
    expect(detail.stdout).toContain('independent of a REZICS classification ballot');
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

test('ordinary import resumes a sealed classification intent without re-admission', async () => {
  const f = await classificationFixture();
  let resumed: Importer | undefined;
  try {
    f.lose();
    expect((await f.run()).status).toBe('bulk-failed');
    const sealed = f.writes[0]!;
    f.recover();
    await f.importer.close();
    resumed = new Importer({ path: join(f.directory, 'state.sqlite'), transport: f.transport });
    expect(
      (
        await resumed.runRecords(
          registration,
          (async function* () {
            yield vn();
          })(),
        )
      ).status,
    ).toBe('committed');
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]).toEqual(sealed);
  } finally {
    await resumed?.close();
    await rm(f.directory, { recursive: true, force: true });
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
test('a successful response without an independent matching head stays uncertain and retries the sealed request', async () => {
  const f = await classificationFixture();
  try {
    f.hideNextConfirmationAfterWrite();
    expect((await f.run()).status).toBe('bulk-failed');
    const sealed = f.writes[0]!;
    expect((await f.run()).status).toBe('committed');
    expect(f.writes).toHaveLength(2);
    expect(f.writes[1]).toEqual(sealed);
  } finally {
    await f.close();
  }
});

test('unadmitted licences, missing association and absent admission have zero native classification effects', async () => {
  for (const options of [
    { admit: false as const },
    { association: null },
    {
      association: {
        ...association,
        subjectId: '00000000-0000-4000-8000-000000000999',
      },
    },
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

test('an unavailable Semantic association is withheld before native classification writes', async () => {
  const f = await classificationFixture();
  try {
    f.setEmptyReadReason('not_found');
    expect((await f.run()).status).toBe('committed');
    expect(f.writes).toHaveLength(0);
    expect(f.stored.size).toBe(0);
  } finally {
    await f.close();
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

test('sealed classification retries from the journal without re-admission', async () => {
  const f = await classificationFixture();
  try {
    f.lose();
    expect((await f.run()).status).toBe('bulk-failed');
    const sealed = f.writes[0]!;
    f.recover();
    await f.importer.close();
    const importer = new Importer({ path: f.path, transport: f.transport, existing: true });
    try {
      expect(
        (
          await importer.runRecords(
            registration,
            (async function* () {
              yield vn();
            })(),
          )
        ).status,
      ).toBe('committed');
      expect(f.writes.at(-1)).toEqual(sealed);
      expect(f.stored.size).toBe(1);
    } finally {
      await importer.close();
    }
  } finally {
    await rm(f.directory, { recursive: true, force: true });
  }
});

test('backup restores classification heads; a later identical import keeps that snapshot', async () => {
  const f = await classificationFixture();
  try {
    expect((await f.run()).status).toBe('committed');
    const heads = f.importer.session.store.database
      .query('SELECT source,subject_id,association_key,digest FROM run_classification_heads')
      .all();
    expect(heads).toHaveLength(1);
    expect((await f.run()).status).toBe('committed');
    expect(
      f.importer.session.store.database
        .query('SELECT source,subject_id,association_key,digest FROM run_classification_heads')
        .all(),
    ).toEqual(heads);
    await f.importer.close();
    const output = join(f.directory, 'snapshot');
    expect((await backupStoppedState({ state: f.path, output })).status).toBe('ready');
    const restored = join(f.directory, 'restored.sqlite');
    await restoreStoppedStateSnapshot({ snapshot: output, state: restored });
    const session = new ImportSession(restored);
    try {
      expect(
        session.store.database
          .query('SELECT source,subject_id,association_key,digest FROM run_classification_heads')
          .all(),
      ).toEqual(heads);
    } finally {
      session.close();
    }
  } finally {
    await f.close();
  }
});

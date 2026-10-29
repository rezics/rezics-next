import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import type { MediaImportAccepted, MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';

import { RecordBindings, type Owner } from '../src/record-bindings.ts';
import { createSqliteProbe, type SqliteEvidence } from './support/sqlite-growth.ts';

type Sample = { scale: number; counted: ReturnType<typeof countedSample> };

const constant: CountedCheck = {
  read: (value) => value as Record<string, number>,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
};

const SCALES = [64, 512, 4096] as const;
const SOURCE = 'growth';
const SUBJECT = uuid(1);
const TABLES = ['binding_records', 'binding_groups', 'binding_journal', 'binding_candidates', 'binding_media'];

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function owner(external_id: string): Owner {
  return { source: SOURCE, external_id };
}

function key(record: Owner, suffix: string): string {
  return `${record.source}:${record.external_id}:${suffix}`;
}

function source(record: Owner, field_group: 'facts' | 'cover' = 'facts') {
  return {
    source: record.source,
    external_id: record.external_id,
    record_revision: 'unversioned',
    converter_revision: 'growth@1',
    digest: 'a'.repeat(64),
    field_group,
  };
}

function proposal(record: Owner, requestKey: string, suffix = 'Growth') {
  return {
    op: 'propose' as const,
    key: requestKey,
    source: source(record),
    subject: SUBJECT,
    statement: {
      property: { id: 'schema:name' },
      value: { type: 'value' as const, content: { language: 'en', text: suffix } },
      references: [
        {
          parts: [
            {
              property: { id: 'schema:sameAs' },
              value: { type: 'value' as const, content: `https://example.org/${record.external_id}` },
            },
          ],
        },
      ],
    },
  };
}

function mediaRequest(record: Owner, containerId = SUBJECT): MediaImportRequest {
  return {
    containerId,
    sourceUrl: 'https://images.example.org/cover.jpg',
    credit: {
      rightsHolder: 'Growth fixture',
      via: { name: 'Source', url: `https://example.org/${record.external_id}` },
      license: 'LicenseRef-unknown',
      obligations: [],
    },
    provenance: {
      source: record.source,
      external_id: record.external_id,
      record_revision: 'unversioned',
      converter_revision: 'growth@1',
      digest: 'a'.repeat(64),
      field_group: 'cover',
      references: [
        {
          parts: [
            {
              property: { id: 'schema:sameAs' },
              value: { type: 'value', content: `https://example.org/${record.external_id}` },
            },
          ],
        },
      ],
    },
  };
}

function mediaAccepted(id: string, containerId = SUBJECT): MediaImportAccepted {
  return { media: { id, containerId, purpose: 'cover', state: 'reserved' } };
}

function mediaStatus(request: MediaImportRequest, id: string, containerId = SUBJECT): MediaImportStatus {
  return {
    media: {
      id,
      containerId,
      purpose: 'cover',
      state: 'available',
      credit: request.credit,
      provenance: request.provenance,
      byteCount: 128,
      mediaType: 'image/webp',
      sha256: 'b'.repeat(64),
    },
  };
}

function population(count: number, scale: number, label: string): Owner[] {
  return Array.from({ length: count + 1 }, (_, index) =>
    owner(index === 0 ? `${label}-${scale}` : `${label}-${scale}-${String(index).padStart(6, '0')}`),
  );
}

function seedRecords(
  database: Database,
  owners: Owner[],
  options: {
    candidateCounts?: ReadonlyMap<string, number>;
    coverKeys?: ReadonlyMap<string, string>;
  } = {},
): void {
  const statement = database.prepare(
    'INSERT INTO binding_records (source, external_id, state, subject, bootstrap_key, candidate_count, cover_key) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const transaction = database.transaction(() => {
    owners.forEach((record, index) => {
      statement.run(
        record.source,
        record.external_id,
        'bound',
        uuid(index + 1),
        key(record, 'bootstrap'),
        options.candidateCounts?.get(record.external_id) ?? 0,
        options.coverKeys?.get(record.external_id) ?? null,
      );
    });
  });
  try {
    transaction.immediate();
  } finally {
    statement.finalize();
  }
}

function seedJournals(database: Database, owners: Owner[]): void {
  const statement = database.prepare(
    'INSERT INTO binding_journal (source, external_id, key, bytes, signature, acknowledgement) VALUES (?, ?, ?, ?, ?, ?)',
  );
  const transaction = database.transaction(() => {
    for (const record of owners) {
      const requestKey = key(record, 'journal');
      statement.run(
        record.source,
        record.external_id,
        requestKey,
        JSON.stringify({ commands: [proposal(record, requestKey)] }),
        'growth@1',
        null,
      );
    }
  });
  try {
    transaction.immediate();
  } finally {
    statement.finalize();
  }
}

function seedGroups(database: Database, owners: Owner[], counts: ReadonlyMap<string, number>): void {
  const statement = database.prepare(
    'INSERT INTO binding_groups (source, external_id, field_group, candidate_count) VALUES (?, ?, ?, ?)',
  );
  const transaction = database.transaction(() => {
    for (const record of owners)
      statement.run(record.source, record.external_id, 'facts', counts.get(record.external_id) ?? 0);
  });
  try {
    transaction.immediate();
  } finally {
    statement.finalize();
  }
}

function seedCandidates(database: Database, owners: Owner[], target: Owner, targetCount: number): void {
  const statement = database.prepare(
    'INSERT INTO binding_candidates (source, external_id, field_group, candidate, subject, key, bytes, signature) VALUES (?, ?, ?, ?, ?, ?, ?, ?)',
  );
  const transaction = database.transaction(() => {
    for (let index = 0; index < owners.length - 1 + Math.max(targetCount, 1); index++) {
      const record = index < targetCount ? target : owners[1 + ((index - targetCount) % (owners.length - 1))]!;
      const candidate = uuid(1000 + index);
      const requestKey = key(record, `candidate-${index}`);
      statement.run(
        record.source,
        record.external_id,
        'facts',
        candidate,
        SUBJECT,
        requestKey,
        JSON.stringify({ commands: [proposal(record, requestKey, `Candidate ${index}`)] }),
        'growth@1',
      );
    }
  });
  try {
    transaction.immediate();
  } finally {
    statement.finalize();
  }
}

function seedMedia(database: Database, owners: Owner[], target: Owner, targetKey: string, available: boolean): void {
  const statement = database.prepare(
    'INSERT INTO binding_media (source, external_id, key, bytes, signature, accepted, status) VALUES (?, ?, ?, ?, ?, ?, ?)',
  );
  const transaction = database.transaction(() => {
    for (let index = 0; index < owners.length; index++) {
      const record = owners[index]!;
      const container = uuid(index + 1);
      const mediaKey = record.external_id === target.external_id ? targetKey : key(record, 'old-cover');
      const request = mediaRequest(record, container);
      const id = uuid(500_000 + index);
      statement.run(
        record.source,
        record.external_id,
        mediaKey,
        JSON.stringify(request),
        'growth@1',
        JSON.stringify(mediaAccepted(id, container)),
        available && record.external_id === target.external_id
          ? JSON.stringify(mediaStatus(request, id, container))
          : null,
      );
    }
  });
  try {
    transaction.immediate();
  } finally {
    statement.finalize();
  }
}

function describeEvidence(evidence: readonly SqliteEvidence[]): string {
  return evidence.map(({ sql, plan }) => `SQL: ${sql}\nPlan: ${JSON.stringify(plan)}`).join('\n');
}

async function measuredAtScale<T>(
  scale: number,
  label: string,
  seed: (database: Database, count: number, target: Owner) => void,
  operation: (bindings: RecordBindings, target: Owner) => T,
): Promise<{
  value: T;
  counts: { 'sqlite returned rows': number; 'sqlite statements': number };
  statements: SqliteEvidence[];
}> {
  const directory = await mkdtemp(join(tmpdir(), 'bindings-growth-'));
  const native = new Database(join(directory, 'bindings.sqlite'), { create: true, strict: true });
  const probe = createSqliteProbe(native, { growingTables: TABLES });
  const bindings = new RecordBindings(probe.database);
  const target = owner(`${label}-${scale}`);
  try {
    const count = scale;
    seed(probe.database, count, target);
    const expected: Record<string, number[]> = {
      lookup: [scale + 1, 0, scale + 1, 0, 0],
      'candidate-page': [0, 0, 0, scale + 8, 0],
      'media-projection': [scale + 1, 0, 0, 0, scale + 1],
      'binding-write': [scale + 1, scale + 1, scale + 1, scale + 1, 0],
      'media-write': [scale + 1, 0, 0, 0, scale + 1],
    };
    expect(
      TABLES.map((table) => (native.query(`SELECT count(*) AS n FROM ${table}`).get() as { n: number }).n),
    ).toEqual(expected[label]!);
    probe.database.exec('ANALYZE');
    const measured = probe.measure(() => operation(bindings, target));
    try {
      const plans = probe.verifyPlans();
      expect(plans.some((event) => event.plan.some((plan) => /^SEARCH\b/.test(plan.detail)))).toBe(true);
    } catch (error) {
      throw new Error(
        `${error instanceof Error ? error.message : String(error)}\n${describeEvidence(measured.statements)}`,
      );
    }
    return { value: measured.value, counts: measured.counts, statements: measured.statements };
  } finally {
    bindings.close();
    probe.restore();
    native.close();
    await rm(directory, { recursive: true, force: true });
  }
}

function assertConstant(samples: Sample[], evidence: SqliteEvidence[][]): void {
  try {
    expect(countedViolations(constant, samples)).toEqual([]);
  } catch (error) {
    throw new Error(
      `${error instanceof Error ? error.message : String(error)}\n${evidence.map(describeEvidence).join('\n')}`,
    );
  }
}

function assertMaximum(
  samples: Sample[],
  evidence: SqliteEvidence[][],
  maximum: { rows: number; statements: number },
): void {
  samples.forEach(({ counted }, index) => {
    if (
      counted['sqlite returned rows']!.value > maximum.rows ||
      counted['sqlite statements']!.value > maximum.statements
    ) {
      throw new Error(
        `Measured SQLite cost exceeds its bound: ${counted['sqlite returned rows']!.value} sqlite returned rows, ${counted['sqlite statements']!.value} sqlite statements\n${describeEvidence(evidence[index]!)}`,
      );
    }
  });
}

async function check(
  label: string,
  seed: (database: Database, count: number, target: Owner) => void,
  operation: (bindings: RecordBindings, target: Owner) => unknown,
): Promise<{ samples: Sample[]; evidence: SqliteEvidence[][] }> {
  const samples: Sample[] = [];
  const evidence: SqliteEvidence[][] = [];
  for (const scale of SCALES) {
    const result = await measuredAtScale(scale, label, seed, operation);
    samples.push({ scale, counted: countedSample([result.counts]) });
    evidence.push(result.statements);
  }
  assertConstant(samples, evidence);
  return { samples, evidence };
}

test('Binding lookup stays within its bound as B grows', async () => {
  const { samples, evidence } = await check(
    'lookup',
    (database, count, target) => {
      const owners = population(count, Number(target.external_id.split('-').at(-1)), 'lookup');
      seedRecords(database, owners);
      seedJournals(database, owners);
    },
    (bindings, target) => {
      expect(bindings.claim(target)).toEqual({ state: 'bound', subject: uuid(1) });
      expect(bindings.journal(target, key(target, 'journal'))?.key).toBe(key(target, 'journal'));
    },
  );
  assertMaximum(samples, evidence, { rows: 2, statements: 2 });
});

test('Binding candidate page stays within its bound as B grows', async () => {
  const { samples, evidence } = await check(
    'candidate-page',
    (database, count, target) => {
      const scale = Number(target.external_id.split('-').at(-1));
      const owners = population(count, scale, 'candidate-page');
      seedCandidates(database, owners, target, 8);
    },
    (bindings, target) => {
      const page = bindings.candidates(target, 'facts', { limit: 8 });
      expect(page).toHaveLength(8);
      return page;
    },
  );
  assertMaximum(samples, evidence, { rows: 8, statements: 1 });
});

test('Media projection stays within its bound as B grows', async () => {
  const { samples, evidence } = await check(
    'media-projection',
    (database, count, target) => {
      const scale = Number(target.external_id.split('-').at(-1));
      const owners = population(count, scale, 'media-projection');
      const currentKey = key(target, 'current-cover');
      seedRecords(database, owners, { coverKeys: new Map([[target.external_id, currentKey]]) });
      seedMedia(database, owners, target, currentKey, true);
    },
    (bindings, target) => {
      expect(bindings.mediaIds(target)).toEqual({ cover: uuid(500_000) });
    },
  );
  assertMaximum(samples, evidence, { rows: 2, statements: 2 });
});

test('Binding write stays within its bound as B grows', async () => {
  const { samples, evidence } = await check(
    'binding-write',
    (database, count, target) => {
      const scale = Number(target.external_id.split('-').at(-1));
      const owners = population(count, scale, 'binding-write');
      const counts = new Map(
        owners.map((record, index) => [record.external_id, index === 0 ? 0 : index === 1 ? 2 : 1]),
      );
      seedRecords(database, owners, { candidateCounts: counts });
      seedJournals(database, owners);
      seedGroups(database, owners, counts);
      seedCandidates(database, owners, target, 0);
    },
    (bindings, target) => {
      const requestKey = key(target, 'new-proposal');
      const journal = bindings.prepare(target, 'growth@1', { commands: [proposal(target, requestKey)] });
      const acknowledged: BatchWriteResult = {
        results: [{ key: journal.key, status: 201, value: { candidate: uuid(900_000), revision: 2 } }],
      };
      bindings.acknowledge(target, journal.key, acknowledged);
      bindings.takenDown(target, { status: 404 });
      return journal;
    },
  );
  assertMaximum(samples, evidence, { rows: 14, statements: 20 });
});

test('Media write stays within its bound as B grows', async () => {
  const { samples, evidence } = await check(
    'media-write',
    (database, count, target) => {
      const scale = Number(target.external_id.split('-').at(-1));
      const owners = population(count, scale, 'media-write');
      seedRecords(database, owners);
      seedMedia(database, owners, target, key(target, 'old-cover'), false);
    },
    (bindings, target) => {
      const requestKey = key(target, 'new-cover');
      const request = mediaRequest(target);
      const id = uuid(910_000);
      bindings.prepareMedia(target, requestKey, 'growth@1', request);
      bindings.acceptMedia(target, requestKey, mediaAccepted(id));
      bindings.observeMedia(target, requestKey, mediaStatus(request, id));
    },
  );
  assertMaximum(samples, evidence, { rows: 10, statements: 16 });
});

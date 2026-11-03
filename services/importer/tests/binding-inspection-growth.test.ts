import { Database } from 'bun:sqlite';
import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { countedSample, countedViolations, type CountedCheck } from '../../kernel/test/support/growth-counters.ts';
import { BindingInspectionStore } from '../src/binding-inspection-store.ts';
import { runImportCli } from '../src/cli.ts';
import { RecordBindings, type Owner } from '../src/record-bindings.ts';
import { RUN_TABLES, RunStore, type SourceProjection } from '../src/run-store.ts';
import { createSqliteProbe, type SqliteEvidence } from './support/sqlite-growth.ts';

const SCALES = [32, 128, 512] as const;
const SOURCE = 'wikidata';
const TABLES = [
  'binding_records',
  'binding_groups',
  'binding_journal',
  'binding_candidates',
  'binding_media',
  'binding_metadata_journal',
  'binding_metadata_current',
  ...RUN_TABLES,
];
const check: CountedCheck = {
  read: (value: unknown) => value as Record<string, number>,
  bounds: {
    'sqlite statements': 'constant',
    'sqlite returned rows': 'constant',
    'body bytes hashed': 'constant',
  },
  slack: {
    'sqlite statements': { absolute: 2, relative: 0.1 },
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'body bytes hashed': { absolute: 64, relative: 0.1 },
  },
};

function uuid(value: number): string {
  return `00000000-0000-4000-8000-${value.toString(16).padStart(12, '0')}`;
}

function ownerOf(external_id: string): Owner {
  return { source: SOURCE, external_id };
}

function requestKey(record: Owner, suffix: string): string {
  return `${record.source}:${record.external_id}:${suffix}`;
}

function proposal(record: Owner, key: string) {
  return {
    op: 'propose' as const,
    key,
    source: {
      source: record.source,
      external_id: record.external_id,
      record_revision: '1',
      digest: 'a'.repeat(64),
      converter_revision: 'growth@1',
      field_group: 'facts' as const,
    },
    subject: uuid(1),
    statement: {
      property: { id: 'schema:name' },
      value: { type: 'value' as const, content: { language: 'en', text: 'Growth' } },
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

function seed(database: Database, scale: number, target: Owner): void {
  const bindings = new RecordBindings(database);
  const runs = new RunStore<SourceProjection>(database, { projectionMode: 'source-record' });
  const journal = database.prepare(
    'INSERT INTO binding_journal (source,external_id,key,bytes,signature,acknowledgement) VALUES (?,?,?,?,?,?)',
  );
  const records = database.prepare(
    'INSERT INTO binding_records (source,external_id,state,subject,bootstrap_key,candidate_count,cover_key) VALUES (?,?,?,?,?,?,?)',
  );
  try {
    const bootstrap = requestKey(target, 'bootstrap');
    bindings.prepare(target, 'a'.repeat(64), {
      commands: [
        {
          op: 'create',
          key: bootstrap,
          source: {
            source: target.source,
            external_id: target.external_id,
            record_revision: '1',
            digest: 'a'.repeat(64),
            converter_revision: 'growth@1',
            field_group: 'facts',
          },
          subject: { type: 'item', labels: { en: 'Growth' } },
        },
      ],
    });
    bindings.acknowledge(target, bootstrap, {
      results: [{ key: bootstrap, status: 201, value: { id: uuid(1), revision: 1 } }],
    });
    const insert = database.transaction(() => {
      for (let index = 0; index < scale; index++) {
        const journalKey = requestKey(target, `row-${String(index).padStart(4, '0')}`);
        journal.run(
          target.source,
          target.external_id,
          journalKey,
          JSON.stringify({ commands: [proposal(target, journalKey)] }),
          'a'.repeat(64),
          null,
        );
      }
      for (let index = 0; index < scale; index++) {
        const extra = ownerOf(`history-${scale}-${String(index).padStart(4, '0')}`);
        const extraKey = requestKey(extra, 'bootstrap');
        records.run(extra.source, extra.external_id, 'bound', uuid(2), extraKey, 0, null);
        journal.run(
          extra.source,
          extra.external_id,
          extraKey,
          JSON.stringify({ commands: [proposal(extra, extraKey)] }),
          'a'.repeat(64),
          JSON.stringify({ results: [{ key: extraKey, status: 201, value: { id: uuid(2), revision: 1 } }] }),
        );
      }
      const other: Owner = { source: 'openlibrary', external_id: `other-${scale}` };
      const otherKey = requestKey(other, 'bootstrap');
      records.run(other.source, other.external_id, 'bound', uuid(3), otherKey, 0, null);
      journal.run(
        other.source,
        other.external_id,
        otherKey,
        JSON.stringify({ commands: [proposal(other, otherKey)] }),
        'a'.repeat(64),
        null,
      );
    });
    insert.immediate();
    const generation = runs.begin(SOURCE);
    if (generation === 'busy') throw new Error('busy');
    for (let index = 0; index < Math.min(scale, 32); index++) {
      runs.stage(generation, {
        row: {
          source: SOURCE,
          recordKey: `Q${scale}-${index}`,
          recordRevision: '1',
          digest: index.toString(16).padStart(64, '0'),
          converter_revision: 'growth@1',
          state: 'present',
        },
        projection: { sourceKind: 'wikidata', normalizedRecord: { id: `Q${index}` } },
      });
    }
    expect(runs.seal(generation, { complete: true }).status).toBe('ready');
    expect(runs.abandon(generation)).toBe('abandoned');
  } finally {
    journal.finalize();
    records.finalize();
    bindings.close();
  }
}

function describeEvidence(evidence: readonly SqliteEvidence[]): string {
  return evidence.map(({ sql, plan }) => `SQL: ${sql}\nPlan: ${JSON.stringify(plan)}`).join('\n');
}

test('binding inspection overview, page and detail stay indexed as retained requests and unrelated history grow', async () => {
  const groups = new Map<string, { scale: number; counted: ReturnType<typeof countedSample> }[]>();
  for (const scale of SCALES) {
    const directory = await mkdtemp(join(tmpdir(), 'binding-inspection-growth-'));
    const path = join(directory, 'state.sqlite');
    const native = new Database(path, { create: true, strict: true });
    const target = ownerOf(`target-${scale}`);
    try {
      seed(native, scale, target);
      native.exec('ANALYZE');
      native.close();
      let probe: ReturnType<typeof createSqliteProbe> | undefined;
      const store = await BindingInspectionStore.open(path, {
        instrumentDatabase: (database) => {
          probe = createSqliteProbe(database, { growingTables: TABLES });
          return probe.database;
        },
      });
      try {
        function sample(label: string, operation: () => ReturnType<BindingInspectionStore['inspect']>) {
          const measured = probe!.measure(operation);
          const metrics = store.lastMetrics();
          try {
            const plans = probe!.verifyPlans();
            expect(plans.some((event) => event.kind === 'write' || event.kind === 'insert')).toBe(false);
            expect(plans.some((event) => event.plan.some((row) => /^SEARCH/.test(row.detail)))).toBe(true);
            expect(
              plans.every(
                (event) => !event.plan.some((row) => /\bSCAN\b/i.test(row.detail) && !/CONSTANT ROW/.test(row.detail)),
              ),
            ).toBe(true);
          } catch (error) {
            throw new Error(
              `${label}: ${error instanceof Error ? error.message : String(error)}\n${describeEvidence(measured.statements)}`,
            );
          }
          expect(metrics.visitedRows).toBeLessThanOrEqual(22);
          expect(metrics.bodyBytesCopied).toBeLessThanOrEqual(21 * 65536);
          expect(metrics.maxBufferBytes).toBeLessThanOrEqual(65536);
          const values = {
            'sqlite statements': measured.counts['sqlite statements'],
            'sqlite returned rows': measured.counts['sqlite returned rows'],
            'body bytes hashed': metrics.bodyBytesHashed,
          };
          const samples = groups.get(label) ?? [];
          samples.push({ scale, counted: countedSample(values, scale) });
          groups.set(label, samples);
          return measured.value;
        }
        sample('overview', () => store.inspect({ source: SOURCE, record: target.external_id }));
        const document = sample('page', () =>
          store.inspect({ source: SOURCE, record: target.external_id, page: 'semantic', limit: 20 }),
        );
        expect(document.page?.rows).toHaveLength(20);
        expect(document.page?.nextCursor).toBeString();
        const continued = sample('next', () =>
          store.inspect({
            source: SOURCE,
            record: target.external_id,
            page: 'semantic',
            limit: 20,
            cursor: document.page!.nextCursor,
          }),
        );
        expect(continued.page?.rows.length).toBeGreaterThan(0);
        const detail = sample('detail', () =>
          store.inspect({
            source: SOURCE,
            record: target.external_id,
            page: 'semantic',
            request: requestKey(target, 'bootstrap'),
          }),
        );
        expect(detail.request?.row.acknowledgement).toBe('present');
        const cli = await runImportCli([
          'inspect-bindings',
          '--state',
          path,
          '--source',
          SOURCE,
          '--record',
          target.external_id,
          '--page',
          'semantic',
          '--limit',
          '20',
          '--json',
        ]);
        expect(cli.code).toBe(0);
        expect(cli.openHandles).toBe(0);
        expect(JSON.parse(cli.stdout).page.rows).toHaveLength(20);
      } finally {
        await store.close();
        probe?.restore();
      }
    } finally {
      try {
        native.close();
      } catch {
        // Already closed after seeding.
      }
      await rm(directory, { recursive: true, force: true });
    }
  }
  for (const [label, samples] of groups) {
    expect(countedViolations(check, samples), label).toEqual([]);
  }
});

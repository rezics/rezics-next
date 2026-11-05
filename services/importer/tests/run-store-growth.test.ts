import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteResult } from '@rezics/definitions/bulk';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedSample,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { runStoreCounts, type Staged } from '../../../specs/imports-run-store-driver.ts';
import { createImportRunStoreDriver } from './run-store-driver.ts';
import { RunStore } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';

const fixedCounts: CountedCheck = {
  read: (counts) => counts as CountedValues,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};

function record(key: string, revision: number): Staged {
  const projection: Staged['projection'] = [
    {
      property: { id: 'schema:name' },
      value: { type: 'value', content: { language: 'en', text: `Book ${revision}` } },
      references: [
        {
          parts: [
            { property: { id: 'schema:sameAs' }, value: { type: 'value', content: `https://example.org/${key}` } },
          ],
        },
      ],
    },
  ];
  return {
    row: {
      source: 'growth',
      recordKey: key,
      recordRevision: 'unversioned',
      digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(projection)).digest('hex'),
      converter_revision: 'fixture@1',
      state: 'present',
    },
    projection,
  };
}
function command(r: Staged): Extract<BatchCommand, { op: 'propose' }> {
  return {
    op: 'propose',
    key: `${r.row.recordKey}:${r.row.digest}`,
    source: {
      source: r.row.source,
      external_id: r.row.recordKey,
      record_revision: r.row.recordRevision,
      digest: r.row.digest,
      converter_revision: r.row.converter_revision,
      field_group: 'facts',
    },
    subject: '00000000-0000-4000-8000-000000000001',
    statement: r.projection[0]!,
  };
}
const ack = (keys: string[]): BatchWriteResult => ({
  results: keys.map((key) => ({ key, status: 200, value: { revision: 1 } })),
});

test('fixed run-state operations stay indexed at three scales', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-growth-'));
  const d = await createImportRunStoreDriver({ directory });
  const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
  try {
    for (const scale of [32, 128, 512]) {
      // One deterministic population, same source and indexes, three historical versions.
      for (const revision of [1, 2, 3]) {
        const run = await d.begin('growth');
        if (run === 'busy') throw new Error('Unexpected busy');
        for (let i = 0; i < scale; i++) await d.stage(run, record(`K${String(i).padStart(4, '0')}`, revision));
        expect((await d.seal(run, { complete: true })).status).toBe('ready');
        for (let i = 0; i < scale; i++) {
          const r = record(`K${String(i).padStart(4, '0')}`, revision);
          await d.classify(run, r.row.recordKey, { commands: [command(r)] });
        }
        for (;;) {
          const pending = await d.pagePending(run, { limit: 8 });
          if (!pending.length) break;
          for (const p of pending) await d.acknowledge(run, ack(p.keys));
        }
        while ((await d.finalize(run, 8)) === 'more') {
          /* bounded durable pages */
        }
      }
      const measure = async <T>(name: string, operation: () => Promise<T>) => {
        const measured = await d.measure(operation);
        const counts = runStoreCounts(measured.evidence, 8);
        expect(counts['sqlite returned rows']).toBeLessThanOrEqual(64);
        expect(counts['sqlite statements']).toBeLessThanOrEqual(48);
        const group = samples.get(name) ?? [];
        group.push({ scale, counted: countedSample([counts]) });
        samples.set(name, group);
        return measured.value;
      };
      const blocked = await d.begin('growth');
      if (blocked === 'busy') throw new Error('Unexpected busy');
      await d.stage(blocked, record('K0000', 3));
      await d.analyze();
      expect((await measure('mass-check', () => d.seal(blocked, { complete: true }))).status).toBe(
        'mass-disappearance',
      );
      const run = await d.begin('growth');
      if (run === 'busy') throw new Error('Unexpected busy');
      for (let i = 0; i < scale; i++) await d.stage(run, record(`K${String(i).padStart(4, '0')}`, i === 0 ? 4 : 3));
      await d.seal(run, { complete: true });
      await d.analyze();
      const r = record('K0000', 4);
      expect(await measure('classify', () => d.classify(run, 'K0000', { commands: [command(r)] }))).toBe('changed');
      const pending = await measure('pending-page', () => d.pagePending(run, { limit: 8 }));
      expect(pending).toHaveLength(1);
      const bytes = pending[0]!.bytes;
      await expect(
        d.acknowledge(run, { results: [{ key: command(r).key, status: 200, value: {} }] } as never),
      ).rejects.toThrow();
      await d.acknowledge(run, {
        results: [{ key: command(r).key, status: 409, problem: { type: 'conflict', title: 'Conflict', status: 409 } }],
      });
      const resumed = await d.reopen(run);
      await expect(
        d.classify(resumed, 'K0000', { commands: [{ ...command(r), statement: record('K0000', 9).projection[0]! }] }),
      ).rejects.toThrow();
      expect((await d.pagePending(resumed, { limit: 8 }))[0]!.bytes).toBe(bytes);
      await d.analyze();
      await measure('ack', () => d.acknowledge(resumed, ack(pending[0]!.keys)));
      await d.acknowledge(resumed, ack(pending[0]!.keys));
      expect(await d.finalize(resumed, 8)).toBe('incomplete');
      for (let i = 1; i < scale; i++) await d.classify(resumed, `K${String(i).padStart(4, '0')}`, { commands: [] });
      while ((await d.finalize(resumed, 8)) === 'more') {
        /* bounded durable pages */
      }
      expect((await d.source('growth')).count).toBe(scale);
    }
    for (const group of samples.values()) expect(countedViolations(fixedCounts, group)).toEqual([]);
  } finally {
    await d.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

const RUN_SCALES = [1, 8, 64] as const;
const FIXTURE_SOURCE = 'run-growth-fixture';
const FIXTURE_RUN = { source: FIXTURE_SOURCE, id: '1', lease: 'a'.repeat(48) };
const fixtureRow = (key: string) => ({
  source: FIXTURE_SOURCE,
  recordKey: key,
  recordRevision: 'unversioned',
  digest: 'a'.repeat(64),
  converter_revision: 'fixture@1',
  state: 'present' as const,
});
const fixtureRowJson = (key: string) => JSON.stringify(fixtureRow(key));

function seedRunStore(store: RunStore, count: number, status: 'staging' | 'ready' = 'ready') {
  const db = store.database;
  db.exec('BEGIN');
  const statements = new Map<string, ReturnType<typeof db.prepare>>();
  try {
    const put = (sql: string, ...values: (string | number | null)[]) => {
      let statement = statements.get(sql);
      if (!statement) {
        statement = db.prepare(sql);
        statements.set(sql, statement);
      }
      statement.run(...values);
    };
    put('INSERT INTO run_sources VALUES(?,?,?,?,?)', FIXTURE_SOURCE, count + 1, FIXTURE_RUN.id, null, count);
    for (let i = 0; i < count; i++) {
      const key = `${crypto.randomUUID().replaceAll('-', '')}-${String(i).padStart(6, '0')}`;
      const id = i === 0 ? FIXTURE_RUN.id : `history-${String(i).padStart(8, '0')}`;
      if (i > 0) put('INSERT INTO run_sources VALUES(?,?,?,?,?)', `fixture-${i}`, 1, null, null, 0);
      put(
        `INSERT INTO run_generations(source,id,seq,lease,status,threshold,prior,supplied,survivors,classified,resolved,expected,changed,prepared,cursor)
         VALUES(?,?,?,?,?,0.5,?,?,?,?,?,?,?,?,?)`,
        FIXTURE_SOURCE,
        id,
        i + 1,
        i === 0 ? FIXTURE_RUN.lease : 'old-lease',
        i === 0 ? status : 'complete',
        count,
        count,
        count,
        status === 'ready' && i === 0 ? count : 0,
        status === 'ready' && i === 0 ? count : 0,
        count,
        count,
        count,
        '',
      );
      put(
        `INSERT INTO run_entries(source,run_id,record_key,row_json,projection_json,kind,resolved,bytes,keys_json,omissions_json,pending,remaining)
         VALUES(?,?,?,?,?,'changed',1,'{}',?,'[]',0,0)`,
        FIXTURE_SOURCE,
        FIXTURE_RUN.id,
        key,
        fixtureRowJson(key),
        '[]',
        JSON.stringify([`C${i}`]),
      );
      put('INSERT INTO run_members VALUES(?,?,?,?,?)', FIXTURE_SOURCE, key, 1, i + 1, fixtureRowJson(key));
      put('INSERT INTO run_acknowledged VALUES(?,?,?,?)', FIXTURE_SOURCE, key, fixtureRowJson(key), '[]');
      put(
        'INSERT INTO run_commands VALUES(?,?,?,?,?,?,?,1)',
        FIXTURE_SOURCE,
        FIXTURE_RUN.id,
        `C${i}`,
        key,
        'facts',
        'propose',
        0,
      );
      put('INSERT INTO run_payloads VALUES(?,?,?)', FIXTURE_SOURCE, `C${i}`, '{}');
      put(
        'INSERT INTO run_envelopes VALUES(?,?,?,?,?,?,?,?,?)',
        FIXTURE_SOURCE,
        FIXTURE_RUN.id,
        key,
        0,
        0,
        '{}',
        JSON.stringify([`C${i}`]),
        0,
        0,
      );
    }
    for (const statement of statements.values()) statement.finalize();
    db.exec('COMMIT');
  } catch (error) {
    for (const statement of statements.values()) statement.finalize();
    db.exec('ROLLBACK');
    throw error;
  }
  db.exec('ANALYZE');
  const first = db.prepare(
    'SELECT record_key FROM run_entries WHERE source=? AND run_id=? ORDER BY record_key LIMIT 1',
  );
  try {
    return (first.get(FIXTURE_SOURCE, FIXTURE_RUN.id) as { record_key: string }).record_key;
  } finally {
    first.finalize();
  }
}

async function measureRunGrowth(
  name: string,
  operation: (store: RunStore, scale: number, key: string) => unknown,
  page = false,
  status: 'staging' | 'ready' = 'ready',
) {
  const samples: { scale: number; counted: CountedSample }[] = [];
  const plans: string[] = [];
  for (const scale of RUN_SCALES) {
    const directory = await mkdtemp(join(tmpdir(), 'run-store-growth-followup-'));
    const store = new RunStore(`${directory}/runs.sqlite`);
    const probe = createSqliteProbe(store.database, {
      growingTables: [
        'run_sources',
        'run_generations',
        'run_entries',
        'run_members',
        'run_acknowledged',
        'run_commands',
        'run_payloads',
        'run_envelopes',
      ],
    });
    try {
      const key = seedRunStore(store, 500 * scale, status);
      const measured = probe.measure(() => operation(store, scale, key));
      try {
        probe.verifyPlans();
      } catch (error) {
        const statements = measured.statements.map((event) => `${event.sql}\n${JSON.stringify(event.plan)}`).join('\n');
        throw new Error(`${name}: ${String(error)}\n${statements}`);
      }
      samples.push({ scale, counted: countedSample([measured.counts]) });
      plans.push(
        `scale ${scale}:\n${measured.statements.map((event) => `${event.sql}\n${JSON.stringify(event.plan)}`).join('\n')}`,
      );
    } finally {
      store.close();
      await rm(directory, { recursive: true, force: true });
    }
  }
  try {
    expect(
      countedViolations(
        {
          ...fixedCounts,
          bounds: {
            'sqlite returned rows': page ? 'linear' : 'constant',
            'sqlite statements': page ? 'linear' : 'constant',
          },
        },
        samples,
      ),
    ).toEqual([]);
  } catch (error) {
    throw new Error(`${name}: ${String(error)}\n${plans.join('\n')}`);
  }
}

test('Run control stays within its bound as R grows', async () => {
  await measureRunGrowth('Run control', (store) => store.begin(FIXTURE_SOURCE));
}, 120_000);

test('Run staging stays within its bound as R grows', async () => {
  await measureRunGrowth(
    'Run staging',
    (store, scale) => {
      const key = `fresh-${scale}-${crypto.randomUUID()}`;
      store.stage(FIXTURE_RUN, { row: fixtureRow(key), projection: [] });
    },
    false,
    'staging',
  );
}, 120_000);

test('Run projection page stays within its bound as R grows', async () => {
  await measureRunGrowth('Run projection page', (store) => store.pageStaged(FIXTURE_RUN, { limit: 8 }), true);
}, 120_000);

test('Run vanished page stays within its bound as R grows', async () => {
  await measureRunGrowth('Run vanished page', (store) => store.pageVanished(FIXTURE_RUN, { limit: 8 }), true);
}, 120_000);

test('Run key observation stays within its bound as R grows', async () => {
  await measureRunGrowth('Run key observation', (store, _scale, key) => store.key(FIXTURE_SOURCE, key, FIXTURE_RUN));
}, 120_000);

test('Run omission check stays within its bound as R grows', async () => {
  await measureRunGrowth('Run omission check', (store, _scale, key) =>
    store.classify(FIXTURE_RUN, key, {
      commands: [],
      omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '1' }],
    }),
  );
}, 120_000);

test('prepared omission handoff returns the durable strongest proof without changing request bytes', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'run-store-omission-handoff-'));
  const store = new RunStore(`${directory}/runs.sqlite`);
  try {
    const run = store.begin(FIXTURE_SOURCE);
    if (run === 'busy') throw new Error('Unexpected busy');
    const staged = record('omission-handoff', 1);
    staged.row.source = FIXTURE_SOURCE;
    store.stage(run, staged);
    expect(store.seal(run, { complete: true }).status).toBe('ready');
    const original = command(staged);
    store.prepare(run, staged.row.recordKey, { commands: [original] });
    const stored = store.database
      .prepare(
        'SELECT bytes,keys_json FROM run_envelopes WHERE source=? AND run_id=? AND record_key=? AND envelope_index=0',
      )
      .get(FIXTURE_SOURCE, run.id, staged.row.recordKey) as { bytes: string; keys_json: string };

    const first = store.prepareWithOmissions(run, staged.row.recordKey, {
      commands: [],
      omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '9' }],
    });
    expect(first).toEqual({
      kind: 'new',
      omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '9' }],
    });
    const next = store.prepareWithOmissions(run, staged.row.recordKey, {
      commands: [],
      omissions: [
        { field_group: 'facts', disposition: 'fenced', securityRevision: '8' },
        { field_group: 'cover', disposition: 'fenced', securityRevision: '10' },
      ],
    });
    expect(next.omissions).toEqual([
      { field_group: 'facts', disposition: 'fenced', securityRevision: '9' },
      { field_group: 'cover', disposition: 'fenced', securityRevision: '10' },
    ]);
    expect(
      store.database
        .prepare(
          'SELECT bytes,keys_json FROM run_envelopes WHERE source=? AND run_id=? AND record_key=? AND envelope_index=0',
        )
        .get(FIXTURE_SOURCE, run.id, staged.row.recordKey),
    ).toEqual(stored);
    expect(() =>
      store.prepareWithOmissions({ ...run, lease: 'b'.repeat(48) }, staged.row.recordKey, { commands: [] }),
    ).toThrow('Run capability is stale or terminal');
  } finally {
    store.close();
    await rm(directory, { recursive: true, force: true });
  }
});

test('Run finalize stays within its bound as R grows', async () => {
  await measureRunGrowth('Run finalize', (store) => store.finalize(FIXTURE_RUN, 8), true);
}, 120_000);

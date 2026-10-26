import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';
import { RUN_TABLES } from '../src/run-store.ts';
import { assertGrowth, type GrowthSample } from '../../kernel/test/support/growth-bound.ts';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);
const registration = createSourceRegistration('wikidata');
function row(id = 1, title = 'Target', aliases = 0) {
  const r = structuredClone(fixture);
  r.id = `Q${id}`;
  r.labels.en.value = title;
  r.aliases = { en: Array.from({ length: aliases }, (_, i) => ({ language: 'en', value: `Alias ${i}` })) };
  for (const claims of Object.values(r.claims) as any[][])
    for (const c of claims) c.id = c.id.replace(/^Q1\$/, `${r.id}$`);
  return { source: 'wikidata' as const, key: r.id, revision: String(r.lastrevid), payload: r };
}
async function* records(...rows: ReturnType<typeof row>[]) {
  yield* rows;
}
function fake() {
  const receipts = new Map<string, { body: string; result: BatchWriteResult['results'][number] }>();
  const requests: BatchWriteRequest[] = [];
  let fenceCalls = 0;
  const transport = {
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      requests.push(structuredClone(request));
      return {
        results: request.commands.map((c) => {
          const prior = receipts.get(c.key);
          if (prior) {
            expect(JSON.stringify(c)).toBe(prior.body);
            return structuredClone(prior.result);
          }
          const result = {
            key: c.key,
            status: 200 as const,
            value:
              c.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : c.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(c.key, { body: JSON.stringify(c), result });
          return result;
        }),
      };
    },
    async readFence() {
      fenceCalls++;
      return { fenced: false, securityRevision: null };
    },
  };
  return {
    transport,
    requests,
    receipts,
    get fenceCalls() {
      return fenceCalls;
    },
  };
}
function directory() {
  return mkdtempSync(join(tmpdir(), 'importer-local-'));
}
// Capture all synchronous production SQLite entry points, including nested bindings,
// store methods and ownership. Actual SQL, returned rows and EQP come from the probe.
function instrument(importer: Importer, probe: ReturnType<typeof createSqliteProbe>) {
  let enabled = false,
    depth = 0;
  const costs = new Map<string, { rows: number; blocks: 0; statements: number }>();
  for (const [prefix, object] of [
    ['session', importer.session],
    ['store', importer.session.store],
    ['bindings', importer.session.bindings],
  ] as const) {
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(object))) {
      if (name === 'constructor' || name === 'close') continue;
      const fn = (object as any)[name];
      if (typeof fn !== 'function') continue;
      (object as any)[name] = function (...args: unknown[]) {
        if (!enabled || depth) return fn.apply(this, args);
        depth++;
        try {
          const measured = probe.measure(() => fn.apply(this, args));
          const key = `${prefix}.${name}`,
            old = costs.get(key) ?? { rows: 0, blocks: 0, statements: 0 };
          old.rows += measured.cost.rows;
          old.statements += measured.cost.statements;
          costs.set(key, old);
          return measured.value;
        } finally {
          depth--;
        }
      };
    }
  }
  return {
    start() {
      costs.clear();
      enabled = true;
    },
    finish() {
      enabled = false;
      const proof = probe.verifyPlans();
      expect(proof.some((e) => e.plan.some((p) => /^SEARCH/.test(p.detail)))).toBe(true);
      return new Map(costs);
    },
  };
}

test('actual coordinator fixed work searches same-source keys/history at three scales; command work is linear', async () => {
  const dir = directory(),
    f = fake();
  let probe!: ReturnType<typeof createSqliteProbe>;
  const importer = new Importer({
    path: `${dir}/state.sqlite`,
    transport: f.transport,
    instrumentDatabase(db) {
      probe = createSqliteProbe(db, {
        growingTables: [
          ...RUN_TABLES,
          'import_owners',
          'binding_records',
          'binding_groups',
          'binding_journal',
          'binding_candidates',
          'binding_media',
        ],
      });
      return probe.database;
    },
  });
  const capture = instrument(importer, probe),
    samples = new Map<string, GrowthSample[]>();
  try {
    for (const scale of [32, 128, 512]) {
      // One growing seed, in the same source/database. First create current claims,
      // then vanish those keys so their actual claim/candidate journals remain history.
      async function* seed() {
        yield row(1, 'Baseline');
        for (let i = 0; i < scale; i++) yield row(100 + i, `Unrelated ${i}`);
      }
      expect((await importer.runRecords(registration, seed(), { disappearanceThreshold: 1 })).status).toBe('committed');
      expect(
        (await importer.runRecords(registration, records(row(1, 'Baseline')), { disappearanceThreshold: 1 })).status,
      ).toBe('committed');
      importer.session.store.database.exec('ANALYZE');
      const beforeRequests = f.requests.length,
        beforeFences = f.fenceCalls;
      capture.start();
      const result = await importer.runRecords(registration, records(row(1, `Changed ${scale}`)));
      const costs = capture.finish();
      expect(result.status).toBe('committed');
      expect(result.new).toEqual([]);
      expect(result.changed).toEqual([]);
      expect(result.counts.changed).toBe(1);
      expect(f.requests.length - beforeRequests).toBe(1);
      expect(f.fenceCalls - beforeFences).toBe(9);
      for (const key of [
        'store.stage',
        'session.acquire',
        'session.reopen',
        'session.release',
        'store.key',
        'bindings.claim',
        'bindings.candidates',
        'store.prepare',
        'bindings.prepare',
        'bindings.acknowledge',
        'store.acknowledge',
        'store.finalize',
        'store.pageStaged',
        'store.pageVanished',
        'store.pagePending',
      ])
        expect(costs.has(key)).toBe(true);
      for (const [key, cost] of costs) {
        const group = samples.get(key) ?? [];
        group.push({ scale, cost });
        samples.set(key, group);
      }
    }
    for (const group of samples.values())
      assertGrowth(group, { rows: 'constant', blocks: 'constant', statements: 'constant' });
    const commands: GrowthSample[] = [];
    for (const count of [2, 8, 32]) {
      expect((await importer.runRecords(registration, records(row(1, 'Before', count)))).status).toBe('committed');
      importer.session.store.database.exec('ANALYZE');
      capture.start();
      const result = await importer.runRecords(registration, records(row(1, 'After', count)));
      const costs = capture.finish();
      expect(result.status).toBe('committed');
      const cost = { rows: 0, blocks: 0, statements: 0 };
      for (const value of costs.values()) {
        cost.rows += value.rows;
        cost.statements += value.statements;
      }
      commands.push({ scale: count, cost });
    }
    assertGrowth(commands, { rows: 'linear', blocks: 'constant', statements: 'linear' });
  } finally {
    probe.restore();
    await importer.close();
    rmSync(dir, { recursive: true });
  }
}, 120000);

test('source acquisition is explicitly linear and reaches EOF once before any effect', async () => {
  const samples: GrowthSample[] = [];
  for (const count of [2, 8, 32]) {
    const f = fake();
    let yielded = 0,
      complete = false,
      passes = 0;
    const importer = new Importer({
      path: ':memory:',
      transport: {
        ...f.transport,
        async batchWrite(r) {
          expect(complete).toBe(true);
          return f.transport.batchWrite(r);
        },
      },
    });
    try {
      const input = {
        async *[Symbol.asyncIterator]() {
          expect(++passes).toBe(1);
          for (let i = 0; i < count; i++) {
            yielded++;
            yield row(i + 1);
          }
          complete = true;
        },
      };
      const result = await importer.runRecords(registration, input);
      expect(result.status).toBe('committed');
      expect(yielded).toBe(count);
      expect(result.counts.new).toBe(count);
      samples.push({ scale: count, cost: { rows: yielded, blocks: 0, statements: f.requests.length + f.fenceCalls } });
    } finally {
      await importer.close();
    }
  }
  assertGrowth(samples, { rows: 'linear', blocks: 'constant', statements: 'linear' });
});

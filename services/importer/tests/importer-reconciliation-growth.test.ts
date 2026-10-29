import { expect, test } from 'bun:test';
import { mkdtempSync, rmSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';
import { RUN_TABLES } from '../src/run-store.ts';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);
const registration = createSourceRegistration('wikidata');
const identityCheck = (config: Omit<CountedCheck, 'read'>): CountedCheck => ({
  read: (value: unknown) => value as CountedValues,
  ...config,
});
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
  const costs = new Map<string, Record<string, number>>();
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
            old = costs.get(key) ?? { 'sqlite returned rows': 0, 'sqlite statements': 0 };
          old['sqlite returned rows'] = (old['sqlite returned rows'] ?? 0) + measured.counts['sqlite returned rows'];
          old['sqlite statements'] = (old['sqlite statements'] ?? 0) + measured.counts['sqlite statements'];
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

test('actual coordinator fixed work searches same-source keys/history at three scales; command width is a separate bounded axis', async () => {
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
    samples = new Map<string, { scale: number; counted: ReturnType<typeof countedSample> }[]>(),
    coordinatorSamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [],
    inputSamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  try {
    for (const scale of [64, 512, 4096]) {
      // One growing seed, in the same source/database. First create current claims,
      // then vanish those keys so their actual claim/candidate journals remain history.
      let inputPasses = 0;
      let inputRecordsRead = 0;
      let inputComplete = false;
      const batchWrite = f.transport.batchWrite.bind(f.transport);
      f.transport.batchWrite = async (request) => {
        expect(inputComplete).toBe(true);
        return batchWrite(request);
      };
      async function* seed() {
        expect(++inputPasses).toBe(1);
        inputRecordsRead++;
        yield row(1, 'Baseline');
        for (let i = 0; i < scale - 1; i++) {
          inputRecordsRead++;
          yield row(100 + i, `Unrelated ${i}`);
        }
        inputComplete = true;
      }
      expect((await importer.runRecords(registration, seed(), { disappearanceThreshold: 1 })).status).toBe('committed');
      expect(inputPasses).toBe(1);
      expect(inputRecordsRead).toBe(scale);
      inputSamples.push({ scale, counted: countedSample([{ 'input records read': inputRecordsRead }]) });
      f.transport.batchWrite = batchWrite;
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
      const totals: CountedValues = {
        'transport requests': f.requests.length - beforeRequests,
        'fence calls': f.fenceCalls - beforeFences,
        'sqlite statements': [...costs.values()].reduce((sum, value) => sum + value['sqlite statements']!, 0),
        'sqlite returned rows': [...costs.values()].reduce((sum, value) => sum + value['sqlite returned rows']!, 0),
      };
      coordinatorSamples.push({ scale, counted: countedSample([totals]) });
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
        group.push({ scale, counted: countedSample([cost]) });
        samples.set(key, group);
      }
    }
    for (const group of samples.values())
      expect(
        countedViolations(
          identityCheck({ bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' } }),
          group,
        ),
      ).toEqual([]);
    const fixedCheck = identityCheck({
      limits: { 'transport requests': 1, 'fence calls': 9 },
      bounds: {
        'transport requests': 'constant',
        'fence calls': 'constant',
        'sqlite statements': 'constant',
        'sqlite returned rows': 'constant',
      },
    });
    expect(countedViolations(fixedCheck, coordinatorSamples)).toEqual([]);
    expect(
      countedViolations(
        identityCheck({ limits: { 'input records read': 4096 }, bounds: { 'input records read': 'linear' } }),
        inputSamples,
      ),
    ).toEqual([]);
    for (const sample of inputSamples) expect(sample.counted['input records read']!.value).toBe(sample.scale);
    // M is command width within one record. These values stay well below the
    // 512-fact per-command cap; M is separate from the 64/512/4096 history axis.
    const commands: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
    for (const count of [2, 8, 32]) {
      expect((await importer.runRecords(registration, records(row(1, 'Before', count)))).status).toBe('committed');
      importer.session.store.database.exec('ANALYZE');
      capture.start();
      const result = await importer.runRecords(registration, records(row(1, 'After', count)));
      const costs = capture.finish();
      expect(result.status).toBe('committed');
      const cost: Record<string, number> = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
      for (const value of costs.values()) {
        cost['sqlite returned rows'] = cost['sqlite returned rows']! + value['sqlite returned rows']!;
        cost['sqlite statements'] = cost['sqlite statements']! + value['sqlite statements']!;
      }
      commands.push({ scale: count, counted: countedSample([cost]) });
    }
    expect(
      countedViolations(
        identityCheck({ bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'linear' } }),
        commands,
      ),
    ).toEqual([]);
  } finally {
    probe.restore();
    await importer.close();
    rmSync(dir, { recursive: true });
  }
}, 120000);

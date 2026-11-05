import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtempSync, readFileSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedValues,
} from '../../kernel/test/support/growth-counters.ts';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { RUN_TABLES } from '../src/run-store.ts';
import { createSqliteProbe } from './support/sqlite-growth.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const registration = createSourceRegistration('wikidata');
const fixture = JSON.parse(
  readFileSync(join(import.meta.dir, '../../../specs/fixtures/imports/ledger/wikidata.jsonl'), 'utf8').split('\n')[0]!,
);
const identityCheck = (config: Omit<CountedCheck, 'read'>): CountedCheck => ({
  read: (value: unknown) => value as CountedValues,
  ...config,
});

function row(id: number) {
  const r = structuredClone(fixture);
  r.id = `Q${id}`;
  r.labels.en.value = `Growth ${id}`;
  for (const claims of Object.values(r.claims) as { id: string }[][])
    for (const c of claims) c.id = c.id.replace(/^Q1\$/, `${r.id}$`);
  return { source: 'wikidata' as const, key: r.id, revision: String(r.lastrevid), payload: r };
}

async function* records(count: number, start = 1) {
  for (let id = start; id < start + count; id++) yield row(id);
}

function fake() {
  let effects = 0;
  const receipts = new Map<string, BatchWriteResult['results'][number]>();
  const transport = {
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      effects += request.commands.length;
      return {
        results: request.commands.map((command) => {
          const prior = receipts.get(command.key);
          if (prior) return structuredClone(prior);
          const result = {
            key: command.key,
            status: 200 as const,
            value:
              command.op === 'create'
                ? { id: randomUUID(), revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, result);
          return result;
        }),
      };
    },
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
  };
  return {
    transport,
    get effects() {
      return effects;
    },
  };
}

const MEASURED = new Set([
  'acquire',
  'peekActive',
  'reopen',
  'release',
  'pageStaged',
  'pagePending',
  'pageVanished',
  'pageDeferredCovers',
  'finalize',
  'skipped',
  'activeRun',
]);

function instrument(importer: Importer, probe: ReturnType<typeof createSqliteProbe>) {
  let enabled = false,
    depth = 0;
  const costs = new Map<string, Record<string, number>>();
  for (const [prefix, object] of [
    ['session', importer.session],
    ['store', importer.session.store],
  ] as const) {
    for (const name of Object.getOwnPropertyNames(Object.getPrototypeOf(object))) {
      if (name === 'constructor' || name === 'close' || !MEASURED.has(name)) continue;
      const fn = (object as unknown as Record<string, unknown>)[name];
      if (typeof fn !== 'function') continue;
      (object as unknown as Record<string, unknown>)[name] = function (...args: unknown[]) {
        if (!enabled || depth) return (fn as (...a: unknown[]) => unknown).apply(this, args);
        depth++;
        try {
          const measured = probe.measure(() => (fn as (...a: unknown[]) => unknown).apply(this, args));
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
      probe.verifyPlans();
      return new Map(costs);
    },
  };
}

test('production resume path stays within indexed bound as sealed work and unrelated history grow', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'resume-growth-'));
  const resumeSamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  const admissionSamples: { scale: number; counted: ReturnType<typeof countedSample> }[] = [];
  try {
    for (const scale of [32, 128, 512] as const) {
      const state = `${dir}/${scale}.sqlite`;
      const f = fake();
      let lose = true;
      const interrupting = {
        ...f.transport,
        async batchWrite(request: BatchWriteRequest) {
          const result = await f.transport.batchWrite(request);
          if (lose && request.commands.some((command) => command.op === 'propose')) {
            lose = false;
            throw new DOMException('growth ack loss', 'AbortError');
          }
          return result;
        },
      };
      const setup = new Importer({ path: state, transport: interrupting });
      expect(['interrupted', 'bulk-failed']).toContain((await setup.runRecords(registration, records(scale))).status);
      for (let extra = 0; extra < scale; extra++) {
        const other = createSourceRegistration('wikidata', { source: `history-${scale}-${extra}` });
        expect((await setup.runRecords(other, records(1, 50_000 + extra))).status).toBe('committed');
      }
      const sealed = setup.session.store.activeRun('wikidata');
      expect(sealed).not.toBeNull();
      expect(setup.session.store.pagePending(sealed!, { limit: 8 }).length).toBeGreaterThan(0);
      await setup.close();

      let retained = 0;
      let probe!: ReturnType<typeof createSqliteProbe>;
      const resume = new Importer({
        path: state,
        transport: f.transport,
        existing: true,
        observer: {
          onPageRetained(_phase, records) {
            retained = Math.max(retained, records.length);
          },
        },
        instrumentDatabase(database) {
          probe = createSqliteProbe(database, {
            growingTables: [...RUN_TABLES, 'import_owners', 'binding_records', 'binding_groups', 'binding_journal'],
          });
          return probe.database;
        },
      });
      const capture = instrument(resume, probe);
      try {
        resume.session.store.database.exec('ANALYZE');
        capture.start();
        const own = resume.session.acquire('wikidata');
        if (own === 'busy') throw new Error('busy');
        resume.session.peekActive(own);
        resume.session.release(own);
        const admission = capture.finish();
        const admissionStatements = [...admission.values()].reduce(
          (sum, value) => sum + (value['sqlite statements'] ?? 0),
          0,
        );
        expect(admissionStatements).toBeLessThan(16);
        admissionSamples.push({
          scale,
          counted: countedSample([{ 'sqlite statements': admissionStatements, 'sqlite returned rows': 1 }]),
        });

        const beforeEffects = f.effects;
        capture.start();
        const result = await resume.resumeExisting(registration);
        const costs = capture.finish();
        expect(result.status, result.diagnostic).toBe('committed');
        expect(retained).toBeLessThanOrEqual(100);
        expect(f.effects - beforeEffects).toBeGreaterThan(0);
        expect(resume.session.store.activeRun('wikidata')).toBeNull();
        let statements = 0;
        let rows = 0;
        for (const value of costs.values()) {
          statements += value['sqlite statements'] ?? 0;
          rows += value['sqlite returned rows'] ?? 0;
        }
        resumeSamples.push({
          scale,
          counted: countedSample([{ 'sqlite statements': statements, 'sqlite returned rows': rows }]),
        });
      } finally {
        probe.restore();
        await resume.close();
      }
    }
    expect(
      countedViolations(
        identityCheck({ bounds: { 'sqlite statements': 'linear', 'sqlite returned rows': 'linear' } }),
        resumeSamples,
      ),
    ).toEqual([]);
    expect(
      countedViolations(
        identityCheck({ bounds: { 'sqlite statements': 'constant', 'sqlite returned rows': 'constant' } }),
        admissionSamples,
      ),
    ).toEqual([]);
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
}, 180_000);

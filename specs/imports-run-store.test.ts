import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { checkBatchWrite, type BatchCommand, type BatchWriteResult } from '@rezics/definitions/bulk';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedSample,
  type CountedValues,
} from '../services/kernel/test/support/growth-counters.ts';
import {
  CAPS,
  MISSING_RUN_STORE_DRIVER,
  runStoreCounts,
  type CreateImportRunStoreDriver,
  type Run,
  type RunStoreDriver,
  type Staged,
  type Pending,
} from './imports-run-store-driver.ts';

const fixedCounts: CountedCheck<CountedValues> = {
  read: (counts) => counts,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};

const SOURCE = 'wikidata';
const PRIVATE = 'PRIVATE_SOURCE_BODY_DO_NOT_PERSIST';
// A storage fixture, deliberately independent of the not-yet-landed converter.
// Raw Wikidata remains in this caller. Only a sanitized statement goes to stage.
function input(key = 'Q1', title = 'Durable book', source = SOURCE, revision?: number): Staged {
  const raw = JSON.stringify({
    type: 'item',
    id: key,
    ...(revision === undefined ? {} : { lastrevid: revision }),
    labels: { en: { language: 'en', value: title } },
    claims: {
      P31: [
        {
          type: 'statement',
          rank: 'normal',
          mainsnak: {
            snaktype: 'value',
            property: 'P31',
            datatype: 'wikibase-item',
            datavalue: { type: 'wikibase-entityid', value: { id: 'Q571', 'entity-type': 'item', 'numeric-id': 571 } },
          },
        },
      ],
    },
    private_text: PRIVATE,
    posts: [{ body: PRIVATE }],
  });
  const entity = JSON.parse(raw);
  const statement = {
    property: { id: 'schema:name' },
    value: { type: 'value' as const, content: { language: 'en', text: entity.labels.en.value } },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:sameAs' },
            value: { type: 'value' as const, content: `http://www.wikidata.org/entity/${key}` },
          },
        ],
      },
    ],
  };
  const projection = [statement];
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: revision === undefined ? 'unversioned' : String(revision),
      digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(projection)).digest('hex'),
      converter_revision: 'fixture@1',
      state: 'present',
    },
    projection,
  };
}
function commands(record: Staged, suffix = 'one'): BatchCommand[] {
  const row = record.row;
  const result: BatchCommand[] = [
    {
      op: 'propose',
      key: `${row.source}:${row.recordKey}:${row.digest}:${suffix}`,
      source: {
        source: row.source,
        external_id: row.recordKey,
        record_revision: row.recordRevision,
        digest: row.digest,
        converter_revision: row.converter_revision,
        field_group: 'facts',
      },
      // Existing subject fixture identity; the store does not bootstrap subjects.
      subject: '00000000-0000-4000-8000-000000000001',
      statement: record.projection[0]!,
    },
  ];
  expect(checkBatchWrite({ commands: result })).toEqual([]);
  return result;
}
const ack = (keys: string[]): BatchWriteResult => ({
  results: keys.map((key) => ({ key, status: 200, value: { revision: 1 } })),
});
const reject = (keys: string[]): BatchWriteResult => ({
  results: keys.map((key) => ({ key, status: 409, problem: { type: 'conflict', title: 'Conflict', status: 409 } })),
});
async function safeRejection(operation: Promise<unknown>) {
  let rejected = false;
  try {
    await operation;
  } catch (error) {
    rejected = true;
    expect(String(error)).not.toContain(PRIVATE);
  }
  expect(rejected).toBe(true);
}
async function privateBytesAbsent(directory: string) {
  for await (const path of new Bun.Glob('**/*').scan({ cwd: directory, onlyFiles: true })) {
    const bytes = Buffer.from(await Bun.file(`${directory}/${path}`).arrayBuffer());
    expect(bytes.includes(Buffer.from(PRIVATE))).toBe(false);
  }
}
async function withStore(work: (h: Harness) => Promise<void>) {
  // Resolve inside each scenario: missing binding must make EVERY test red.
  const path = process.env.IMPORT_RUN_STORE_DRIVER;
  if (!path) throw new Error(MISSING_RUN_STORE_DRIVER);
  const factory = (await import(path)).createImportRunStoreDriver as CreateImportRunStoreDriver;
  expect(typeof factory).toBe('function');
  const directory = await mkdtemp(join(tmpdir(), 'import-run-store-'));
  const h = new Harness(factory, directory, await factory({ directory }));
  try {
    await work(h);
  } finally {
    await h.d.close();
    await rm(directory, { recursive: true, force: true });
  }
}
class Harness {
  constructor(
    readonly factory: CreateImportRunStoreDriver,
    readonly directory: string,
    public d: RunStoreDriver,
  ) {}
  async begin(source = SOURCE, disappearanceThreshold?: number) {
    const run = await this.d.begin(source, disappearanceThreshold === undefined ? {} : { disappearanceThreshold });
    expect(run).not.toBe('busy');
    if (run === 'busy') throw new Error('Unexpected busy run');
    return run;
  }
  async reopen(run: Run) {
    await this.d.close();
    this.d = await this.factory({ directory: this.directory });
    return this.d.reopen(run);
  }
  async stage(records: Staged[], threshold?: number) {
    const run = await this.begin(records[0]?.row.source ?? SOURCE, threshold);
    for (const record of records) await this.d.stage(run, record);
    return run;
  }
  async ready(records: Staged[], threshold?: number) {
    const run = await this.stage(records, threshold);
    expect((await this.d.seal(run, { complete: true })).status).toBe('ready');
    return run;
  }
  async drain(run: Run) {
    let after: string | undefined;
    const all: Pending[] = [];
    for (;;) {
      const page = await this.d.pagePending(run, { ...(after ? { after } : {}), limit: 2 });
      expect(page.length).toBeLessThanOrEqual(2);
      if (!page.length) return all;
      expect(all.length).toBeLessThan(2000);
      for (const entry of page) {
        expect(checkBatchWrite(JSON.parse(entry.bytes))).toEqual([]);
        expect(JSON.parse(entry.bytes).commands.map((c: BatchCommand) => c.key)).toEqual(entry.keys);
        expect(entry.after > (after ?? '')).toBe(true);
        all.push(entry);
        after = entry.after;
      }
    }
  }
  async finish(run: Run) {
    for (let pages = 0; pages < 2000; pages++) {
      const status = await this.d.finalize(run, 2);
      if (status === 'complete') return;
      expect(status).toBe('more');
    }
    throw new Error('Finalization did not terminate');
  }
  async seed(records: Staged[]) {
    const run = await this.ready(records);
    for (const record of records) await this.d.classify(run, record.row.recordKey, { commands: commands(record) });
    for (const entry of await this.drain(run)) await this.d.acknowledge(run, ack(entry.keys));
    await this.finish(run);
    return this.d.source(records[0]?.row.source ?? SOURCE);
  }
}

test('source isolation and durable per-source leases allow another source to progress', async () =>
  withStore(async (h) => {
    const run = await h.begin();
    await h.d.stage(run, input());
    const peer = await h.factory({ directory: h.directory });
    try {
      expect(await peer.begin(SOURCE)).toBe('busy');
      const race = await Promise.all([h.d.begin('wikidata_race'), peer.begin('wikidata_race')]);
      expect(race.filter((result) => result === 'busy')).toHaveLength(1);
      const winner = race.find((result) => result !== 'busy');
      if (!winner) throw new Error('No durable lease won');
      expect(await h.d.abandon(winner)).toBe('abandoned');
      await h.seed([input('Q1', 'Other source', 'wikidata_other')]);
      expect((await h.d.source(SOURCE)).generation).toBeNull();
      expect((await peer.key('wikidata_other', 'Q1')).baseline?.digest).not.toBe(input().row.digest);
    } finally {
      await peer.close();
    }
    const resumed = await h.reopen(run);
    expect(await h.d.begin(SOURCE)).toBe('busy');
    await expect(h.d.stage(run, input('Q2'))).rejects.toThrow();
    expect((await h.d.key(SOURCE, 'Q1', resumed)).staged).toEqual(input());
    expect(await h.d.abandon(resumed)).toBe('abandoned');
  }));

test('late malformed truncated and duplicate input invalidate staged runs without proposals or baseline', async () =>
  withStore(async (h) => {
    const baseline = await h.seed([input()]);
    for (const reason of ['malformed', 'truncated', 'duplicate'] as const) {
      const run = await h.stage([input('Q1', 'Changed'), input('Q2')]);
      await expect(h.d.classify(run, 'Q1', { commands: commands(input('Q1', 'Changed')) })).rejects.toThrow();
      expect(await h.d.pagePending(run, { limit: 8 })).toEqual([]);
      if (reason === 'duplicate') await expect(h.d.stage(run, input('Q2'))).rejects.toThrow();
      else {
        const tail = reason === 'malformed' ? `{"private_text":"${PRIVATE}",}` : `{"private_text":"${PRIVATE}`;
        expect(() => JSON.parse(tail)).toThrow();
      }
      const sealed = await h.d.seal(run, reason === 'duplicate' ? { complete: true } : { complete: false, reason });
      expect(sealed.status).toBe('invalid-input');
      expect(sealed.diagnostic).not.toContain(PRIVATE);
      expect(await h.d.pagePending(run, { limit: 8 })).toEqual([]);
      expect(await h.d.source(SOURCE)).toEqual(baseline);
      expect((await h.d.key(SOURCE, 'Q2', run)).staged).toBeNull();
      expect((await h.d.key(SOURCE, 'Q1', run)).staged).toBeNull();
      expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(input().row);
      await expect(h.d.finalize(run, 8)).rejects.toThrow();
    }
  }));

test('maintained survivor counters permit exactly twenty percent and block strictly greater before dispatch', async () =>
  withStore(async (h) => {
    const records = Array.from({ length: 5 }, (_, i) => input(`Q${i + 1}`));
    const baseline = await h.seed(records);
    let run = await h.stage(records.slice(0, 4));
    expect(await h.d.seal(run, { complete: true })).toMatchObject({
      status: 'ready',
      prior: 5,
      seenSurvivors: 4,
      supplied: 4,
    });
    expect(await h.d.abandon(run)).toBe('abandoned');
    // Newly supplied records do not count as survivors of the old snapshot.
    run = await h.stage([...records.slice(0, 3), input('Q99'), input('Q100')]);
    expect(await h.d.seal(run, { complete: true })).toMatchObject({
      status: 'mass-disappearance',
      prior: 5,
      seenSurvivors: 3,
      supplied: 5,
    });
    await expect(h.d.classify(run, 'Q99', { commands: commands(input('Q99')) })).rejects.toThrow();
    expect(await h.d.pagePending(run, { limit: 8 })).toEqual([]);
    expect(await h.d.source(SOURCE)).toEqual(baseline);
  }));

test('thresholds validate zero through one and all missing always blocks even at one', async () =>
  withStore(async (h) => {
    for (const value of [-1, 1.01, NaN, Infinity])
      await expect(h.d.begin(SOURCE, { disappearanceThreshold: value })).rejects.toThrow();
    await h.seed([input('Q1'), input('Q2')]);
    const zero = await h.stage([input('Q1')], 0);
    expect((await h.d.seal(zero, { complete: true })).status).toBe('mass-disappearance');
    const one = await h.begin(SOURCE, 1);
    expect((await h.d.seal(one, { complete: true })).status).toBe('mass-disappearance');
    const allowed = await h.ready([input('Q1')], 1);
    expect(await h.d.abandon(allowed)).toBe('abandoned');
  }));

test('pending typed bytes and keys are durable before transport and ignore future input changes', async () =>
  withStore(async (h) => {
    const record = input('Q1', 'Escaped "title"\nwith Unicode 書');
    let run = await h.ready([record]);
    expect(await h.d.classify(run, 'Q1', { commands: commands(record) })).toBe('new');
    const before = await h.drain(run); // No transport or acknowledgement has happened.
    expect(before.length).toBeGreaterThan(0);
    expect(before.flatMap((p) => p.keys)).toEqual(commands(record).map((c) => c.key));
    expect((await h.d.source(SOURCE)).generation).toBeNull();
    run = await h.reopen(run);
    expect(await h.drain(run)).toEqual(before);
    await expect(h.d.stage(run, input('Q1', 'Source changed after crash'))).rejects.toThrow();
    expect(await h.d.begin(SOURCE)).toBe('busy');
    expect(await h.drain(run)).toEqual(before);
    for (const entry of before) await h.d.acknowledge(run, ack(entry.keys));
    await h.finish(run);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(record.row);
  }));

test('partial and rejected acknowledgements preserve full snapshot while independent record metadata survives', async () =>
  withStore(async (h) => {
    const old = [input('Q1'), input('Q2')];
    const baseline = await h.seed(old);
    const next = [input('Q1', 'Changed A'), input('Q2', 'Changed B')];
    let run = await h.ready(next);
    for (const r of next) await h.d.classify(run, r.row.recordKey, { commands: commands(r) });
    const pending = await h.drain(run);
    const first = commands(next[0]!)[0]!.key,
      second = commands(next[1]!)[0]!.key;
    await h.d.acknowledge(run, { results: [...ack([first]).results, ...reject([second]).results] });
    expect(await h.d.finalize(run, 8)).toBe('incomplete');
    expect(await h.d.source(SOURCE)).toEqual(baseline);
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(next[0]!.row);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(old[0]!.row);
    expect((await h.d.key(SOURCE, 'Q2')).acknowledged).toEqual(old[1]!.row);
    run = await h.reopen(run);
    expect(await h.d.source(SOURCE)).toEqual(baseline);
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(next[0]!.row);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(old[0]!.row);
    expect((await h.drain(run)).flatMap((p) => p.keys)).toEqual([second]);
    const retry = (await h.drain(run))[0]!;
    expect(pending.some((p) => p.bytes === retry.bytes && p.keys.includes(second))).toBe(true);
    await h.d.acknowledge(run, ack([second]));
    await h.finish(run);
    const complete = await h.d.source(SOURCE);
    expect(complete.generation).not.toBe(baseline.generation);
    expect(await h.d.finalize(run, 8)).toBe('complete');
    expect(await h.d.source(SOURCE)).toEqual(complete);
  }));

test('missing command results and within-record partial acknowledgements cannot advance the record', async () =>
  withStore(async (h) => {
    const record = input();
    const run = await h.ready([record]);
    const two = [...commands(record, 'a'), ...commands(record, 'b')];
    expect(checkBatchWrite({ commands: two })).toEqual([]);
    await h.d.classify(run, 'Q1', { commands: two });
    await h.d.acknowledge(run, ack([two[0]!.key]));
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toBeNull();
    expect(await h.d.finalize(run, 8)).toBe('incomplete');
    await expect(h.d.acknowledge(run, ack(['unknown-key']))).rejects.toThrow();
    await h.d.acknowledge(run, ack([two[1]!.key]));
    await h.finish(run);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(record.row);
  }));

test('interrupt after API effect before local ack replays identical payload and idempotency keys', async () =>
  withStore(async (h) => {
    let run = await h.ready([input()]);
    await h.d.classify(run, 'Q1', { commands: commands(input()) });
    const attempted = await h.drain(run);
    const effects = new Map<string, string>();
    const transport = (pages: Pending[]) => {
      for (const p of pages)
        for (const key of p.keys) {
          if (effects.has(key)) expect(effects.get(key)).toBe(p.bytes);
          effects.set(key, p.bytes);
        }
    };
    transport(attempted); // Actual fixture API boundary; intentionally no local ack.
    run = await h.reopen(run);
    const replay = await h.drain(run);
    expect(replay).toEqual(attempted);
    transport(replay);
    expect(effects.size).toBe(attempted.flatMap((p) => p.keys).length);
    for (const p of replay) await h.d.acknowledge(run, ack(p.keys));
    await h.finish(run);
  }));

test('identical baselines stay stable and missing native revision remains unversioned', async () =>
  withStore(async (h) => {
    const record = input();
    const before = await h.seed([record]);
    const run = await h.ready([record]);
    expect(await h.d.classify(run, 'Q1', { commands: [] })).toBe('unchanged');
    expect(await h.drain(run)).toEqual([]);
    await h.finish(run);
    expect(await h.d.source(SOURCE)).toEqual(before);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(record.row);
    expect(record.row.recordRevision).toBe('unversioned');
    const changed = input('Q1', 'Updated without native revision');
    const next = await h.ready([changed]);
    expect(await h.d.classify(next, 'Q1', { commands: commands(changed) })).toBe('changed');
    for (const p of await h.drain(next)) await h.d.acknowledge(next, ack(p.keys));
    await h.finish(next);
    expect((await h.d.key(SOURCE, 'Q1')).baseline?.recordRevision).toBe('unversioned');
  }));

test('explicit persisted fenced omission resolves only its group and never acknowledges an unfenced failure', async () =>
  withStore(async (h) => {
    const record = input();
    let run = await h.ready([record]);
    const command = commands(record);
    await h.d.classify(run, 'Q1', { commands: command });
    await h.d.acknowledge(run, reject(command.map((c) => c.key)));
    await expect(
      h.d.classify(run, 'Q1', {
        commands: [],
        omissions: [{ field_group: 'facts', disposition: 'unfenced', securityRevision: '2' } as never],
      }),
    ).rejects.toThrow();
    for (const unproved of [
      { field_group: 'facts', disposition: 'fenced', securityRevision: null },
      { field_group: 'facts', disposition: 'fenced' },
    ]) {
      await expect(h.d.classify(run, 'Q1', { commands: [], omissions: [unproved as never] })).rejects.toThrow();
    }
    expect(await h.d.finalize(run, 8)).toBe('incomplete');
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toBeNull();
    await h.d.classify(run, 'Q1', {
      commands: [],
      omissions: [{ field_group: 'summary', disposition: 'fenced', securityRevision: '2' }],
    });
    expect(await h.d.finalize(run, 8)).toBe('incomplete');
    expect((await h.drain(run)).flatMap((p) => p.keys)).toEqual(command.map((c) => c.key));
    const omission = { field_group: 'facts' as const, disposition: 'fenced' as const, securityRevision: '3' };
    await h.d.classify(run, 'Q1', { commands: [], omissions: [omission] });
    run = await h.reopen(run);
    expect((await h.d.key(SOURCE, 'Q1', run)).omissions).toContainEqual(omission);
    expect(await h.drain(run)).toEqual([]);
    await h.finish(run);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(record.row);
  }));

test('fenced omission retains the actual opaque content security revision', async () =>
  withStore(async (h) => {
    const record = input();
    let run = await h.ready([record]);
    // Orchestration supplies the actual non-null readFences proof; storage keeps its exact bytes.
    const omission = {
      field_group: 'facts' as const,
      disposition: 'fenced' as const,
      securityRevision: '9007199254740993',
    };
    await h.d.classify(run, 'Q1', { commands: [], omissions: [omission] });
    expect((await h.d.key(SOURCE, 'Q1', run)).omissions).toEqual([omission]);
    run = await h.reopen(run);
    const stored = (await h.d.key(SOURCE, 'Q1', run)).omissions;
    expect(stored).toEqual([omission]);
    expect(stored[0]!.securityRevision).toBe('9007199254740993');
    expect(typeof stored[0]!.securityRevision).toBe('string');
    expect(await h.drain(run)).toEqual([]);
    await h.finish(run);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(record.row);
  }));

test('vanished pages are source generation specific capped keysets excluding failed staged history', async () =>
  withStore(async (h) => {
    const records = Array.from({ length: 10 }, (_, i) => input(`Q${String(i).padStart(3, '0')}`));
    await h.seed(records);
    await h.seed([input('Qdecoy', 'Other', 'wikidata_other')]);
    const failed = await h.stage([input('Qfailed')]);
    expect((await h.d.seal(failed, { complete: false, reason: 'truncated' })).status).toBe('invalid-input');
    const run = await h.ready(records.slice(0, 6), 1);
    const first = await h.d.pageVanished(run, { limit: 2 });
    expect(first).toEqual(records.slice(6, 8).map((r) => r.row));
    const second = await h.d.pageVanished(run, { after: first[1]!.recordKey, limit: 2 });
    expect(second).toEqual(records.slice(8).map((r) => r.row));
    expect(await h.d.pageVanished(run, { after: second[1]!.recordKey, limit: 2 })).toEqual([]);
    for (const r of records.slice(0, 6)) await h.d.classify(run, r.row.recordKey, { commands: [] });
    expect(await h.d.finalize(run, 2)).toBe('incomplete'); // Vanished still require disposition.
    for (const r of records.slice(6)) {
      const c = commands(r)[0]!;
      const retract: BatchCommand = {
        op: 'retract',
        key: `${c.key}:retract`,
        source: c.source,
        subject: '00000000-0000-4000-8000-000000000001',
        candidate: '00000000-0000-4000-8000-000000000002',
        references: r.projection[0]!.references,
      };
      expect(checkBatchWrite({ commands: [retract] })).toEqual([]);
      expect(await h.d.classify(run, r.row.recordKey, { commands: [retract] })).toBe('vanished');
    }
    for (const p of await h.drain(run)) await h.d.acknowledge(run, ack(p.keys));
    await h.finish(run);
    expect((await h.d.source(SOURCE)).count).toBe(6);
    expect((await h.d.key(SOURCE, records[6]!.row.recordKey)).acknowledged?.state).toBe('vanished');
    expect((await h.d.key(SOURCE, 'Qfailed')).baseline).toBeNull();
  }));

test('bounded keys projections commands pages and safe diagnostics never persist private source text', async () =>
  withStore(async (h) => {
    const record = input();
    const run = await h.begin();
    await expect(
      h.d.stage(run, { ...record, row: { ...record.row, recordKey: 'Q'.repeat(CAPS.keyBytes + 1) } }),
    ).rejects.toThrow();
    await safeRejection(h.d.stage(run, input('Q2', PRIVATE.repeat(4000))));
    await safeRejection(h.d.stage(run, { ...record, raw: PRIVATE } as never));
    await h.d.abandon(run);
    const ready = await h.ready([record]);
    for (const limit of [0, 101, 1.5]) {
      await expect(h.d.pagePending(ready, { limit })).rejects.toThrow();
      await expect(h.d.pageVanished(ready, { limit })).rejects.toThrow();
      await expect(h.d.finalize(ready, limit)).rejects.toThrow();
    }
    const tooMany = Array.from({ length: 101 }, (_, i) => commands(record, String(i))[0]!);
    await expect(h.d.classify(ready, 'Q1', { commands: tooMany })).rejects.toThrow();
    const wrongRecord = commands(record)[0]!;
    await expect(
      h.d.classify(ready, 'Q1', {
        commands: [{ ...wrongRecord, source: { ...wrongRecord.source, external_id: 'Qother' } }],
      }),
    ).rejects.toThrow();
    const malformed = { ...commands(record)[0]!, op: 'unknown' } as never;
    expect(checkBatchWrite({ commands: [malformed] }).length).toBeGreaterThan(0);
    await expect(h.d.classify(ready, 'Q1', { commands: [malformed] })).rejects.toThrow();
    const big = commands(input('Q1', PRIVATE.repeat(4000)));
    await safeRejection(h.d.classify(ready, 'Q1', { commands: big }));
    await h.d.classify(ready, 'Q1', { commands: commands(record) });
    expect(JSON.stringify(await h.d.persisted())).not.toContain(PRIVATE);
    await privateBytesAbsent(h.directory);
    const resumed = await h.reopen(ready);
    expect((await h.d.key(SOURCE, 'Q1', resumed)).staged).toEqual(record);
    expect(JSON.stringify(await h.d.persisted())).not.toContain(PRIVATE);
    await privateBytesAbsent(h.directory);
  }));

test('abandoned staging never becomes baseline and prepared commands require exact resume', async () =>
  withStore(async (h) => {
    const run = await h.stage([input()]);
    expect(await h.d.abandon(run)).toBe('abandoned');
    const next = await h.ready([input('Q2')]);
    expect((await h.d.key(SOURCE, 'Q1', next)).staged).toBeNull();
    await expect(h.d.seal(run, { complete: true })).rejects.toThrow();
    await h.d.classify(next, 'Q2', { commands: commands(input('Q2')) });
    expect(await h.d.abandon(next)).toBe('pending-work');
    const resumed = await h.reopen(next);
    expect((await h.d.source(SOURCE)).generation).toBeNull();
    for (const p of await h.drain(resumed)) await h.d.acknowledge(resumed, ack(p.keys));
    await h.finish(resumed);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toBeNull();
    expect((await h.d.key(SOURCE, 'Q2')).baseline).toEqual(input('Q2').row);
  }));

// One deterministic population grows in the SAME storage and source. Each
// prefix creates current keys AND three historical revisions of those keys.
// Fixed-key work never includes this setup. No driver seed/outcome simulator.
async function grow(h: Harness, size: number) {
  const unrelated = Array.from({ length: size }, (_, i) => `Qhistory${String(i).padStart(4, '0')}`);
  const vanished = Array.from({ length: 8 }, (_, i) => input(`Qvanished${i}`));
  for (let revision = 0; revision < 3; revision++) {
    await h.seed([
      ...unrelated.map((key) => input(key, `History ${revision}`, SOURCE, revision + 1)),
      input('Qfixed'),
      ...vanished,
    ]);
  }
  return {
    supplied: [...unrelated.map((key) => input(key, 'History 2', SOURCE, 3)), input('Qfixed', 'Fixed change')],
    vanished,
  };
}

test(
  'three-scale actual SQLite evidence bounds counters classify ack and vanished pages independent of same-source history',
  async () =>
    withStore(async (h) => {
      const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
      const finalizationTotals: { scale: number; counted: CountedSample }[] = [];
      const measure = async <T>(
        name: string,
        scale: number,
        operation: () => Promise<T>,
        maxRows: number,
        maxStatements: number,
      ) => {
        const result = await h.d.measure(operation);
        const counts = runStoreCounts(result.evidence, 8);
        expect(counts['sqlite returned rows']).toBeLessThanOrEqual(maxRows);
        expect(counts['sqlite statements']).toBeLessThanOrEqual(maxStatements);
        if (!samples.has(name)) samples.set(name, []);
        samples.get(name)!.push({ scale, counted: countedSample([counts]) });
        return result.value;
      };
      for (const scale of [32, 128, 512]) {
        const { supplied, vanished } = await grow(h, scale);
        const abandoned = await h.stage([input('Qfailed-history')], 1);
        await h.d.seal(abandoned, { complete: false, reason: 'malformed' });
        const blocked = await h.stage([input('Qfixed')]);
        await h.d.analyze();
        expect(
          (await measure('blocked counter-only seal', scale, () => h.d.seal(blocked, { complete: true }), 8, 16))
            .status,
        ).toBe('mass-disappearance');
        expect(await h.d.pagePending(blocked, { limit: 8 })).toEqual([]);
        await h.d.analyze();
        let run = await measure('exact source begin', scale, () => h.begin(SOURCE, 1), 8, 16);
        for (const record of supplied) await h.d.stage(run, record);
        await h.d.analyze();
        const sealed = await measure('counter-only seal', scale, () => h.d.seal(run, { complete: true }), 8, 16);
        expect(sealed).toMatchObject({
          status: 'ready',
          prior: scale + 9,
          seenSurvivors: scale + 1,
          supplied: scale + 1,
        });
        expect(
          await measure(
            'fixed classify',
            scale,
            () => h.d.classify(run, 'Qfixed', { commands: commands(input('Qfixed', 'Fixed change')) }),
            64,
            48,
          ),
        ).toBe('changed');
        const page = await measure('fixed pending page', scale, () => h.d.pagePending(run, { limit: 8 }), 8, 16);
        expect(page.flatMap((p) => p.keys)).toEqual(commands(input('Qfixed', 'Fixed change')).map((c) => c.key));
        await measure('fixed acknowledge', scale, () => h.d.acknowledge(run, ack(page.flatMap((p) => p.keys))), 64, 48);
        const missing = await measure(
          'fixed vanished page',
          scale,
          () => h.d.pageVanished(run, { after: 'Qvanished0', limit: 3 }),
          3,
          16,
        );
        expect(missing).toEqual(vanished.slice(1, 4).map((r) => r.row));
        // Resolve only the actual S and D entries; finalization can page those, but
        // must not reset/scan every historical key. Its pages are also measured.
        for (const record of supplied.filter((r) => r.row.recordKey !== 'Qfixed'))
          await h.d.classify(run, record.row.recordKey, { commands: [] });
        for (const record of vanished)
          await h.d.classify(run, record.row.recordKey, {
            commands: [],
            omissions: [{ field_group: 'facts', disposition: 'fenced', securityRevision: '1' }],
          });
        let status = 'more';
        const total = { 'sqlite returned rows': 0, 'sqlite statements': 0 };
        for (let pages = 0; status !== 'complete'; pages++) {
          expect(pages).toBeLessThan(scale + 20);
          const measured = await h.d.measure(() => h.d.finalize(run, 8));
          const counts = runStoreCounts(measured.evidence, 8);
          expect(counts['sqlite returned rows']).toBeLessThanOrEqual(128);
          expect(counts['sqlite statements']).toBeLessThanOrEqual(256);
          total['sqlite returned rows'] += counts['sqlite returned rows'];
          total['sqlite statements'] += counts['sqlite statements'];
          status = measured.value;
          expect(['more', 'complete']).toContain(status);
          if (pages === 0) {
            if (!samples.has('bounded finalization page')) samples.set('bounded finalization page', []);
            samples.get('bounded finalization page')!.push({ scale, counted: countedSample([counts]) });
            if (status === 'more') {
              run = await h.reopen(run);
              await h.d.analyze();
            }
          }
        }
        finalizationTotals.push({ scale, counted: countedSample([total]) });
      }
      for (const group of samples.values()) expect(countedViolations(fixedCounts, group)).toEqual([]);
      expect(
        countedViolations(
          { ...fixedCounts, bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'linear' } },
          finalizationTotals,
        ),
      ).toEqual([]);
    }),
  120_000,
);

test(
  'one-pass supplied staging grows linearly separately from persistent-history indexed operations',
  async () =>
    withStore(async (h) => {
      const samples: { scale: number; counted: CountedSample }[] = [];
      for (const scale of [32, 128, 512]) {
        const { supplied } = await grow(h, scale);
        const run = await h.begin(SOURCE, 1);
        await h.d.analyze();
        let visits = 0;
        const result = await h.d.measure(async () => {
          // Caller streams exactly S sanitized projections, retaining one at a time.
          for (const record of supplied) {
            visits++;
            await h.d.stage(run, record);
          }
        });
        expect(visits).toBe(scale + 1);
        const counts = runStoreCounts(result.evidence);
        expect(counts['sqlite returned rows']).toBeLessThanOrEqual(16 * visits);
        expect(counts['sqlite statements']).toBeGreaterThanOrEqual(visits);
        expect(counts['sqlite statements']).toBeLessThanOrEqual(32 * visits);
        samples.push({ scale, counted: countedSample([counts]) });
        expect(await h.d.abandon(run)).toBe('abandoned');
      }
      expect(
        countedViolations(
          { ...fixedCounts, bounds: { 'sqlite returned rows': 'linear', 'sqlite statements': 'linear' } },
          samples,
        ),
      ).toEqual([]);
    }),
  120_000,
);

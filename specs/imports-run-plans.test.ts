import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fromPlainText, serializeDocument } from '@rezics/document';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  type BatchCommand,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import {
  countedSample,
  countedViolations,
  type CountedCheck,
  type CountedSample,
  type CountedValues,
} from '../services/kernel/test/support/growth-counters.ts';
import { runStoreCounts, type Run, type Staged, type Pending } from './imports-run-store-driver.ts';
import {
  MISSING_RUN_PLANS_DRIVER,
  PLAN_CAPS,
  type CreateImportRunPlansDriver,
  type RunPlansDriver,
} from './imports-run-plans-driver.ts';

const fixedCounts: CountedCheck<CountedValues> = {
  read: (counts) => counts,
  bounds: { 'sqlite returned rows': 'constant', 'sqlite statements': 'constant' },
  slack: {
    'sqlite returned rows': { absolute: 2, relative: 0.1 },
    'sqlite statements': { absolute: 0, relative: 0 },
  },
};

const SOURCE = 'wikidata';
// Existing catalogue fixture identities, never allocated by this component.
const subject = '00000000-0000-4000-8000-000000000001';
const candidate = (i: number) => `00000000-0000-4000-8000-${String(i + 1).padStart(12, '0')}`;
const bytes = (value: unknown) => Buffer.byteLength(JSON.stringify(value), 'utf8');
function record(key = 'Q1', revision = 1, fields = 64, source = SOURCE): Staged {
  const projection = Array.from({ length: fields }, (_, i) => ({
    property: { id: 'schema:name' },
    value: { type: 'value' as const, content: { language: 'en', text: `Field ${i}, revision ${revision}` } },
    references: [
      {
        parts: [
          {
            property: { id: 'schema:sameAs' },
            value: {
              type: 'value' as const,
              content: `https://www.wikidata.org/entity/${key}`,
            },
          },
        ],
      },
    ],
  }));
  return {
    row: {
      source,
      recordKey: key,
      recordRevision: String(revision),
      digest: new Bun.CryptoHasher('sha256').update(JSON.stringify(projection)).digest('hex'),
      converter_revision: 'fixture@1',
      state: 'present',
    },
    projection,
  };
}
function proposals(r: Staged, count = r.projection.length): BatchCommand[] {
  return Array.from({ length: count }, (_, i) => ({
    op: 'propose',
    key: `${r.row.source}:${r.row.recordKey}:${r.row.recordRevision}:new:${i}`,
    source: {
      source: r.row.source,
      external_id: r.row.recordKey,
      record_revision: r.row.recordRevision,
      digest: r.row.digest,
      converter_revision: r.row.converter_revision,
      field_group: 'facts',
    },
    subject,
    statement: r.projection[i % r.projection.length]!,
  }));
}
function plan(r: Staged): BatchCommand[] {
  const next = proposals(r);
  return [
    ...next,
    ...next.map((command, i): BatchCommand => ({
      op: 'retract',
      key: `${r.row.source}:${r.row.recordKey}:${r.row.recordRevision}:old:${i}`,
      source: command.source,
      subject,
      candidate: candidate(i),
      references: r.projection[i]!.references,
    })),
  ];
}
function summary(r: Staged, index: number): BatchCommand {
  const overhead = Buffer.byteLength(serializeDocument(fromPlainText('x'))) - 1;
  const document = fromPlainText('x'.repeat(32768 - overhead));
  expect(Buffer.byteLength(serializeDocument(document))).toBe(32768);
  return {
    ...proposals(r, 1)[0]!,
    op: 'propose',
    key: `summary:${index}`,
    source: { ...proposals(r, 1)[0]!.source, field_group: 'summary' },
    subject,
    statement: {
      ...r.projection[0]!,
      property: { id: 'schema:description' },
      value: { type: 'value', content: { language: 'en', document } },
    },
    rights: {
      license: 'CC-BY-SA-4.0',
      obligations: ['cc:Attribution', 'cc:ShareAlike'],
      attribution: 'Wikidata contributors',
    },
  };
}
// Results are test inputs, not driver-produced transport responses. Proposal
// successes carry the candidate UUID that a portable API would actually return.
function result(commands: BatchCommand[], rejected = false): BatchWriteResult {
  const value: BatchWriteResult = {
    results: commands.map((command, i) =>
      rejected
        ? { key: command.key, status: 409, problem: { type: 'conflict', title: 'Conflict', status: 409 } }
        : {
            key: command.key,
            status: 200,
            value: command.op === 'propose' ? { candidate: candidate(i), revision: 1 } : { revision: 1 },
          },
    ),
  };
  expect(checkBatchWriteResult(value)).toEqual([]);
  return value;
}
function portable(entry: Pending): BatchCommand[] {
  expect(Buffer.byteLength(entry.bytes, 'utf8')).toBeLessThanOrEqual(PLAN_CAPS.envelopeBytes);
  const request = JSON.parse(entry.bytes);
  expect(checkBatchWrite(request)).toEqual([]);
  expect(request.commands.length).toBeLessThanOrEqual(100);
  expect(request.commands.map((c: BatchCommand) => c.key)).toEqual(entry.keys);
  expect(entry.after.length).toBeGreaterThan(0);
  return request.commands;
}
class Harness {
  constructor(
    readonly factory: CreateImportRunPlansDriver,
    readonly directory: string,
    public d: RunPlansDriver,
  ) {}
  async ready(records: Staged[], threshold = 1): Promise<Run> {
    const run = await this.d.begin(records[0]?.row.source ?? SOURCE, { disappearanceThreshold: threshold });
    if (run === 'busy') throw new Error('Unexpected busy source');
    for (const r of records) await this.d.stage(run, r);
    expect((await this.d.seal(run, { complete: true })).status).toBe('ready');
    return run;
  }
  async pending(run: Run, limit = 2) {
    const all: Pending[] = [];
    let after: string | undefined;
    const cursors = new Set<string>();
    for (let page = 0; page < 2000; page++) {
      const entries = await this.d.pagePending(run, { ...(after === undefined ? {} : { after }), limit });
      expect(entries.length).toBeLessThanOrEqual(limit);
      if (!entries.length) return all;
      for (const entry of entries) {
        portable(entry);
        expect(cursors.has(entry.after)).toBe(false);
        cursors.add(entry.after);
        all.push(entry);
      }
      after = entries.at(-1)!.after;
    }
    throw new Error('Pending keyset traversal did not terminate');
  }
  async ack(run: Run, entries: Pending[]) {
    for (const entry of entries) await this.d.acknowledge(run, result(portable(entry)), { recordKey: entry.recordKey });
  }
  async finish(run: Run, cap = 2) {
    for (let page = 0; page < 2000; page++) {
      const status = await this.d.finalize(run, cap);
      if (status === 'complete') return;
      expect(status).toBe('more');
    }
    throw new Error('Bounded finalization did not terminate');
  }
  async seed(records: Staged[]) {
    const run = await this.ready(records);
    for (const r of records) await this.d.prepare(run, r.row.recordKey, { commands: proposals(r) });
    await this.ack(run, await this.pending(run));
    await this.finish(run);
  }
  async reopen(run: Run) {
    await this.d.close();
    this.d = await this.factory({ directory: this.directory });
    return this.d.reopen(run);
  }
}
async function withStore(work: (h: Harness) => Promise<void>) {
  const binding = process.env.IMPORT_RUN_PLANS_DRIVER;
  if (!binding) throw new Error(MISSING_RUN_PLANS_DRIVER);
  const factory = (await import(binding)).createImportRunPlansDriver as CreateImportRunPlansDriver;
  expect(typeof factory).toBe('function');
  const directory = await mkdtemp(join(tmpdir(), 'import-run-plans-'));
  const h = new Harness(factory, directory, await factory({ directory }));
  try {
    await work(h);
  } finally {
    await h.d.close();
    await rm(directory, { recursive: true, force: true });
  }
}
async function changed(h: Harness) {
  const old = record();
  await h.seed([old]);
  const next = record('Q1', 2);
  return { old, next, run: await h.ready([next]), commands: plan(next) };
}
async function atomicReject(h: Harness, commands: BatchCommand[], message?: RegExp) {
  const r = record();
  const run = await h.ready([r]);
  const before = await h.d.persisted();
  const rejected = await h.d.measure(async () => {
    if (message) await expect(h.d.prepare(run, 'Q1', { commands })).rejects.toThrow(message);
    else await expect(h.d.prepare(run, 'Q1', { commands })).rejects.toThrow();
  });
  expect(rejected.networkRequests).toBe(0);
  expect(rejected.kernelPartitions).toEqual([]);
  expect(await h.d.persisted()).toEqual(before);
  expect(await h.pending(run)).toEqual([]);
  expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toBeNull();
}

test('64 new proposals and 64 old retractions journal as bounded portable envelopes before dispatch', async () =>
  withStore(async (h) => {
    const { old, next, run, commands } = await changed(h);
    expect(commands).toHaveLength(128);
    for (const c of commands) expect(checkBatchWrite({ commands: [c] })).toEqual([]);
    expect(await h.d.prepare(run, 'Q1', { commands })).toBe('changed');
    const entries = await h.pending(run, 1);
    expect(entries.length).toBeGreaterThanOrEqual(2);
    expect(entries.flatMap(portable)).toEqual(commands);
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(old.row);
    // Nothing has been dispatched: closing immediately proves the whole plan,
    // not just its first envelope, was journalled before transport could act.
    const resumed = await h.reopen(run);
    expect(await h.pending(resumed)).toEqual(entries);
    await h.ack(resumed, entries);
    await h.finish(resumed);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(next.row);
  }));

test('full 32KiB Text summaries with safe citations and rights split on bytes below 100 commands', async () =>
  withStore(async (h) => {
    const r = record();
    const run = await h.ready([r]);
    const commands = [summary(r, 0), summary(r, 1)];
    expect(checkBatchWrite({ commands })).toEqual([]);
    expect(bytes({ commands })).toBeGreaterThan(65536);
    await h.d.prepare(run, 'Q1', { commands });
    const entries = await h.pending(run);
    expect(entries).toHaveLength(2);
    expect(entries.flatMap(portable)).toEqual(commands);
    await h.ack(run, entries);
    await h.finish(run);
  }));

test('exact 100 commands preserve one-envelope behavior while 101 split', async () =>
  withStore(async (h) => {
    for (const count of [100, 101]) {
      const r = record('Q1', count);
      const run = await h.ready([r]);
      const commands = proposals(r, count);
      expect(bytes({ commands })).toBeLessThan(65536);
      await h.d.prepare(run, r.row.recordKey, { commands });
      const entries = await h.pending(run);
      expect(entries).toHaveLength(count === 100 ? 1 : 2);
      expect(entries.flatMap(portable)).toEqual(commands);
      await h.ack(run, entries);
      await h.finish(run);
    }
  }));

test('exact UTF-8 envelope byte cap is accepted and one byte beyond splits', async () =>
  withStore(async (h) => {
    for (const extra of [0, 1]) {
      const r = record('Q1', extra + 1);
      const run = await h.ready([r]);
      const commands = proposals(r, 2);
      const c = commands[0]!;
      if (c.op !== 'propose') throw new Error('Fixture must propose');
      c.statement = { ...c.statement, value: { type: 'value', content: { language: 'en', text: '猫' } } };
      const padding = 65536 - bytes({ commands }) + extra;
      c.statement.value = { type: 'value', content: { language: 'en', text: '猫' + 'x'.repeat(padding) } };
      expect(bytes({ commands })).toBe(65536 + extra);
      expect(checkBatchWrite({ commands })).toEqual([]);
      await h.d.prepare(run, r.row.recordKey, { commands });
      const entries = await h.pending(run);
      expect(entries).toHaveLength(extra ? 2 : 1);
      if (!extra) expect(Buffer.byteLength(entries[0]!.bytes)).toBe(65536);
      expect(entries.flatMap(portable)).toEqual(commands);
      await h.ack(run, entries);
      await h.finish(run);
    }
  }));

test('300 private commands are accepted without raising the public request cap', async () =>
  withStore(async (h) => {
    const r = record();
    const run = await h.ready([r]);
    const commands = proposals(r, 300);
    expect(checkBatchWrite({ commands }).length).toBeGreaterThan(0);
    await h.d.prepare(run, 'Q1', { commands });
    const entries = await h.pending(run);
    expect(entries.length).toBeGreaterThanOrEqual(3);
    expect(entries.flatMap(portable)).toEqual(commands);
    await h.ack(run, entries);
    await h.finish(run);
  }));

test('301 private commands reject atomically before journalling any prefix', async () =>
  withStore((h) => atomicReject(h, proposals(record(), 301))));

test('private plans exceeding 2MiB reject atomically even when every single command fits', async () =>
  withStore(async (h) => {
    const commands = Array.from({ length: 65 }, (_, i) => summary(record(), i));
    expect(bytes({ commands })).toBeGreaterThan(PLAN_CAPS.bytes);
    for (const c of commands) {
      expect(checkBatchWrite({ commands: [c] })).toEqual([]);
      expect(bytes({ commands: [c] })).toBeLessThan(65536);
    }
    await atomicReject(h, commands);
  }));

test('one oversized otherwise portable command explicitly rejects before any dispatch', async () =>
  withStore(async (h) => {
    const commands = proposals(record(), 1);
    const c = commands[0]!;
    if (c.op !== 'propose') throw new Error('Fixture must propose');
    c.statement = { ...c.statement, value: { type: 'value', content: '猫'.repeat(22000) } };
    expect(checkBatchWrite({ commands })).toEqual([]);
    expect(bytes({ commands })).toBeGreaterThan(65536);
    await atomicReject(h, commands, /(?:command.*(?:large|size|byte)|(?:large|size|byte).*command)/i);
  }));

test('duplicate keys spanning prospective envelopes reject the entire plan', async () =>
  withStore(async (h) => {
    const commands = proposals(record(), 128);
    commands[127]!.key = commands[0]!.key;
    await atomicReject(h, commands);
  }));

test('real portable validators reject malformed commands and summary rights without persisting a prefix', async () =>
  withStore(async (h) => {
    const commands = proposals(record(), 128);
    const invalid = summary(record(), 1);
    if (invalid.op !== 'propose') throw new Error('Fixture must propose');
    delete invalid.rights;
    expect(checkBatchWrite({ commands: [invalid] }).length).toBeGreaterThan(0);
    commands[127] = invalid;
    await atomicReject(h, commands);
  }));

test('partial acknowledgements replay the original whole envelope and hold record metadata until the last command', async () =>
  withStore(async (h) => {
    const { old, next, run, commands } = await changed(h);
    await h.d.prepare(run, 'Q1', { commands });
    const entries = await h.pending(run);
    const first = portable(entries[0]!);
    await h.d.acknowledge(run, result(first.slice(0, -1)), { recordKey: 'Q1' });
    expect(await h.pending(run)).toEqual(entries);
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(old.row);
    await h.d.acknowledge(run, result(first.slice(-1)), { recordKey: 'Q1' });
    expect(await h.pending(run)).toEqual(entries.slice(1));
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(old.row);
    expect(await h.d.finalize(run, 1)).toBe('incomplete');
    for (const entry of entries.slice(1)) {
      const tail = portable(entry);
      await h.d.acknowledge(run, result(tail.slice(0, -1)), { recordKey: 'Q1' });
      expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(old.row);
      await h.d.acknowledge(run, result(tail.slice(-1)), { recordKey: 'Q1' });
    }
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(next.row);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(old.row);
    await h.finish(run);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(next.row);
  }));

test('rejected and absent result keys remain durable pending after reopen while duplicate success is idempotent', async () =>
  withStore(async (h) => {
    const { old, run, commands } = await changed(h);
    await h.d.prepare(run, 'Q1', { commands });
    const entries = await h.pending(run);
    const first = portable(entries[0]!);
    const success = result(first.slice(0, 1));
    await h.d.acknowledge(run, success, { recordKey: 'Q1' });
    await h.d.acknowledge(run, success, { recordKey: 'Q1' });
    await h.d.acknowledge(run, result(first.slice(1, 2), true), { recordKey: 'Q1' });
    const resumed = await h.reopen(run);
    expect(await h.pending(resumed)).toEqual(entries);
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(old.row);
    await h.ack(resumed, entries);
    await h.d.acknowledge(resumed, success, { recordKey: 'Q1' });
    expect(await h.pending(resumed)).toEqual([]);
    await h.finish(resumed);
  }));

test('crash after a transport effect before ack replays identical bytes and keys without recomputing', async () =>
  withStore(async (h) => {
    const { run, commands } = await changed(h);
    await h.d.prepare(run, 'Q1', { commands });
    const entries = await h.pending(run);
    const effectedResult = result(portable(entries[0]!)); // Caller lost the reply before persisting ack.
    const resumed = await h.reopen(run);
    expect(await h.pending(resumed)).toEqual(entries);
    // Supplying changed source bytes under existing keys must never replace the journal.
    const altered = structuredClone(commands);
    const c = altered[0]!;
    if (c.op !== 'propose') throw new Error('Fixture must propose');
    c.statement.value = { type: 'value', content: 'different source content' };
    await expect(h.d.prepare(resumed, 'Q1', { commands: altered })).rejects.toThrow();
    expect(await h.pending(resumed)).toEqual(entries);
    await h.d.acknowledge(resumed, effectedResult, { recordKey: 'Q1' });
    await h.ack(resumed, entries.slice(1));
    await h.finish(resumed);
  }));

test('one full pending page contains multiple records and loses no extra envelopes or acknowledgements', async () =>
  withStore(async (h) => {
    const records = [record('Q1'), record('Q2'), record('Q3')];
    const run = await h.ready(records);
    for (const r of records) await h.d.prepare(run, r.row.recordKey, { commands: plan(r) });
    const entries = await h.pending(run, 4);
    expect(entries.flatMap(portable)).toEqual(records.flatMap(plan));
    const full = await h.d.pagePending(run, { limit: 4 });
    expect(full).toHaveLength(4);
    expect(new Set(full.map((p) => p.recordKey)).size).toBeGreaterThan(1);
    await h.ack(run, full);
    const remaining = await h.pending(run, 4);
    expect(remaining).toEqual(entries.slice(4));
    for (const r of records) {
      if (remaining.some((p) => p.recordKey === r.row.recordKey))
        expect((await h.d.key(SOURCE, r.row.recordKey)).acknowledged).toBeNull();
    }
    await h.ack(run, remaining);
    await h.finish(run);
    for (const r of records) expect((await h.d.key(SOURCE, r.row.recordKey)).baseline).toEqual(r.row);
  }));

test('source aliases and record ownership reject mismatched provenance without inventing native identities', async () =>
  withStore(async (h) => {
    const r = record('Q1', 1, 64, 'wikidata_alias');
    const run = await h.ready([r]);
    for (const mutation of [
      { source: SOURCE },
      { source: 'unknown_source' },
      { external_id: 'Qunknown' },
      { field_group: 'unknown' },
    ]) {
      const commands = proposals(r);
      commands[63]!.source = { ...commands[63]!.source, ...mutation } as BatchCommand['source'];
      await expect(h.d.prepare(run, 'Q1', { commands })).rejects.toThrow();
      expect(await h.pending(run)).toEqual([]);
    }
    await expect(h.d.prepare(run, 'Qunknown', { commands: proposals(r) })).rejects.toThrow();
    expect((await h.d.key('wikidata_alias', 'Qunknown')).acknowledged).toBeNull();
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toBeNull();
    await h.d.prepare(run, 'Q1', { commands: proposals(r) });
    const entries = await h.pending(run);
    expect(entries.flatMap(portable)).toEqual(proposals(r));
    await h.ack(run, entries);
    await h.finish(run);
    expect((await h.d.key('wikidata_alias', 'Q1')).baseline).toEqual(r.row);
  }));

test('cross-source run record and unknown result keys reject atomically and local cursors cannot escape a run', async () =>
  withStore(async (h) => {
    const records = [record('Q1'), record('Q2')];
    const run = await h.ready(records);
    for (const r of records) await h.d.prepare(run, r.row.recordKey, { commands: plan(r) });
    const entries = await h.pending(run);
    const other = record('Q1', 1, 64, 'wikidata_alias');
    const peer = await h.ready([other]);
    await h.d.prepare(peer, 'Q1', { commands: plan(other) });
    const peerEntries = await h.pending(peer);
    const persistedBeforeRejections = await h.d.persisted();
    await expect(h.d.acknowledge(run, result(portable(peerEntries[0]!)), { recordKey: 'Q1' })).rejects.toThrow();
    await expect(h.d.acknowledge(peer, result(portable(entries[0]!)), { recordKey: 'Q1' })).rejects.toThrow();
    const mixed = result([portable(entries[0]!)[0]!, portable(entries.find((p) => p.recordKey === 'Q2')!)[0]!]);
    await expect(h.d.acknowledge(run, mixed, { recordKey: 'Q1' })).rejects.toThrow();
    const unknown = result(portable(entries[0]!).slice(0, 2));
    unknown.results[1]!.key = 'never-prepared-key';
    await expect(h.d.acknowledge(run, unknown, { recordKey: 'Q1' })).rejects.toThrow();
    await expect(
      h.d.acknowledge(run, { results: [{ key: entries[0]!.keys[0], status: 200 }] } as never, { recordKey: 'Q1' }),
    ).rejects.toThrow();
    await expect(h.d.pagePending(peer, { after: entries[0]!.after, limit: 2 })).rejects.toThrow();
    expect(await h.pending(run)).toEqual(entries);
    expect(await h.pending(peer)).toEqual(peerEntries);
    expect(await h.d.persisted()).toEqual(persistedBeforeRejections);
    const previous = result(portable(entries[0]!));
    const cursor = entries[0]!.after;
    await h.ack(run, entries);
    await h.finish(run);
    const next = await h.ready(records.map((r) => record(r.row.recordKey, 2)));
    for (const r of records) await h.d.prepare(next, r.row.recordKey, { commands: plan(record(r.row.recordKey, 2)) });
    const before = await h.pending(next);
    await expect(h.d.acknowledge(next, previous, { recordKey: 'Q1' })).rejects.toThrow();
    await expect(h.d.pagePending(next, { after: cursor, limit: 2 })).rejects.toThrow();
    expect(await h.pending(next)).toEqual(before);
  }));

test('unchanged and explicit fenced zero-command records resolve only their proven rule', async () =>
  withStore(async (h) => {
    const r = record();
    await h.seed([r]);
    const sourceBefore = await h.d.source(SOURCE);
    const run = await h.ready([r]);
    expect(await h.d.classify(run, 'Q1', { commands: [] })).toBe('unchanged');
    expect(await h.pending(run)).toEqual([]);
    await h.finish(run);
    expect(await h.d.source(SOURCE)).toEqual(sourceBefore);
    const next = record('Q1', 2);
    let changedRun = await h.ready([next]);
    await expect(h.d.prepare(changedRun, 'Q1', { commands: [] })).rejects.toThrow();
    expect(await h.d.finalize(changedRun, 1)).toBe('incomplete');
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(r.row);
    const omission = {
      field_group: 'facts' as const,
      disposition: 'fenced' as const,
      securityRevision: '9007199254740993',
    };
    await h.d.classify(changedRun, 'Q1', { commands: [], omissions: [omission] });
    changedRun = await h.reopen(changedRun);
    expect((await h.d.key(SOURCE, 'Q1', changedRun)).omissions).toContainEqual(omission);
    expect(await h.pending(changedRun)).toEqual([]);
    await h.finish(changedRun);
    expect((await h.d.key(SOURCE, 'Q1')).baseline).toEqual(next.row);
  }));

test('fencing another group never acknowledges an unfenced failed part of a multi-envelope record', async () =>
  withStore(async (h) => {
    const { old, run, commands } = await changed(h);
    await h.d.prepare(run, 'Q1', { commands });
    const entries = await h.pending(run);
    await h.ack(run, entries.slice(0, -1));
    await h.d.acknowledge(run, result(portable(entries.at(-1)!), true), { recordKey: 'Q1' });
    for (const omission of [
      { field_group: 'facts', disposition: 'unfenced', securityRevision: '1' },
      { field_group: 'facts', disposition: 'fenced', securityRevision: null },
      { field_group: 'facts', disposition: 'fenced' },
    ])
      await expect(h.d.classify(run, 'Q1', { commands: [], omissions: [omission as never] })).rejects.toThrow();
    await h.d.classify(run, 'Q1', {
      commands: [],
      omissions: [{ field_group: 'summary', disposition: 'fenced', securityRevision: '2' }],
    });
    const resumed = await h.reopen(run);
    expect(await h.pending(resumed)).toEqual(entries.slice(-1));
    expect(await h.d.finalize(resumed, 1)).toBe('incomplete');
    expect((await h.d.key(SOURCE, 'Q1')).acknowledged).toEqual(old.row);
    await h.ack(resumed, entries.slice(-1));
    await h.finish(resumed);
  }));

test('bounded finalize survives restart and cannot advance a full baseline before every record resolves', async () =>
  withStore(async (h) => {
    const records = Array.from({ length: 8 }, (_, i) => record(`Q${i}`, 1, 1));
    await h.seed(records);
    const oldGeneration = await h.d.source(SOURCE);
    const next = records.map((r) => record(r.row.recordKey, 2, 1));
    let run = await h.ready(next);
    for (const r of next) await h.d.prepare(run, r.row.recordKey, { commands: proposals(r) });
    const entries = await h.pending(run);
    await h.ack(run, entries.slice(0, -1));
    expect(await h.d.finalize(run, 1)).toBe('incomplete');
    expect(await h.d.source(SOURCE)).toEqual(oldGeneration);
    await h.ack(run, entries.slice(-1));
    expect(await h.d.finalize(run, 1)).toBe('more');
    run = await h.reopen(run);
    await h.finish(run, 1);
    expect(await h.d.finalize(run, 1)).toBe('complete');
    for (const r of next) expect((await h.d.key(SOURCE, r.row.recordKey)).baseline).toEqual(r.row);
  }));

test('mass disappearance still blocks the entire generation before a multi-envelope plan becomes pending', async () =>
  withStore(async (h) => {
    await h.seed(Array.from({ length: 8 }, (_, i) => record(`Q${i}`, 1, 1)));
    const before = await h.d.source(SOURCE);
    const run = await h.d.begin(SOURCE);
    if (run === 'busy') throw new Error('Unexpected busy source');
    const next = record('Q0', 2);
    await h.d.stage(run, next);
    expect((await h.d.seal(run, { complete: true })).status).toBe('mass-disappearance');
    await expect(h.d.prepare(run, 'Q0', { commands: plan(next) })).rejects.toThrow();
    expect(await h.pending(run)).toEqual([]);
    expect(await h.d.source(SOURCE)).toEqual(before);
  }));

// One accumulating population, same source/database/indexes. All historical
// activity is driven through real operations, never a driver seed/model method.
async function grow(h: Harness, n: number) {
  let supplied: Staged[] = [];
  for (let t = 0; t < 3; t++) {
    supplied = Array.from({ length: n }, (_, i) => record(`Qhistory${String(i).padStart(4, '0')}`, n * 10 + t, 1));
    await h.seed([...supplied, record('Qfixed', n * 10, 64)]);
  }
  return supplied;
}
async function measured<T>(h: Harness, operation: () => Promise<T>, m: number, pageCap = 8) {
  const capture = await h.d.measure(operation);
  expect(capture.networkRequests).toBe(0);
  expect(capture.kernelPartitions).toEqual([]);
  const counts = runStoreCounts(capture.evidence, pageCap);
  expect(counts['sqlite returned rows']).toBeLessThanOrEqual(64 * (m + pageCap));
  expect(counts['sqlite statements']).toBeLessThanOrEqual(32 * (m + pageCap));
  return { value: capture.value, counts };
}

test(
  'same-source 32 128 512 unrelated keys and history cannot grow fixed 128-command prepare page ack or finalize costs',
  async () =>
    withStore(async (h) => {
      const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
      const capture = async <T>(name: string, scale: number, operation: () => Promise<T>, m = 128, cap = 8) => {
        const sample = await measured(h, operation, m, cap);
        const group = samples.get(name) ?? [];
        group.push({ scale, counted: countedSample([sample.counts]) });
        samples.set(name, group);
        return sample.value;
      };
      for (const n of [32, 128, 512]) {
        const unrelated = await grow(h, n);
        const fixed = record('Qfixed', n * 10 + 1);
        const run = await h.ready([...unrelated, fixed]); // streaming source setup outside counts
        await h.d.analyze();
        expect(await capture('prepare', n, () => h.d.prepare(run, 'Qfixed', { commands: plan(fixed) }))).toBe(
          'changed',
        );
        const page = await capture('page', n, () => h.d.pagePending(run, { limit: 2 }), 0, 2);
        expect(page).toHaveLength(2);
        expect(page.flatMap(portable)).toEqual(plan(fixed));
        await capture('ack', n, () => h.ack(run, page));
        expect(await h.pending(run)).toEqual([]);
        for (const r of unrelated) expect(await h.d.classify(run, r.row.recordKey, { commands: [] })).toBe('unchanged');
        await capture('finalize page', n, () => h.d.finalize(run, 2), 0, 2);
        await h.finish(run);
      }
      for (const group of samples.values()) expect(countedViolations(fixedCounts, group)).toEqual([]);
    }),
  120_000,
);

test(
  'M 1 8 64 private commands grow actual touched work linearly with shared SQLite indexed-plan proof',
  async () =>
    withStore(async (h) => {
      const samples = new Map<string, { scale: number; counted: CountedSample }[]>();
      for (const m of [1, 8, 64]) {
        const r = record('Qpayload', m, m);
        const run = await h.ready([r]);
        await h.d.analyze();
        const prepare = await measured(h, () => h.d.prepare(run, r.row.recordKey, { commands: proposals(r) }), m);
        expect(prepare.counts['sqlite statements']).toBeGreaterThanOrEqual(m);
        const page = await measured(h, () => h.d.pagePending(run, { limit: 2 }), 0, 2);
        expect(page.value.flatMap(portable)).toEqual(proposals(r));
        const ack = await measured(h, () => h.ack(run, page.value), m);
        for (const [name, counts] of [
          ['prepare', prepare.counts],
          ['page', page.counts],
          ['ack', ack.counts],
        ] as const) {
          const group = samples.get(name) ?? [];
          group.push({ scale: m, counted: countedSample([counts]) });
          samples.set(name, group);
        }
        await h.finish(run);
      }
      for (const [name, group] of samples)
        expect(
          countedViolations(
            {
              ...fixedCounts,
              bounds: {
                'sqlite returned rows': name === 'page' ? 'constant' : 'linear',
                'sqlite statements': name === 'page' ? 'constant' : 'linear',
              },
            },
            group,
          ),
        ).toEqual([]);
    }),
  120_000,
);

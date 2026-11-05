import { expect, test } from 'bun:test';
import { createHash } from 'node:crypto';
import {
  checkBatchWrite,
  checkBatchWriteResult,
  FIELD_GROUPS,
  type BatchCommand,
  type BatchWriteResult,
} from '@rezics/definitions/bulk';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { isAbsolute, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CommandObservation,
  CreateImportLedgerDriver,
  FenceKey,
  ImportLedgerDriver,
  RunInput,
  RunResult,
} from './imports-ledger-driver';

/**
 * Assertion contract justification (scenario order):
 * 1. Initial rows retain source/key/native revision/digest/trusted converter;
 *    create then propose use portable results, and observed conversion metadata
 *    proves source CC0 independently of output database rights.
 * 2. Reopen proves disk durability; identical input changes neither wire nor state.
 * 3. Digest detects changed bytes at the same revision; real title candidates
 *    are retracted by returned ID while creation labels retain their initial text.
 * 4. Native revision persists; trusted converter revision reconverts all keys
 *    without changing source digests.
 * 5. Classification compares a complete mixed snapshot against its baseline.
 * 6. Exactly 20% is allowed; vanished retracts only prior source candidates;
 *    the next denominator counts present rows, and reappearance proposes again.
 * 7. Above 20% blocks all API effects and checkpoint changes, including on reopen.
 * 8. Custom thresholds are strict; total disappearance always blocks.
 * 9. An initial empty complete snapshot is valid and later keys are new.
 * 10. Malformed tail aborts staging before effects, preserving durable state.
 * 11. Duplicate keys abort even with identical payloads, avoiding ambiguous input.
 * 12. Truncated tail aborts all staged changes, not just the final record.
 * 13. Stream failure is incomplete input and cannot publish a checkpoint.
 * 14. Partial rejection advances only complete acknowledged record groups;
 *     retry retains rejected command identities and adds phase-two proposals.
 * 15. Rejected changed records and the complete baseline remain prior.
 * 16. Transport failure adds no effects; retry preserves attempted identities.
 * 17. Crash between API success and local commit replays the same receipts;
 *     effect cardinality is the union of actual command keys, not record count.
 * 18. Same-source concurrency preserves rows and one identity per command.
 * 19. Independent feeds isolate checkpoints, command keys and failure handling.
 * 20. Every refresh checks all tuple-home groups, including unchanged records;
 *     fenced groups are omitted on changed input and converter refresh.
 * 21. Record/source/group dimensions independently constrain omission; absent
 *     summary fences cannot suppress Wikidata facts.
 * 22. Rejection after an open lookup cannot acknowledge a row; a later fence
 *     permits explicit omission on retry. This does not prove server disclosure.
 * 23-26. Malformed, missing, duplicate and mismatched results are uncertain:
 *     no baseline advances, reopen retries stable identities/cached receipts,
 *     and the next unchanged refresh produces no additional effects.
 * 27. Lost response proves those same guarantees after actual fake acceptance.
 * 28. Missing native revision is literally unversioned; digest still detects edits.
 *
 * Cross-cutting assertions validate every wire request/result with definitions,
 * enumerate every command, tie observations to actual wire values/citations/keys,
 * reject fact rights, exclude private sentinels from raw wire/state/diagnostics,
 * resolve one fixture subject per source claim, and require retractions to name
 * an acknowledged candidate of that same source, subject and field group.
 * Fixture maps are transport receipts only, with no product partitions or cost
 * counters. Indexed SQLite/PostgreSQL, streaming and real HTTP/Auth/final fence
 * disclosure proofs remain in their separate production suites.
 */
const source = 'wikidata-primary';
const revision = 'ledger-converter-1';
const keys = ['Q1', 'Q2', 'Q3', 'Q4', 'Q5'];
const secrets = ['SENTINEL_USER_POST_LEDGER_DO_NOT_IMPORT', 'SENTINEL_PRIVATE_LEDGER_DO_NOT_IMPORT'];
const fixture = (name = 'wikidata.jsonl') =>
  Bun.file(new URL(`./fixtures/imports/ledger/${name}`, import.meta.url)).text();
const fenceId = (key: FenceKey) => JSON.stringify([key.source, key.external_id, key.field_group]);
const changed = (dump: string) => dump.replace('Ledger One', 'Ledger One Updated');
const subset = (dump: string, count: number) => dump.trimEnd().split('\n').slice(0, count).join('\n') + '\n';

/** Fixture fake transport only: this suite makes no claim about production API effects. */
async function withLedger(body: (h: Harness) => Promise<void>) {
  // Load inside every scenario, before any fixture/setup can obscure RED evidence.
  const location = process.env.IMPORT_LEDGER_DRIVER;
  if (!location) throw new Error('IMPORT_LEDGER_DRIVER is required: bind production import state reconciliation');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('IMPORT_LEDGER_DRIVER must be an absolute path or file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('IMPORT_LEDGER_DRIVER must use a file URL');
  const binding = await import(url.href);
  if (typeof binding.createImportLedgerDriver !== 'function')
    throw new Error('Driver must export createImportLedgerDriver');
  const directory = await mkdtemp(join(tmpdir(), 'import-ledger-'));
  const h = new Harness(binding.createImportLedgerDriver, directory);
  try {
    await h.open();
    await body(h);
  } finally {
    try {
      await h.driver?.close();
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  }
}

class Harness {
  driver!: ImportLedgerDriver;
  calls: CommandObservation[][] = [];
  raw: unknown[] = [];
  /** Fixture-only portable receipts and claim/candidate identities survive reopen. */
  receipts = new Map<string, BatchWriteResult['results'][number]>();
  subjects = new Map<string, string>();
  candidates = new Map<string, { subject: string; home: string; command: BatchCommand }>();
  allowMalformedResponse = false;
  afterResponse: (result: BatchWriteResult) => BatchWriteResult = (result) => result;
  lookups: FenceKey[] = [];
  fences = new Set<string>();
  /** Fake accepted effects, deduplicated by the actual command idempotency key. */
  effects = new Map<string, string>();
  respond: (commands: CommandObservation[]) => Promise<('acknowledged' | 'rejected')[]> = async (commands) =>
    commands.map(() => 'acknowledged');
  constructor(
    private factory: CreateImportLedgerDriver,
    private directory: string,
  ) {}
  async open() {
    this.driver = await this.factory({
      directory: this.directory,
      readFence: async (key) => {
        this.lookups.push({ ...key });
        const fenced = this.fences.has(fenceId(key));
        return { fenced, securityRevision: fenced ? '1' : null };
      },
      bulk: {
        send: async (request) => {
          expect(checkBatchWrite(request)).toEqual([]);
          const commands = this.driver.inspectBulk(request);
          // Inspect ALL commands, in wire order, including bootstrap/retractions.
          expect(commands.map((c) => c.command)).toEqual(request.commands);
          for (const c of commands) {
            const command = c.command;
            expect(c.kind).toBe(command.op);
            expect(c.idempotencyKey).toBe(command.key);
            expect({ source: c.source, external_id: c.external_id, field_group: c.field_group }).toEqual({
              source: command.source.source,
              external_id: command.source.external_id,
              field_group: command.source.field_group,
            });
            expect(c.external_id).toMatch(/^Q[1-5]$/);
            const wire = JSON.stringify(command);
            for (const value of [...c.references, ...c.licenses, ...c.values, c.field_group, c.idempotencyKey])
              expect(wire).toContain(JSON.stringify(value));
            if (command.op !== 'create')
              expect(
                c.references.some((reference) =>
                  new RegExp(
                    String.raw`^https://www\.wikidata\.org/wiki/${c.external_id}(?:\?oldid=[1-9][0-9]*)?$`,
                  ).test(reference),
                ),
              ).toBe(true);
            if (command.source.field_group === 'facts') expect(command).not.toHaveProperty('rights');
          }
          // Raw transport privacy is checked before observations or failure injection.
          for (const secret of secrets) expect(JSON.stringify(request)).not.toContain(secret);
          this.raw.push(structuredClone(request));
          this.calls.push(structuredClone(commands));
          const dispositions = await this.respond(commands);
          expect(dispositions.length).toBe(commands.length);
          const result: BatchWriteResult = {
            results: commands.map((c, i) => {
              const command = c.command;
              const serialized = JSON.stringify(command);
              const cached = this.receipts.get(command.key);
              if (cached) {
                expect(this.effects.get(command.key)).toBe(serialized);
                return structuredClone(cached);
              }
              if (dispositions[i] === 'rejected')
                return {
                  key: command.key,
                  status: 409,
                  problem: { type: 'about:blank', title: 'Fixture rejection', status: 409 },
                };
              const home = JSON.stringify([command.source.source, command.source.external_id]);
              let value:
                | { id: string; revision: number }
                | { candidate: string; revision: number }
                | { revision: number };
              if (command.op === 'create') {
                const id = this.subjects.get(home) ?? fixtureUuid(`subject:${home}`);
                this.subjects.set(home, id);
                value = { id, revision: 1 };
              } else {
                // Phase two must use the actual phase-one result, never a made-up ID.
                expect(this.subjects.has(home)).toBe(true);
                expect(command.subject).toBe(this.subjects.get(home)!);
                if (command.op === 'propose') {
                  const candidate = fixtureUuid(`candidate:${command.key}`);
                  this.candidates.set(candidate, { subject: command.subject, home, command: structuredClone(command) });
                  value = { candidate, revision: 1 };
                } else {
                  const prior = this.candidates.get(command.candidate);
                  expect(prior).toBeDefined();
                  expect(prior!.subject).toBe(command.subject);
                  expect(prior!.home).toBe(home);
                  expect(prior!.command.source.field_group).toBe(command.source.field_group);
                  value = { revision: 1 };
                }
              }
              const receipt = { key: command.key, status: 200 as const, value };
              this.effects.set(command.key, serialized);
              this.receipts.set(command.key, receipt);
              return receipt;
            }),
          };
          expect(checkBatchWriteResult(result)).toEqual([]);
          // Deliberate protocol corruption/lost responses happen after fake effects.
          const delivered = this.afterResponse(structuredClone(result));
          const violations = checkBatchWriteResult(delivered);
          if (!this.allowMalformedResponse) expect(violations).toEqual([]);
          return delivered;
        },
      },
    });
  }
  async reopen() {
    await this.driver.close();
    await this.open();
  }
  run(dump: RunInput['dump'], options: Partial<Omit<RunInput, 'dump'>> = {}) {
    return this.driver.run({ source, converter_revision: revision, ...options, dump });
  }
  commands() {
    return this.calls.flat();
  }
  async seed() {
    const dump = await fixture();
    committed(await this.run(dump), { new: keys });
    return dump;
  }
}

/** Deterministic IDs exist only in the fixture transport, never in the binding. */
function fixtureUuid(identity: string) {
  const hex = createHash('sha256').update(identity).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-8000-8000-${hex.slice(20, 32)}`;
}
function pointer(raw: unknown, path: string): unknown {
  expect(path).toMatch(/^\//);
  return path
    .slice(1)
    .split('/')
    .reduce<unknown>((value, part) => {
      expect(value !== null && typeof value === 'object').toBe(true);
      return (value as Record<string, unknown>)[part.replaceAll('~1', '/').replaceAll('~0', '~')];
    }, raw);
}
function committed(result: RunResult, classes: Partial<Pick<RunResult, 'new' | 'changed' | 'unchanged' | 'vanished'>>) {
  expect(result.status).toBe('committed');
  for (const name of ['new', 'changed', 'unchanged', 'vanished'] as const) {
    expect([...result[name]].sort()).toEqual([...(classes[name] ?? [])].sort());
  }
}
function deferred() {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => {
    resolve = done;
  });
  return { promise, resolve };
}

test('initial complete snapshot persists source key revision digest and converter revision as proposals', async () => {
  await withLedger(async (h) => {
    await h.seed();
    const state = await h.driver.observe(source);
    expect(state.committedSnapshot?.trim().length).toBeGreaterThan(0);
    expect(state.rows.map((row) => row.recordKey)).toEqual(keys);
    for (const [i, row] of state.rows.entries()) {
      expect(row).toMatchObject({
        source,
        recordKey: keys[i],
        recordRevision: String(101 + i),
        converter_revision: revision,
        state: 'present',
      });
      expect(row.digest.trim().length).toBeGreaterThan(0);
    }
    expect(new Set(state.rows.map((row) => row.digest)).size).toBe(5);
    expect(new Set(h.commands().map((c) => c.external_id))).toEqual(new Set(keys));
    expect(h.commands().some((c) => c.values.includes('Ledger One'))).toBe(true);
    for (const secret of secrets) expect(JSON.stringify(state)).not.toContain(secret);
    expect(h.effects.size).toBeGreaterThan(0);
    const outputs = h.driver.conversionOutputs();
    expect(outputs.length).toBeGreaterThan(0);
    for (const output of outputs) expect(pointer(output.raw, output.sourceLicensePointer)).toBe('CC0-1.0');
    for (const key of keys) {
      const group = h.commands().filter((c) => c.external_id === key);
      expect(group.some((c) => c.kind === 'create')).toBe(true);
      expect(group.some((c) => c.kind === 'propose')).toBe(true);
    }
    // The fake consumer cannot claim acceptance of arbitrary/empty bulk shapes.
    for (const invalid of [null, {}, [], { commands: [] }, { commands: [{ sql: 'DELETE FROM subjects' }] }]) {
      expect(() => h.driver.inspectBulk(invalid)).toThrow();
    }
  });
});

test('identical dump after durable reopen is unchanged with no new proposals or checkpoint', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    await h.reopen();
    expect(await h.driver.observe(source)).toEqual(before);
    h.calls = [];
    committed(await h.run(dump), { unchanged: keys });
    expect(h.calls).toEqual([]);
    expect(await h.driver.observe(source)).toEqual(before);
  });
});

test('same revision changed payload is detected by digest while other rows stay unchanged', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    h.calls = [];
    committed(await h.run(changed(dump)), { changed: ['Q1'], unchanged: keys.slice(1) });
    const after = await h.driver.observe(source);
    expect(after.rows[0]!.recordRevision).toBe(before.rows[0]!.recordRevision);
    expect(after.rows[0]!.digest).not.toBe(before.rows[0]!.digest);
    expect(after.rows.slice(1)).toEqual(before.rows.slice(1));
    expect(after.committedSnapshot).not.toBe(before.committedSnapshot);
    expect(new Set(h.commands().map((c) => c.external_id))).toEqual(new Set(['Q1']));
    expect(h.commands().some((c) => c.values.includes('Ledger One Updated'))).toBe(true);
    for (const c of h.commands()) if (c.command.op === 'create') expect(c.command.subject.labels.en).toBe('Ledger One');
    const oldTitles = [...h.candidates.entries()].filter(
      ([, candidate]) =>
        candidate.command.op === 'propose' &&
        candidate.command.statement.property.id === 'schema:name' &&
        JSON.stringify(candidate.command.statement.value).includes('Ledger One"'),
    );
    expect(oldTitles.length).toBeGreaterThan(0);
    for (const [candidate] of oldTitles)
      expect(h.commands().some((c) => c.command.op === 'retract' && c.command.candidate === candidate)).toBe(true);
  });
});

test('new record revision is persisted and explicit converter revision changes reconvert every row', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const revised = dump.replace('"lastrevid":101', '"lastrevid":201');
    committed(await h.run(revised), { changed: ['Q1'], unchanged: keys.slice(1) });
    expect((await h.driver.observe(source)).rows[0]!.recordRevision).toBe('201');
    const before = await h.driver.observe(source);
    h.calls = [];
    committed(await h.run(revised, { converter_revision: 'ledger-converter-2' }), { changed: keys });
    const after = await h.driver.observe(source);
    expect(after.rows.map((row) => row.digest)).toEqual(before.rows.map((row) => row.digest));
    expect(after.rows.map((row) => row.converter_revision)).toEqual(keys.map(() => 'ledger-converter-2'));
    expect(new Set(h.commands().map((c) => c.external_id))).toEqual(new Set(keys));
  });
});

test('one snapshot distinguishes new changed and unchanged records against the committed baseline', async () => {
  await withLedger(async (h) => {
    const dump = await fixture();
    committed(await h.run(subset(dump, 4)), { new: keys.slice(0, 4) });
    h.calls = [];
    committed(await h.run(changed(dump)), { new: ['Q5'], changed: ['Q1'], unchanged: ['Q2', 'Q3', 'Q4'] });
    expect(new Set(h.commands().map((c) => c.external_id))).toEqual(new Set(['Q1', 'Q5']));
    expect((await h.driver.observe(source)).rows.map((r) => r.recordKey)).toEqual(keys);
  });
});

test('exactly twenty percent disappearance records vanished rows without communal deletion and permits reappearance', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    h.calls = [];
    committed(await h.run(subset(dump, 4)), { unchanged: keys.slice(0, 4), vanished: ['Q5'] });
    expect((await h.driver.observe(source)).rows.map((r) => [r.recordKey, r.state])).toEqual(
      keys.map((k) => [k, k === 'Q5' ? 'vanished' : 'present']),
    );
    const retractions = h.commands();
    expect(retractions.length).toBeGreaterThan(0);
    expect(retractions.every((c) => c.external_id === 'Q5' && c.kind === 'retract')).toBe(true);
    const priorCandidates = [...h.candidates.entries()].filter(([, c]) => JSON.parse(c.home)[1] === 'Q5');
    expect(new Set(retractions.map((c) => c.command.op === 'retract' && c.command.candidate))).toEqual(
      new Set(priorCandidates.map(([id]) => id)),
    );
    h.calls = [];
    const four = await h.driver.observe(source);
    // The denominator is the last snapshot's four present records, not five
    // historical ledger rows: one more disappearance is now twenty-five percent.
    expect((await h.run(subset(dump, 3))).status).toBe('mass-disappearance');
    expect(await h.driver.observe(source)).toEqual(four);
    expect(h.calls).toEqual([]);
    const effectsBeforeReappearance = h.effects.size;
    expect((await h.run(dump)).status).toBe('committed');
    expect(h.effects.size).toBeGreaterThan(effectsBeforeReappearance);
    expect((await h.driver.observe(source)).rows.map((r) => r.state)).toEqual(keys.map(() => 'present'));
    expect(h.commands().some((c) => c.kind === 'propose')).toBe(true);
  });
});

test('more than twenty percent disappearance halts before changed or new proposals and any checkpoint', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    h.calls = [];
    const added = dump.trimEnd().split('\n')[4]!.replaceAll('Q5', 'Q6');
    expect((await h.run(changed(subset(dump, 3)) + added + '\n')).status).toBe('mass-disappearance');
    expect(h.calls).toEqual([]);
    expect(await h.driver.observe(source)).toEqual(before);
    await h.reopen();
    expect(await h.driver.observe(source)).toEqual(before);
  });
});

test('explicit disappearance threshold is strict and removing all prior records always halts', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    h.calls = [];
    expect((await h.run(subset(dump, 2), { disappearanceThreshold: 0.4 })).status).toBe('mass-disappearance');
    expect(await h.driver.observe(source)).toEqual(before);
    expect((await h.run('', { disappearanceThreshold: 1 })).status).toBe('mass-disappearance');
    const replacement = JSON.parse(dump.split('\n')[0]!);
    replacement.id = 'Q6';
    replacement.claims.P31[0].id = replacement.claims.P31[0].id.replace('Q1$', 'Q6$');
    expect((await h.run(JSON.stringify(replacement) + '\n', { disappearanceThreshold: 1 })).status).toBe(
      'mass-disappearance',
    );
    expect(h.calls).toEqual([]);
    expect(await h.driver.observe(source)).toEqual(before);
    committed(await h.run(subset(dump, 3), { disappearanceThreshold: 0.4 }), {
      unchanged: keys.slice(0, 3),
      vanished: keys.slice(3),
    });
  });
});

test('initial empty baseline is allowed and subsequent records are new', async () => {
  await withLedger(async (h) => {
    committed(await h.run(''), {});
    const empty = await h.driver.observe(source);
    expect(empty.rows).toEqual([]);
    expect(empty.committedSnapshot?.trim().length).toBeGreaterThan(0);
    expect(h.calls).toEqual([]);
    await h.reopen();
    expect(await h.driver.observe(source)).toEqual(empty);
    await h.seed();
  });
});

async function invalidDump(h: Harness, name: string) {
  const dump = await h.seed();
  const before = await h.driver.observe(source);
  h.calls = [];
  const result = await h.run(changed(await fixture(name)));
  expect(result.status).toBe('invalid-dump');
  expect(result.diagnostic.trim().length).toBeGreaterThan(0);
  for (const secret of secrets) expect(result.diagnostic).not.toContain(secret);
  expect(h.calls).toEqual([]);
  expect(await h.driver.observe(source)).toEqual(before);
  await h.reopen();
  expect(await h.driver.observe(source)).toEqual(before);
  committed(await h.run(dump), { unchanged: keys });
}

test('malformed final record aborts the fully staged snapshot with prior state intact', async () => {
  await withLedger((h) => invalidDump(h, 'malformed.jsonl'));
});

test('duplicate source keys abort even when the duplicated bytes are identical', async () => {
  await withLedger((h) => invalidDump(h, 'duplicate.jsonl'));
});

test('truncated final record aborts without applying earlier valid changed rows', async () => {
  await withLedger((h) => invalidDump(h, 'truncated.jsonl'));
});

test('source stream failure before completion causes no proposals or checkpoint', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    h.calls = [];
    async function* broken() {
      yield changed(dump);
      throw new Error('fixture source stream disconnected');
    }
    expect((await h.run(broken())).status).toBe('invalid-dump');
    expect(h.calls).toEqual([]);
    expect(await h.driver.observe(source)).toEqual(before);
  });
});

test('partial bulk failure advances only acknowledged records and retry preserves command keys', async () => {
  await withLedger(async (h) => {
    const dump = await fixture();
    h.respond = async (commands) => commands.map((c) => (c.external_id === 'Q2' ? 'rejected' : 'acknowledged'));
    expect((await h.run(dump)).status).toBe('bulk-failed');
    const partial = await h.driver.observe(source);
    expect(partial.committedSnapshot).toBeNull();
    const accepted = [
      ...new Set(
        h
          .commands()
          .filter((c) => c.external_id !== 'Q2' && c.kind === 'propose')
          .map((c) => c.external_id),
      ),
    ].sort();
    expect(accepted.length).toBeGreaterThan(0);
    expect(partial.rows.map((r) => r.recordKey)).toEqual(accepted);
    const rejected = h.commands().filter((c) => c.external_id === 'Q2');
    expect(rejected.length).toBeGreaterThan(0);
    const attempted = h.commands();
    await h.reopen();
    expect(await h.driver.observe(source)).toEqual(partial);
    h.calls = [];
    h.respond = async (commands) => commands.map(() => 'acknowledged');
    expect((await h.run(dump)).status).toBe('committed');
    for (const command of rejected) expect(h.commands()).toContainEqual(command);
    expect(h.commands().some((c) => c.external_id === 'Q2' && c.kind === 'propose')).toBe(true);
    expect(h.effects.size).toBe(new Set([...attempted, ...h.commands()].map((c) => c.idempotencyKey)).size);
    expect((await h.driver.observe(source)).rows.map((r) => r.recordKey)).toEqual(keys);
  });
});

test('failed changed snapshot retains committed baseline and unchanged rejected row for retry', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    h.respond = async (commands) => commands.map(() => 'rejected');
    expect((await h.run(changed(dump))).status).toBe('bulk-failed');
    expect(await h.driver.observe(source)).toEqual(before);
    await h.reopen();
    h.respond = async (commands) => commands.map(() => 'acknowledged');
    committed(await h.run(changed(dump)), { changed: ['Q1'], unchanged: keys.slice(1) });
  });
});

test('bulk transport failure preserves the previous snapshot and retry reuses attempted identities', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const before = await h.driver.observe(source);
    const effects = h.effects.size;
    h.calls = [];
    h.respond = async () => {
      throw new Error('fixture bulk transport unavailable');
    };
    expect((await h.run(changed(dump))).status).toBe('bulk-failed');
    const attempted = h.commands();
    expect(attempted.length).toBeGreaterThan(0);
    expect(h.effects.size).toBe(effects);
    expect(await h.driver.observe(source)).toEqual(before);
    await h.reopen();
    h.calls = [];
    h.respond = async (commands) => commands.map(() => 'acknowledged');
    committed(await h.run(changed(dump)), { changed: ['Q1'], unchanged: keys.slice(1) });
    for (const command of attempted) expect(h.commands()).toContainEqual(command);
  });
});

test('crash after API acknowledgement replays stable keys after durable reopen without duplicate fake effects', async () => {
  await withLedger(async (h) => {
    const dump = await fixture();
    h.driver.interruptNextAfterBulkSuccess();
    expect((await h.run(dump)).status).toBe('interrupted');
    expect(h.effects.size).toBeGreaterThan(0);
    const prior = h.commands();
    const count = h.effects.size;
    expect((await h.driver.observe(source)).committedSnapshot).toBeNull();
    await h.reopen();
    h.calls = [];
    expect((await h.run(dump)).status).toBe('committed');
    for (const c of prior) expect(h.commands()).toContainEqual(c);
    expect((await h.driver.observe(source)).rows.map((r) => r.recordKey)).toEqual(keys);
    // A bulk may be split: count the union of real acknowledged command keys.
    expect(h.effects.size).toBe(new Set([...prior, ...h.commands()].map((c) => c.idempotencyKey)).size);
    expect(h.effects.size).toBeGreaterThanOrEqual(count);
  });
});

test('concurrent identical same-source runs cannot duplicate commands or lose committed rows', async () => {
  await withLedger(async (h) => {
    const dump = await fixture();
    const results = await Promise.all([h.run(dump), h.run(dump)]);
    expect(results.some((r) => r.status === 'committed')).toBe(true);
    expect(results.every((r) => ['committed', 'busy'].includes(r.status))).toBe(true);
    expect((await h.driver.observe(source)).rows.map((r) => r.recordKey)).toEqual(keys);
    const byRecord = new Map<string, Set<string>>();
    for (const c of h.commands()) {
      const identity = JSON.stringify([c.source, c.external_id, c.field_group, c.command]);
      if (!byRecord.has(identity)) byRecord.set(identity, new Set());
      byRecord.get(identity)!.add(c.idempotencyKey);
    }
    expect([...byRecord.values()].every((ids) => ids.size === 1)).toBe(true);
    expect(h.effects.size).toBe(byRecord.size);
    committed(await h.run(dump), { unchanged: keys });
  });
});

test('independent concurrent sources with identical keys have isolated rows checkpoints and command identities', async () => {
  await withLedger(async (h) => {
    const dump = await fixture();
    const other = 'wikidata-secondary';
    const entered = deferred();
    const release = deferred();
    h.respond = async (commands) => {
      if (commands.some((c) => c.source === source)) {
        entered.resolve();
        await release.promise;
      }
      return commands.map(() => 'acknowledged');
    };
    const first = h.run(dump);
    try {
      await entered.promise;
      committed(await h.run(changed(dump), { source: other }), { new: keys });
      expect((await h.driver.observe(source)).committedSnapshot).toBeNull();
    } finally {
      release.resolve();
      await first;
    }
    const a = await h.driver.observe(source);
    const b = await h.driver.observe(other);
    expect(a.rows.map((r) => r.recordKey)).toEqual(keys);
    expect(b.rows.map((r) => r.recordKey)).toEqual(keys);
    expect(b.rows.every((r) => r.source === other)).toBe(true);
    expect(a.rows[0]!.digest).not.toBe(b.rows[0]!.digest);
    const aIds = new Set(
      h
        .commands()
        .filter((c) => c.source === source)
        .map((c) => c.idempotencyKey),
    );
    expect(
      h
        .commands()
        .filter((c) => c.source === other)
        .every((c) => !aIds.has(c.idempotencyKey)),
    ).toBe(true);
    await h.reopen();
    expect(await h.driver.observe(source)).toEqual(a);
    expect(await h.driver.observe(other)).toEqual(b);
    h.calls = [];
    expect((await h.run('', { source: other })).status).toBe('mass-disappearance');
    expect(await h.driver.observe(source)).toEqual(a);
    expect(await h.driver.observe(other)).toEqual(b);
    expect(h.calls).toEqual([]);
  });
});

test('every unchanged refresh checks source external id and field group fences and changed data cannot restore them', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const fields = keys.flatMap((external_id) =>
      FIELD_GROUPS.map((field_group) => ({ source, external_id, field_group })),
    );
    const title = h
      .commands()
      .find(
        (c) =>
          c.kind === 'propose' &&
          c.command.op === 'propose' &&
          c.command.statement.property.id === 'schema:name' &&
          c.values.includes('Ledger One'),
      )!;
    expect(title).toBeDefined();
    h.fences.add(fenceId(title));
    h.calls = [];
    h.lookups = [];
    committed(await h.run(dump), { unchanged: keys });
    for (const field of fields) expect(h.lookups).toContainEqual(field);
    expect(h.calls).toEqual([]);
    h.lookups = [];
    expect((await h.run(changed(dump))).status).toBe('committed');
    for (const field of fields) expect(h.lookups).toContainEqual(field);
    expect(h.commands().filter((c) => fenceId(c) === fenceId(title))).toEqual([]);
    await h.reopen();
    h.calls = [];
    h.lookups = [];
    expect((await h.run(changed(dump), { converter_revision: 'ledger-converter-2' })).status).toBe('committed');
    for (const field of fields) expect(h.lookups).toContainEqual(field);
    expect(h.commands().filter((c) => fenceId(c) === fenceId(title))).toEqual([]);
  });
});

test('fence keys do not suppress another source record or field group', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const title = h
      .commands()
      .find(
        (c) =>
          c.kind === 'propose' &&
          c.command.op === 'propose' &&
          c.command.statement.property.id === 'schema:name' &&
          c.values.includes('Ledger One'),
      )!;
    expect(title).toBeDefined();
    h.fences.add(fenceId(title));
    h.calls = [];
    expect((await h.run(dump, { converter_revision: 'ledger-converter-2' })).status).toBe('committed');
    expect(h.commands().some((c) => c.external_id === 'Q2' && c.field_group === title.field_group)).toBe(true);
    // Wikidata emits facts here, not fabricated summary/cover commands. Check
    // group isolation by fencing an absent group and refreshing real facts.
    h.fences.delete(fenceId(title));
    h.fences.add(fenceId({ source, external_id: 'Q1', field_group: 'summary' }));
    h.calls = [];
    expect((await h.run(dump, { converter_revision: revision })).status).toBe('committed');
    expect(h.commands().some((c) => c.external_id === 'Q1' && c.field_group === title.field_group)).toBe(true);
    h.fences.add(fenceId(title));
    h.calls = [];
    committed(await h.run(dump, { source: 'wikidata-secondary' }), { new: keys });
    expect(h.commands().some((c) => c.external_id === 'Q1' && c.field_group === title.field_group)).toBe(true);
  });
});

test('new fence after lookup and bulk rejection leaves the record unacknowledged and retry omits the fenced field', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const title = h
      .commands()
      .find(
        (c) =>
          c.kind === 'propose' &&
          c.command.op === 'propose' &&
          c.command.statement.property.id === 'schema:name' &&
          c.values.includes('Ledger One'),
      )!;
    expect(title).toBeDefined();
    const before = await h.driver.observe(source);
    h.lookups = [];
    // Failure injection after an open lookup. Reference rechecks and final public
    // disclosure are server facts covered separately by the real API suite.
    h.respond = async (commands) => {
      expect(h.lookups).toContainEqual({ source, external_id: title.external_id, field_group: title.field_group });
      h.fences.add(fenceId(title));
      return commands.map((c) => (fenceId(c) === fenceId(title) ? 'rejected' : 'acknowledged'));
    };
    expect((await h.run(changed(dump))).status).toBe('bulk-failed');
    expect((await h.driver.observe(source)).rows[0]).toEqual(before.rows[0]);
    expect((await h.driver.observe(source)).committedSnapshot).toBe(before.committedSnapshot);
    await h.reopen();
    h.calls = [];
    h.respond = async (commands) => commands.map(() => 'acknowledged');
    expect((await h.run(changed(dump))).status).toBe('committed');
    expect(h.commands().filter((c) => fenceId(c) === fenceId(title))).toEqual([]);
  });
});

// Each corrupt response is independent of the durable crash/rejection outcomes.
// The fake first accepts effects; uncertain delivery cannot advance the baseline.
async function corruptResponse(h: Harness, corrupt: (result: BatchWriteResult) => BatchWriteResult) {
  const dump = await h.seed();
  const before = await h.driver.observe(source);
  h.calls = [];
  h.afterResponse = corrupt;
  expect((await h.run(changed(dump))).status).toBe('bulk-failed');
  expect(await h.driver.observe(source)).toEqual(before);
  const attempted = h.commands();
  expect(attempted.length).toBeGreaterThan(0);
  const receipts = structuredClone(h.receipts);
  await h.reopen();
  h.calls = [];
  h.afterResponse = (result) => result;
  committed(await h.run(changed(dump)), { changed: ['Q1'], unchanged: keys.slice(1) });
  for (const c of attempted) {
    expect(h.commands()).toContainEqual(c);
    expect(h.receipts.get(c.idempotencyKey)).toEqual(receipts.get(c.idempotencyKey));
  }
  const effects = h.effects.size;
  h.calls = [];
  committed(await h.run(changed(dump)), { unchanged: keys });
  expect(h.calls).toEqual([]);
  expect(h.effects.size).toBe(effects);
}

test('malformed portable result cannot advance durable acknowledgement', async () => {
  await withLedger(async (h) => {
    h.allowMalformedResponse = true;
    await corruptResponse(h, (result) => {
      const malformed = { results: result.results.map((entry) => ({ ...entry, status: 202 })) };
      expect(checkBatchWriteResult(malformed).length).toBeGreaterThan(0);
      return malformed as BatchWriteResult;
    });
  });
});

test('missing response key cannot advance durable acknowledgement', async () => {
  await withLedger((h) =>
    corruptResponse(h, (result) => {
      h.allowMalformedResponse = true; // Empty results also violate the real schema.
      return { results: result.results.slice(1) };
    }),
  );
});

test('duplicate response key cannot advance durable acknowledgement', async () => {
  await withLedger((h) =>
    corruptResponse(h, (result) => {
      h.allowMalformedResponse = true; // A full batch plus duplicate also exceeds max100.
      return { results: [result.results[0]!, ...result.results] };
    }),
  );
});

test('mismatched response key cannot advance durable acknowledgement', async () => {
  await withLedger((h) =>
    corruptResponse(h, (result) => ({
      results: result.results.map((entry) => ({
        ...entry,
        key: entry.key === 'fixture-unrequested-key' ? 'fixture-other-key' : 'fixture-unrequested-key',
      })),
    })),
  );
});

test('lost response after accepted effects replays cached portable candidate identities', async () => {
  await withLedger((h) =>
    corruptResponse(h, () => {
      throw new Error('fixture response lost after acceptance');
    }),
  );
});

test('missing native revision remains unversioned with digest based change detection', async () => {
  await withLedger(async (h) => {
    const dump = (await fixture()).replaceAll(/,"lastrevid":\d+/g, '');
    committed(await h.run(dump), { new: keys });
    expect((await h.driver.observe(source)).rows.map((row) => row.recordRevision)).toEqual(
      keys.map(() => 'unversioned'),
    );
    for (const command of h.commands()) expect(command.command.source.record_revision).toBe('unversioned');
    await h.reopen();
    h.calls = [];
    committed(await h.run(dump), { unchanged: keys });
    expect(h.calls).toEqual([]);
    committed(await h.run(changed(dump)), { changed: ['Q1'], unchanged: keys.slice(1) });
    expect((await h.driver.observe(source)).rows[0]!.recordRevision).toBe('unversioned');
  });
});

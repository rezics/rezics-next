import { expect, test } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { isAbsolute, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import type {
  CommandObservation,
  CreateImportLedgerDriver,
  FenceKey,
  ImportLedgerDriver,
  RunInput,
  RunResult,
} from './imports-ledger-driver';

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
  await mkdir('.temp', { recursive: true });
  const directory = await mkdtemp(resolve('.temp/import-ledger-'));
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
        return this.fences.has(fenceId(key));
      },
      bulk: {
        send: async (request) => {
          // A real semantic structural consumer MUST accept this production output.
          const commands = this.driver.inspectBulk(request);
          expect(commands.length).toBeGreaterThan(0);
          for (const c of commands) {
            expect(c.command).toBeDefined();
            expect(c.command).not.toBeNull();
            expect(typeof c.command).toBe('object');
            expect(Object.keys(c.command as object).length).toBeGreaterThan(0);
            expect(c.idempotencyKey.trim().length).toBeGreaterThan(0);
            expect(c.source.trim().length).toBeGreaterThan(0);
            expect(c.external_id).toMatch(/^Q[1-5]$/);
            expect(c.field_group.trim().length).toBeGreaterThan(0);
            expect(c.kind).toBe('proposal');
            expect(c.references).toContain(`https://www.wikidata.org/entity/${c.external_id}`);
            expect(c.licenses).toContain('CC0-1.0');
            const wire = JSON.stringify(request);
            expect(wire).toContain(JSON.stringify(c.command));
            for (const value of [...c.references, ...c.licenses, ...c.values, c.field_group, c.idempotencyKey]) {
              expect(wire).toContain(JSON.stringify(value));
            }
            // These are underlying serialized commands, not a sanitized observation.
            for (const secret of secrets) expect(JSON.stringify(request)).not.toContain(secret);
          }
          this.raw.push(structuredClone(request));
          this.calls.push(structuredClone(commands));
          const results = await this.respond(commands);
          expect(results.length).toBe(commands.length);
          commands.forEach((c, i) => {
            if (results[i] !== 'acknowledged') return;
            const serialized = JSON.stringify(c.command);
            if (this.effects.has(c.idempotencyKey)) expect(this.effects.get(c.idempotencyKey)).toBe(serialized);
            else this.effects.set(c.idempotencyKey, serialized);
          });
          return results;
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
    expect(h.calls).toEqual([]);
    const four = await h.driver.observe(source);
    // The denominator is the last snapshot's four present records, not five
    // historical ledger rows: one more disappearance is now twenty-five percent.
    expect((await h.run(subset(dump, 3))).status).toBe('mass-disappearance');
    expect(await h.driver.observe(source)).toEqual(four);
    expect(h.calls).toEqual([]);
    expect((await h.run(dump)).status).toBe('committed');
    expect((await h.driver.observe(source)).rows.map((r) => r.state)).toEqual(keys.map(() => 'present'));
    expect(h.commands().every((c) => c.kind === 'proposal')).toBe(true);
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
          .filter((c) => c.external_id !== 'Q2')
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
    expect(h.commands().filter((c) => c.external_id === 'Q2')).toEqual(rejected);
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
    expect(h.commands()).toEqual(attempted);
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
    const fields = h.commands().map(({ source, external_id, field_group }) => ({ source, external_id, field_group }));
    const title = h.commands().find((c) => c.values.includes('Ledger One'))!;
    expect(title).toBeDefined();
    h.fences.add(fenceId(title));
    h.calls = [];
    h.lookups = [];
    committed(await h.run(dump), { unchanged: keys });
    for (const field of fields) expect(h.lookups).toContainEqual(field);
    expect(h.calls).toEqual([]);
    h.lookups = [];
    expect((await h.run(changed(dump))).status).toBe('committed');
    expect(h.lookups).toContainEqual({ source, external_id: title.external_id, field_group: title.field_group });
    expect(h.commands().filter((c) => fenceId(c) === fenceId(title))).toEqual([]);
    await h.reopen();
    h.calls = [];
    expect((await h.run(changed(dump), { converter_revision: 'ledger-converter-2' })).status).toBe('committed');
    expect(h.commands().filter((c) => fenceId(c) === fenceId(title))).toEqual([]);
  });
});

test('fence keys do not suppress another source record or field group', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const title = h.commands().find((c) => c.values.includes('Ledger One'))!;
    expect(title).toBeDefined();
    h.fences.add(fenceId(title));
    h.calls = [];
    expect((await h.run(dump, { converter_revision: 'ledger-converter-2' })).status).toBe('committed');
    expect(h.commands().some((c) => c.external_id === 'Q2' && c.field_group === title.field_group)).toBe(true);
    expect(h.commands().some((c) => c.external_id === 'Q1' && c.field_group !== title.field_group)).toBe(true);
    h.calls = [];
    committed(await h.run(dump, { source: 'wikidata-secondary' }), { new: keys });
    expect(h.commands().some((c) => c.external_id === 'Q1' && c.field_group === title.field_group)).toBe(true);
  });
});

test('new fence at server write rejection leaves the record unacknowledged and retry omits the fenced field', async () => {
  await withLedger(async (h) => {
    const dump = await h.seed();
    const title = h.commands().find((c) => c.values.includes('Ledger One'))!;
    expect(title).toBeDefined();
    const before = await h.driver.observe(source);
    h.lookups = [];
    // The fake represents a server refusal AFTER the importer read an open fence.
    // Actual atomic server fence rechecking must pass the production API suite.
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

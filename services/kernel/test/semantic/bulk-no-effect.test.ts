import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { bundledDigest, bundledRelease } from '@rezics/definitions/bundled';
import type { BatchCommand, Source } from '@rezics/definitions/bulk';
import pg, { type PoolClient, type QueryConfig } from 'pg';
import { createImportTransport, importCommandPages } from '../../../importer/src/import-client.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../../../importer/src/showcase-journal.ts';
import { GrantDeniedError } from '../../src/access/grant-commands.ts';
import { resourceAuthorization } from '../../src/access/resource-authorization.ts';
import {
  authoritativeTimeValue,
  currentCommand,
  IdempotencyConflictError,
  type CommandAttempt,
  type CommandAuthorization,
} from '../../src/command/command.ts';
import { encodeReceiptKey } from '../../src/command/receipt-key.ts';
import { createPool } from '../../src/database/pool.ts';
import { createKernel } from '../../src/http/kernel.ts';
import { requestDigest } from '../../src/http/request.ts';
import type { Access } from '../../src/request/access.ts';
import { deadlineFor } from '../../src/request/deadline.ts';
import { partitionOf } from '../../src/route/route.ts';
import { batchCommand, batchRoute, guardBatchAuthorization } from '../../src/semantic/bulk.ts';
import { globalContextAnchor } from '../../src/semantic/context.ts';
import { bootstrapRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import {
  enforceSourceFence,
  prepareFencePlan,
  readAnchoredFences,
  rememberFences,
  sourceTuple,
} from '../../src/semantic/fences.ts';
import { createRealAccess } from './real-access.ts';
import { testReceiptKeys } from '../support/receipt-keys.ts';

const databaseUrl = process.env.DATABASE_URL;
if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
const pool = createPool(databaseUrl);
const admin = new pg.Pool({ connectionString: databaseUrl, max: 2 });
const accounts = { importer: '019a1b2c-3d4e-7f00-8a00-1a0000000061' };
const actions = ['subject:create', 'subject:batch_write', 'statement:propose'];
const real = await createRealAccess(admin, accounts, actions);
const routeKey = new Uint8Array(32).fill(4);
let access: Access;
const kernel = createKernel({
  pool,
  receiptKeys: testReceiptKeys(),
  access(config) {
    return (access = real.access(config));
  },
  routeKey,
  tokens: { current: 1, keys: new Map([[1, new Uint8Array(32).fill(3)]]) },
  writeRate: real.writeRate,
});
const global = { route: 0, id: GLOBAL_CONTEXT };
const release = { digest: bundledDigest, release: bundledRelease };

beforeAll(async () => {
  for (const action of actions) await real.grant(global, 'importer', action);
  expect(await bootstrapRelease(pool, bundledRelease)).toBe(bundledDigest);
});
afterAll(async () => {
  await pool.end();
  await admin.end();
});

async function batch(command: BatchCommand) {
  const response = await kernel.handle(
    new Request('http://kernel.test/v1/subjects:batchWrite', {
      method: 'POST',
      headers: { authorization: `Bearer ${real.bearer('importer')}`, 'content-type': 'application/json' },
      body: JSON.stringify({ commands: [command] }),
    }),
  );
  expect(response.status).toBe(200);
  return (await response.json()).results[0] as {
    status: number;
    value: { id?: string; candidate?: string; revision: number };
  };
}

async function fixture() {
  const source: Source = {
    source: 'openlibrary',
    external_id: `OL${randomUUID()}W`,
    record_revision: 'unversioned',
    digest: 'c'.repeat(64),
    converter_revision: 'openlibrary@1',
    field_group: 'facts',
  };
  const create: BatchCommand = {
    op: 'create',
    key: randomUUID(),
    source,
    subject: { type: 'schema:Book', labels: { en: 'Native duplicate source' } },
  };
  const created = await batch(create);
  expect(created.status).toBe(201);
  const id = created.value.id!;
  const propose: BatchCommand = {
    op: 'propose',
    key: randomUUID(),
    source,
    subject: id,
    statement: {
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: 'ja' },
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://openlibrary.org/works/OL1W' } },
          ],
        },
      ],
    },
  };
  const proposed = await batch(propose);
  expect(proposed.status).toBe(201);
  const route = batchRoute(routeKey, create)!;
  expect(
    (
      await admin.query(
        'SELECT subject_id FROM semantic.external_claim WHERE route=$1 AND source=$2 AND external_id=$3',
        [route, source.source, source.external_id],
      )
    ).rows,
  ).toEqual([{ subject_id: id }]);
  expect(
    (
      await admin.query(
        'SELECT candidate_id FROM semantic.source_candidate WHERE route=$1 AND subject_id=$2 AND source=$3 AND external_id=$4 AND field_group=$5',
        [route, id, source.source, source.external_id, source.field_group],
      )
    ).rows,
  ).toEqual([{ candidate_id: proposed.value.candidate }]);
  return {
    id,
    route,
    partition: partitionOf(route),
    commands: [
      { command: create, value: { id, revision: 2 } },
      { command: propose, value: { candidate: proposed.value.candidate!, revision: 2 } },
    ],
  };
}

// Fixed native reads scoped to this exact subject/tuple or its partition; no production JSON search fixture.
async function snapshot(f: Awaited<ReturnType<typeof fixture>>) {
  const queries = [
    ['SELECT * FROM core.partition WHERE partition_no=$1', [f.partition]],
    ['SELECT * FROM core.outbox WHERE partition_no=$1 ORDER BY position,event_seq', [f.partition]],
    ['SELECT * FROM editorial.write_basis WHERE partition_no=$1 ORDER BY position', [f.partition]],
    ['SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2', [f.route, f.id]],
    ['SELECT * FROM semantic.revision WHERE route=$1 AND subject_id=$2 ORDER BY revision', [f.route, f.id]],
    ['SELECT * FROM semantic.fact WHERE route=$1 AND subject_id=$2 ORDER BY log_seq', [f.route, f.id]],
    ['SELECT * FROM semantic.candidate WHERE route=$1 AND subject_id=$2 ORDER BY candidate_id', [f.route, f.id]],
    [
      'SELECT * FROM semantic.source_candidate WHERE route=$1 AND subject_id=$2 ORDER BY statement_digest',
      [f.route, f.id],
    ],
    [
      'SELECT * FROM semantic.external_claim WHERE route=$1 AND subject_id=$2 ORDER BY source,external_id',
      [f.route, f.id],
    ],
  ] as const;
  return Promise.all(queries.map(async ([sql, values]) => (await admin.query(sql, [...values])).rows));
}

async function receipt(partition: number, command: BatchCommand) {
  return (
    await admin.query(
      `SELECT epoch, position, transaction_id, response, request_digest FROM core.receipt
     WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
      [
        partition,
        accounts.importer,
        `subject.batch_${command.op}`,
        encodeReceiptKey(
          testReceiptKeys(),
          `subject.batch_${command.op}`,
          { kind: 'account', id: accounts.importer },
          command.key,
        ),
      ],
    )
  ).rows;
}

async function invocation(command: BatchCommand, fault?: Error) {
  const deadline = deadlineFor(2000);
  const actor = await access.authenticate(real.bearer('importer'), { pool, deadline });
  const route = batchRoute(routeKey, command)!;
  const partition = partitionOf(route);
  const { plan, outside } = prepareFencePlan(routeKey, [{ route, source: command.source }]);
  for (const [home, tuples] of outside) rememberFences(plan, await readAnchoredFences(pool, home, tuples));
  const realAuthorization = guardBatchAuthorization(
    resourceAuthorization({
      access,
      actor,
      action: command.op === 'create' ? 'subject:create' : 'statement:propose',
      anchor: globalContextAnchor,
      context: { pool, deadline, partition },
    }),
    command,
    route,
    (tx) => enforceSourceFence(tx, plan, partition, sourceTuple(routeKey, command.source)),
  );
  let prepared: CommandAttempt | undefined;
  let evidence: unknown;
  let finalized = 0;
  const authorization: CommandAuthorization = {
    ...realAuthorization,
    async prepare(attempt) {
      prepared = attempt;
      evidence = await realAuthorization.prepare!(attempt);
      return evidence;
    },
    async finalize(tx, attempt, proof) {
      finalized++;
      expect(attempt).toBe(prepared!);
      expect(proof).toBe(evidence);
      expect(currentCommand(tx).time).toBe(attempt.time);
      expect(currentCommand(tx).basis).toBe(attempt.basis);
      expect(authoritativeTimeValue(attempt.time)).toBeString();
      expect(
        (
          await tx.query(
            `SELECT 1 FROM core.receipt WHERE partition_no=$1 AND principal_kind='account'
         AND principal_id=$2 AND command_kind=$3 AND idempotency_key=$4`,
            [
              partition,
              actor.accountId,
              `subject.batch_${command.op}`,
              encodeReceiptKey(
                testReceiptKeys(),
                `subject.batch_${command.op}`,
                { kind: 'account', id: actor.accountId },
                command.key,
              ),
            ],
          )
        ).rows,
      ).toEqual([]);
      await realAuthorization.finalize?.(tx, attempt, proof);
      if (fault) throw fault;
    },
  };
  return {
    actor,
    run: () => batchCommand(pool, { command, route, actor, authorization, release, deadline, clock: () => new Date() }),
    finalized: () => finalized,
  };
}

test('a native duplicate bulk source resolve cannot skip authorization finalize or commit its receipt early', async () => {
  const f = await fixture();
  const observed = [];
  for (const { command: original } of f.commands) {
    const command = { ...original, key: randomUUID() };
    const before = await snapshot(f);
    const fault = new Error('native duplicate finalizer refused');
    const attempt = await invocation(command, fault);
    let thrown: unknown;
    try {
      await attempt.run();
    } catch (error) {
      thrown = error;
    }
    observed.push({
      op: command.op,
      fault: thrown === fault,
      finalized: attempt.finalized(),
      receipts: await receipt(f.partition, command),
      unchanged: Bun.deepEquals(await snapshot(f), before),
    });
  }
  expect(observed).toEqual(
    (['create', 'propose'] as const).map((op) => ({ op, fault: true, finalized: 1, receipts: [], unchanged: true })),
  );
});

test('successful no-effect bulk resolve and replay preserve position and no outbox effect', async () => {
  const f = await fixture();
  for (const { command: original, value } of f.commands) {
    const command = { ...original, key: randomUUID() };
    const before = await snapshot(f);
    const state = before[0]![0]!;
    const first = await invocation(command);
    const result = await first.run();
    expect(result).toEqual({
      status: 200,
      value,
      component: {
        partition: f.partition,
        epoch: state.epoch,
        position: BigInt(state.position),
      },
    });
    const rows = await receipt(f.partition, command);
    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      epoch: state.epoch,
      position: state.position,
      transaction_id: expect.stringMatching(/^[0-9a-f-]{36}$/),
      response: { status: 200, value },
      request_digest: Buffer.from(requestDigest(`subject.batch_${command.op}`, first.actor, command)),
    });
    expect(await snapshot(f)).toEqual(before);
    expect(await (await invocation(command)).run()).toEqual(result);
    expect(await receipt(f.partition, command)).toEqual(rows);
    expect(await snapshot(f)).toEqual(before);
    const changed = { ...command, source: { ...command.source, record_revision: 'different request' } };
    await expect((await invocation(changed)).run()).rejects.toBeInstanceOf(IdempotencyConflictError);
    const action = command.op === 'create' ? 'subject:create' : 'statement:propose';
    await real.revoke(global, 'importer', action);
    try {
      await expect((await invocation(command)).run()).rejects.toBeInstanceOf(GrantDeniedError);
    } finally {
      await real.grant(global, 'importer', action);
    }
    expect(await receipt(f.partition, command)).toEqual(rows);
    expect(await snapshot(f)).toEqual(before);
  }
});

test('a facts proposal retries native contention and lands once under the original key', async () => {
  const created = await fixture();
  const propose: BatchCommand = {
    op: 'propose',
    key: randomUUID(),
    source: {
      source: 'openlibrary',
      external_id: `OL${randomUUID()}W`,
      record_revision: 'unversioned',
      digest: 'd'.repeat(64),
      converter_revision: 'openlibrary@1',
      field_group: 'facts',
    },
    subject: created.id,
    statement: {
      property: { id: 'schema:inLanguage' },
      value: { type: 'value', content: 'en' },
      references: [
        {
          parts: [
            { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://openlibrary.org/works/OL2W' } },
          ],
        },
      ],
    },
  };
  const originals = new Map<PoolClient, PoolClient['query']>();
  let retried = false;
  const intercept = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = ((statement: QueryConfig | string, ...args: unknown[]) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      if (!retried && text.includes('INSERT INTO semantic.candidate')) {
        retried = true;
        throw Object.assign(new Error('Retry facts proposal'), { code: '40001' });
      }
      return Reflect.apply(query, client, [statement, ...args]);
    }) as PoolClient['query'];
  };
  pool.on('acquire', intercept);
  try {
    const result = await batch(propose);
    expect(retried).toBe(true);
    expect(result.status).toBe(201);
    expect(result.value.candidate).toBeString();
  } finally {
    pool.off('acquire', intercept);
    for (const [client, query] of originals) client.query = query;
  }
});

test('seed creates across sixteen partitions retry native contention and acknowledge each exact key once', async () => {
  const partitions = new Set<number>();
  const commands: BatchCommand[] = [];
  while (commands.length < 16) {
    const command: BatchCommand = {
      op: 'create',
      key: randomUUID(),
      source: {
        source: 'openlibrary',
        external_id: randomUUID(),
        record_revision: '1',
        digest: 'e'.repeat(64),
        converter_revision: 'fixture@1',
        field_group: 'facts',
      },
      subject: { type: 'skos:Concept', labels: { en: 'Seed identity contention' } },
    };
    const partition = partitionOf(batchRoute(routeKey, command)!);
    if (partitions.has(partition)) continue;
    partitions.add(partition);
    commands.push(command);
  }
  const sent: BatchCommand[][] = [];
  const transport = createImportTransport({
    origin: 'http://kernel.test',
    tokenProvider: async () => real.bearer('importer'),
    fetch: (async (input, init) => {
      const request = new Request(input, init);
      sent.push((await request.clone().json()).commands);
      return kernel.handle(request);
    }) as typeof fetch,
  });
  const journal = new ShowcaseJournal(':memory:');
  const port = captureShowcaseCommands(transport, journal);
  const originals = new Map<PoolClient, PoolClient['query']>();
  let contended = false;
  const intercept = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = ((statement: QueryConfig | string, ...args: unknown[]) => {
      const text = typeof statement === 'string' ? statement : statement.text;
      if (!contended && /INSERT\s+INTO semantic.identity_epoch_mapping/.test(text)) {
        contended = true;
        throw Object.assign(new Error('Concurrent identity creation'), { code: '40001' });
      }
      return Reflect.apply(query, client, [statement, ...args]);
    }) as PoolClient['query'];
  };
  pool.on('acquire', intercept);
  try {
    for (const command of commands) journal.prepareCommand(command);
    for (const page of importCommandPages(journal.preparedCommands(), (row) => row.command)) {
      const result = await port.batch({ commands: page.map((row) => row.command) });
      expect(result.results.every((row) => row.status === 201)).toBe(true);
    }
    expect(contended).toBe(true);
    expect(sent.every((page) => page.length === 1)).toBe(true);
    expect(sent[0]).toEqual(sent[1]);
    expect(new Set(sent.flat().map((command) => command.key)).size).toBe(16);
    expect(journal.preparedCommands()).toEqual([]);
    const acknowledgements = journal.acknowledgedCommands();
    expect(acknowledgements).toHaveLength(16);
    const ack = acknowledgements[0]!;
    const replay = await port.batch({ commands: [ack.command] });
    expect(replay.results[0]).toMatchObject({ key: ack.command.key, status: 201, value: { id: ack.subjectId } });
    expect(journal.acknowledgedCommands()).toEqual(acknowledgements);
  } finally {
    pool.off('acquire', intercept);
    for (const [client, query] of originals) client.query = query;
    journal.close();
  }
}, 120_000);

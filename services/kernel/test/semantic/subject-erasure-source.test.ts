import { afterAll, beforeAll, expect, test } from 'bun:test';
import { currentCommand, noEffect, runCommand } from '../../src/command/command.ts';
import { recordSemanticSourceCommit } from '../../src/semantic/erasure-producer.ts';
import { searchIdentityWriterChanged } from '../../src/search/identity-epoch-participant-events.ts';
import type { HistoryBarrier } from '../../src/history/registry.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import {
  createSubjectErasureSource,
  readSubjectErasureSourceProof,
  verifySubjectErasureSourcePage,
  verifySubjectErasureSourceProof,
} from '../../src/semantic/account-erasure-source.ts';
import type {
  SubjectErasurePageReceipt,
  SubjectErasureSourceProof,
  SubjectErasureSourceRecord,
} from '../../src/semantic/account-erasure-source-contract.ts';
import {
  beginSemanticErasure,
  readSemanticErasure,
  SEMANTIC_ERASURE_PROGRESS,
} from '../../src/semantic/account-erasure.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';
import { accountErasureWorker } from './support/account-erasure-worker.ts';

let f: AccountErasureFixture;
let worker: Awaited<ReturnType<typeof accountErasureWorker>>;
beforeAll(async () => {
  f = await accountErasureFixture();
  worker = await accountErasureWorker(f.db.url);
}, 180_000);
afterAll(async () => {
  try {
    await worker?.stop();
  } finally {
    await f?.close();
  }
}, 120_000);

const context = () => ({ deadline: Date.now() + 5000 });
const config = () => ({ pool: f.db.pool, routeKey: testRouteKey(), access: f.native.access, clock: () => new Date() });
async function barrier(accountId: string): Promise<HistoryBarrier> {
  const row = (
    await f.db.admin.query<HistoryBarrier>(
      'SELECT account_id::text AS "accountId",route AS "accountRoute",version,at::text FROM access.erasure WHERE route=$1 AND account_id=$2',
      [routeOf(accountId), accountId],
    )
  ).rows[0];
  if (!row) throw new Error('Expected the native committed erasure root');
  return row;
}
async function command<T>(b: HistoryBarrier, action: Parameters<typeof runCommand<T>>[2]) {
  return runCommand(
    f.db.pool,
    {
      partition: partitionOf(b.accountRoute),
      basis: {
        actorAccountId: '00000000-0000-8000-8000-000000000001',
        clientId: 'native-source-erasure-test',
        requestedBy: null,
      },
    },
    action,
  );
}
const events = (b: HistoryBarrier) => [
  { type: SEMANTIC_ERASURE_PROGRESS, subject: b.accountId, data: { accountId: b.accountId } },
];
async function local(b: HistoryBarrier) {
  await beginSemanticErasure(f.db.pool, b.accountId);
  const end = Date.now() + 180_000;
  while ((await readSemanticErasure(f.db.pool, b.accountId))?.state !== 'pending-shared-custody') {
    if (Date.now() >= end) throw new Error('Actual default local erasure did not complete');
    await Bun.sleep(20);
  }
}
async function complete(b: HistoryBarrier) {
  const records: SubjectErasureSourceRecord[] = [];
  let frontier: string | null = null;
  let proof: SubjectErasureSourceProof | null = null;
  let receipt: SubjectErasurePageReceipt | undefined;
  let pages = 0;
  const end = Date.now() + 180_000;
  for (;;) {
    if (Date.now() >= end) throw new Error('Native sealed Source disposition did not complete');
    // Fresh instances and serialized locators exercise durable replay, never object identity.
    const page = await createSubjectErasureSource(config()).readPage({
      barrier: b,
      frontier,
      inputLimit: 100,
      context: context(),
    });
    expect(page.cost.inputKeys).toBeLessThanOrEqual(100);
    if (!('receipt' in page)) {
      await Bun.sleep(10);
      continue;
    }
    receipt = { ...page.receipt };
    const accepted = await command(b, async (tx) => ({
      value: await verifySubjectErasureSourcePage(tx, b, receipt!),
      events: events(b),
    }));
    expect(accepted.value).toBe(true);
    records.push(...page.records);
    pages++;
    if (!proof) proof = await readSubjectErasureSourceProof({ pool: f.db.pool }, b, context());
    if (page.status === 'complete') break;
    expect(Buffer.byteLength(page.frontier)).toBeLessThanOrEqual(2048);
    frontier = page.frontier;
  }
  while (!proof) {
    if (Date.now() >= end) throw new Error('Independent native Source terminal proof did not complete');
    proof = await readSubjectErasureSourceProof({ pool: f.db.pool }, b, context());
  }
  expect(pages).toBeGreaterThanOrEqual(4096);
  expect(
    (
      await command(b, async (tx) => ({
        value: await verifySubjectErasureSourceProof(tx, b, { ...proof! }),
        events: events(b),
      }))
    ).value,
  ).toBe(true);
  return { records, receipt: receipt!, proof };
}
async function subject(who: Awaited<ReturnType<AccountErasureFixture['author']>>, label: string) {
  const response = await f.call(who, 'POST', '/v1/subjects', { type: 'schema:Person', labels: { en: label } });
  expect(response.status, JSON.stringify(response.body)).toBe(201);
  return response.body.subject.id as string;
}

test('Search receives sealed role-complete Subject source disposition and actual source custody for the committed erased account without scalar-role or structural identity substitution', async () => {
  const author = await f.author();
  const survivor = await f.author();
  const id = await subject(author, 'Communal contribution');
  const other = await subject(survivor, 'Independent surviving contribution');
  const proposed = await f.call(author, 'POST', `/v1/subjects/${id}/candidates`, {
    statement: {
      property: { id: 'rezics:penNameOf' },
      value: { type: 'value', content: accountAgentId(author.accountId) },
    },
  });
  expect(proposed.status, JSON.stringify(proposed.body)).toBe(201);
  const candidate = proposed.body.candidate as string;
  const created = await f.call(author, 'POST', '/v1/contexts', { labels: { en: 'Former owner Context' } });
  expect(created.status, JSON.stringify(created.body)).toBe(201);
  const contextId = created.body.context.id as string;
  const valid = (
    await f.db.admin.query(
      "SELECT valid::text FROM access.resource_role_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3 AND grant_role='semantic.context.owner' AND upper_inf(valid)",
      [routeOf(contextId), contextId, author.accountId],
    )
  ).rows[0].valid;
  expect(
    (
      await f.call(author, 'POST', '/v1/roleGrants', {
        resource: { route: routeOf(contextId), id: contextId },
        subject: { kind: 'account', id: survivor.accountId },
        role: 'semantic.context.owner',
        valid,
      })
    ).status,
  ).toBe(201);
  expect(
    (
      await f.call(author, 'POST', '/v1/roleGrants:revoke', {
        resource: { route: routeOf(contextId), id: contextId },
        subject: { kind: 'account', id: author.accountId },
        role: 'semantic.context.owner',
        valid,
      })
    ).status,
  ).toBe(200);
  const before = (
    await f.db.admin.query('SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2', [routeOf(other), other])
  ).rows;
  await f.tombstone(author);
  const b = await barrier(author.accountId);
  expect(await readSubjectErasureSourceProof({ pool: f.db.pool }, b, context())).toBeNull();
  await local(b);
  // Discovery completion alone cannot manufacture Source-local terminal custody.
  expect(await readSubjectErasureSourceProof({ pool: f.db.pool }, b, context())).toBeNull();
  const result = await complete(b);
  expect(result.records.some((r) => r.original === id && r.disposition === 'retain_deidentified')).toBe(true);
  expect(result.records.every((r) => r.original !== other)).toBe(true);
  expect(result.records.some((r) => r.repairLocators.some((l) => l.candidate === candidate))).toBe(true);
  expect(
    (
      await f.db.admin.query(
        'SELECT statement,erasure_private FROM semantic.candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3',
        [routeOf(id), id, candidate],
      )
    ).rows,
  ).toEqual([{ statement: {}, erasure_private: true }]);
  expect(
    (await f.db.admin.query('SELECT * FROM semantic.subject WHERE route=$1 AND subject_id=$2', [routeOf(other), other]))
      .rows,
  ).toEqual(before);
  expect(
    (
      await f.db.admin.query('SELECT labels FROM semantic.context WHERE route=$1 AND context_id=$2', [
        routeOf(contextId),
        contextId,
      ])
    ).rows,
  ).toEqual([{ labels: { en: 'Former owner Context' } }]);
  expect((await f.status(author.accountId))?.participants.semantic?.outcome).toBe('pending');
  const historicalOwner = (
    await f.db.admin.query(
      "SELECT 1 FROM semantic.erasure_source_record WHERE partition_no=$1 AND account_id=$2 AND store='context' AND role='owner' AND context_id=$3 LIMIT 1",
      [partitionOf(routeOf(contextId)!), author.accountId, contextId],
    )
  ).rowCount;
  expect(historicalOwner).toBe(1);
  expect(
    (
      await command(b, async (tx) => ({
        value: await verifySubjectErasureSourcePage(tx, { ...b, version: b.version + 1 }, result.receipt),
        events: events(b),
      }))
    ).value,
  ).toBe(false);
}, 360_000);

test('sealed empty native role homes advance before filters while a hidden original never borrows visible terminal disposition', async () => {
  const author = await f.author();
  const moderator = await f.author();
  await f.grant(GLOBAL_CONTEXT, moderator, ['subject:merge', 'moderation:hide']);
  const left = await subject(author, 'Original A');
  const right = await subject(author, 'Original B');
  const merged = await f.call(moderator, 'POST', '/v1/subjects:merge', { subjects: [left, right] });
  expect(merged.status, JSON.stringify(merged.body)).toBe(200);
  const original = merged.body.redirected as string;
  const terminal = merged.body.survivor as string;
  expect(
    (await f.call(moderator, 'POST', `/v1/subjects/${original}:hide`, { reason: 'Original is hidden' })).status,
  ).toBe(200);
  expect(
    (
      await f.db.admin.query('SELECT visibility FROM semantic.subject WHERE route=$1 AND subject_id=$2', [
        routeOf(terminal),
        terminal,
      ])
    ).rows,
  ).toEqual([{ visibility: 'visible' }]);
  await f.tombstone(author);
  const b = await barrier(author.accountId);
  await local(b);
  const result = await complete(b);
  const hidden = result.records.filter((r) => r.original === original);
  expect(hidden.length).toBeGreaterThan(0);
  expect(
    hidden.every((r) => r.disposition === 'remove' && r.currentTerminal === terminal && r.source?.subject === original),
  ).toBe(true);
  expect(result.records.some((r) => r.original === terminal && r.disposition === 'retain_deidentified')).toBe(true);
  const emptyHomes = (
    await f.db.admin.query("SELECT 1 FROM semantic.erasure_source_hold WHERE account_id=$1 AND store='' LIMIT 1", [
      author.accountId,
    ])
  ).rowCount;
  expect(emptyHomes).toBe(1);
}, 360_000);

test('changed native account custody rejects both serialized Source receipts and the independent terminal proof', async () => {
  const person = await f.person();
  await f.tombstone(person);
  const b = await barrier(person.accountId);
  await local(b);
  const result = await complete(b);
  await f.db.admin.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [
    partitionOf(b.accountRoute),
  ]);
  expect(
    (
      await command(b, async (tx) => ({
        value: await verifySubjectErasureSourcePage(tx, b, { ...result.receipt }),
        events: events(b),
      }))
    ).value,
  ).toBe(false);
  expect(
    (
      await command(b, async (tx) => ({
        value: await verifySubjectErasureSourceProof(tx, b, { ...result.proof }),
        events: events(b),
      }))
    ).value,
  ).toBe(false);
}, 360_000);

test('equal-delivery original and native origins traverse into distinct held Source pages and survive sealed replay', async () => {
  for (const nativeFirst of [false, true]) {
    const author = await f.author();
    const id = await subject(author, 'Distinct native provenance');
    const partition = partitionOf(routeOf(id)!);
    const revision = (
      await f.db.admin.query<{
        key: string;
        transaction_id: string;
        position: string;
      }>(
        `SELECT r.erasure_key::text AS key,r.recorded_transaction_id::text AS transaction_id,b.position::text
        FROM semantic.revision r JOIN editorial.write_basis b
          ON b.partition_no=$1 AND b.transaction_id=r.recorded_transaction_id
        WHERE r.route=$2 AND r.subject_id=$3 AND r.revision=1`,
        [partition, routeOf(id), id],
      )
    ).rows[0]!;
    const actor = await f.native.access.authenticate(author.bearer, { pool: f.db.pool, deadline: Date.now() + 5000 });
    const captured = await runCommand(
      f.db.pool,
      {
        partition,
        basis: {
          actorAccountId: actor.accountId,
          clientId: actor.clientId,
          requestedBy: actor.requestedBy,
        },
      },
      async (tx) => {
        const native = currentCommand(tx).transactionId;
        await recordSemanticSourceCommit(tx, native);
        const position = (
          await tx.query<{ position: string }>(
            'SELECT position::text FROM semantic.erasure_source_commit WHERE partition_no=$1 AND transaction_id=$2',
            [partition, native],
          )
        ).rows[0]!.position;
        const origins = [
          { transaction_id: revision.transaction_id, position: revision.position },
          { transaction_id: native, position },
        ];
        for (const origin of nativeFirst ? [...origins].reverse() : origins)
          await tx.query("SELECT semantic.record_erasure_locator($1,$2,'actor','revision',$3,$4,$5)", [
            partition,
            author.accountId,
            revision.key,
            origin.transaction_id,
            origin.position,
          ]);
        return { value: origins, events: searchIdentityWriterChanged() };
      },
    );
    const expected = captured.value.map((origin) => `${origin.transaction_id}/${origin.position}`).sort();
    const nativeRows = (
      await f.db.admin.query<{ origin_key: string }>(
        `SELECT origin_key FROM semantic.erasure_source_record WHERE partition_no=$1 AND account_id=$2
        AND store='revision' AND record_key=$3 AND role='actor' AND delivery_position=$4 ORDER BY origin_key`,
        [partition, author.accountId, revision.key, captured.position.toString()],
      )
    ).rows;
    expect(nativeRows.map((row) => row.origin_key)).toEqual(expected);
    await f.tombstone(author);
    const b = await barrier(author.accountId);
    await local(b);
    const result = await complete(b);
    const prefix = `${partition}:revision:${revision.key}:actor:${captured.position}:`;
    expect(
      result.records
        .filter((record) => record.key.startsWith(prefix))
        .map((record) => record.key.slice(prefix.length))
        .sort(),
    ).toEqual(expected);
    const holds = (
      await f.db.admin.query<{ origin_key: string }>(
        `SELECT DISTINCT h.origin_key FROM semantic.erasure_source_hold h
        JOIN semantic.erasure_source_commit c USING(partition_no,transaction_id)
        WHERE h.partition_no=$1 AND h.account_id=$2 AND h.store='revision' AND h.record_key=$3
          AND h.role='actor' AND h.delivery_position=$4 ORDER BY h.origin_key`,
        [partition, author.accountId, revision.key, captured.position.toString()],
      )
    ).rows;
    expect(holds.map((row) => row.origin_key)).toEqual(expected);
    for (const origin of captured.value) {
      expect(
        (
          await f.db.admin.query(
            `SELECT 1 FROM semantic.erasure_shared_custody WHERE partition_no=$1 AND account_id=$2
          AND role='actor' AND transaction_id=$3 AND outbox_position=$4`,
            [partition, author.accountId, origin.transaction_id, origin.position],
          )
        ).rowCount,
      ).toBe(1);
      // Replay identifies the stored origin even when the physical queue most
      // recently carried the other transaction. No current actor/body is borrowed.
      const replay = await runCommand(
        f.db.pool,
        {
          partition,
          basis: {
            actorAccountId: '00000000-0000-8000-8000-000000000001',
            clientId: 'native-origin-replay',
            requestedBy: null,
          },
        },
        async (tx) => {
          await tx.query("SELECT semantic.record_erasure_locator($1,$2,'actor','revision',$3,$4,$5)", [
            partition,
            author.accountId,
            revision.key,
            origin.transaction_id,
            origin.position,
          ]);
          return noEffect(true);
        },
      );
      expect(replay.value).toBe(true);
      await expect(
        runCommand(
          f.db.pool,
          {
            partition,
            basis: {
              actorAccountId: '00000000-0000-8000-8000-000000000001',
              clientId: 'native-origin-wrong-position',
              requestedBy: null,
            },
          },
          async (tx) => {
            await tx.query("SELECT semantic.record_erasure_locator($1,$2,'actor','revision',$3,$4,$5)", [
              partition,
              author.accountId,
              revision.key,
              origin.transaction_id,
              (BigInt(origin.position) + 1n).toString(),
            ]);
            return noEffect(true);
          },
        ),
      ).rejects.toMatchObject({ code: '23514' });
    }
    let refusedTransaction: string | undefined;
    await expect(
      runCommand(
        f.db.pool,
        {
          partition,
          basis: {
            actorAccountId: '00000000-0000-8000-8000-000000000001',
            clientId: 'native-origin-refusal',
            requestedBy: null,
          },
        },
        async (tx) => {
          const transactionId = currentCommand(tx).transactionId;
          refusedTransaction = transactionId;
          await recordSemanticSourceCommit(tx, transactionId);
          const native = (
            await tx.query<{ position: string }>(
              'SELECT position::text FROM semantic.erasure_source_commit WHERE partition_no=$1 AND transaction_id=$2',
              [partition, transactionId],
            )
          ).rows[0]!;
          await tx.query("SELECT semantic.record_erasure_locator($1,$2,'actor','revision',$3,$4,$5)", [
            partition,
            author.accountId,
            revision.key,
            transactionId,
            native.position,
          ]);
          return { value: true, events: searchIdentityWriterChanged() };
        },
      ),
    ).rejects.toMatchObject({ code: '23514' });
    expect(refusedTransaction).toBeDefined();
    expect(
      (
        await f.db.admin.query(
          'SELECT 1 FROM semantic.erasure_source_commit WHERE partition_no=$1 AND transaction_id=$2',
          [partition, refusedTransaction],
        )
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.db.admin.query('SELECT 1 FROM editorial.write_basis WHERE partition_no=$1 AND transaction_id=$2', [
          partition,
          refusedTransaction,
        ])
      ).rowCount,
    ).toBe(0);
    expect(
      (
        await f.db.admin.query<{ origin_key: string }>(
          `SELECT origin_key FROM semantic.erasure_source_record WHERE partition_no=$1 AND account_id=$2
        AND store='revision' AND record_key=$3 AND role='actor' AND delivery_position=$4 ORDER BY origin_key`,
          [partition, author.accountId, revision.key, captured.position.toString()],
        )
      ).rows,
    ).toEqual(nativeRows);
  }
}, 720_000);

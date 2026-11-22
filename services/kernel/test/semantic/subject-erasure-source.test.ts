import { afterAll, beforeAll, expect, test } from 'bun:test';
import { currentCommand, noEffect, runCommand } from '../../src/command/command.ts';
import { enrollRevisionErasureSource, recordSemanticSourceCommit } from '../../src/semantic/erasure-producer.ts';
import { acknowledgeSearchErasure } from '../../src/search/erasure.ts';
import { searchIdentityWriterChanged } from '../../src/search/identity-epoch-participant-events.ts';
import type { HistoryBarrier } from '../../src/history/contract/registry.ts';
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
import { synchronizeAccountAgent } from '../../src/access/account-agent-effect.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { testRouteKey } from '../support/test-kernel.ts';
import '../support/native-history-composition.ts';
import { accountErasureFixture, type AccountErasureFixture } from './support/account-erasure-fixture.ts';
import { accountErasureWorker } from './support/account-erasure-worker.ts';

let f: AccountErasureFixture;
let worker: Awaited<ReturnType<typeof accountErasureWorker>>;
beforeAll(async () => {
  f = await accountErasureFixture();
  worker = await accountErasureWorker(f.db.url);
}, 360_000);
afterAll(async () => {
  try {
    await worker?.stop();
  } finally {
    await f?.close();
  }
}, 360_000);

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
  const end = Date.now() + 360_000;
  while ((await readSemanticErasure(f.db.pool, b.accountId))?.state !== 'pending-shared-custody') {
    if (Date.now() >= end) throw new Error('Actual default local erasure did not complete');
    await Bun.sleep(20);
  }
}
async function complete(
  b: HistoryBarrier,
  replayKeyPrefix?: string,
  afterConsume?: (frontier: string, records: readonly SubjectErasureSourceRecord[]) => Promise<void>,
) {
  const records: SubjectErasureSourceRecord[] = [];
  let frontier: string | null = null;
  let proof: SubjectErasureSourceProof | null = null;
  let receipt: SubjectErasurePageReceipt | undefined;
  let pages = 0;
  let lastReceiptAt = Date.now();
  const end = Date.now() + 600_000;
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
      if (Date.now() - lastReceiptAt > 30_000)
        throw new Error(
          `Native Source frontier stalled after ${pages} receipts at ${frontier}: ${JSON.stringify(page)}`,
        );
      await Bun.sleep(10);
      continue;
    }
    receipt = { ...page.receipt };
    if (replayKeyPrefix && page.records.some((record) => record.key.startsWith(replayKeyPrefix))) {
      // Lose the response before consumption, then resume from the same incoming frontier.
      const replay = await createSubjectErasureSource(config()).readPage({
        barrier: b,
        frontier,
        inputLimit: 100,
        context: context(),
      });
      if (!('receipt' in replay)) throw new Error('Expected the retained native Source receipt');
      expect(replay.receipt).toEqual(page.receipt);
      expect(replay.records).toEqual(page.records);
      receipt = { ...replay.receipt };
    }
    const accepted = await command(b, async (tx) => ({
      value: await verifySubjectErasureSourcePage(tx, b, receipt!),
      events: events(b),
    }));
    expect(accepted.value).toBe(true);
    records.push(...page.records);
    pages++;
    if (page.status === 'complete') {
      const unheld = await f.db.admin.query(
        `SELECT d.partition_no,d.store,d.record_key::text,d.role,d.delivery_position::text,d.origin_key
         FROM semantic.erasure_source_record d WHERE d.account_id=$1 AND NOT EXISTS (
           SELECT 1 FROM semantic.erasure_source_hold h WHERE h.account_id=d.account_id
             AND h.version=$2 AND h.at=$3::timestamptz AND h.partition_no=d.partition_no
             AND (h.store,h.record_key,h.role,h.delivery_position,h.origin_key)
               =(d.store,d.record_key,d.role,d.delivery_position,d.origin_key)
         ) LIMIT 1`,
        [b.accountId, b.version, b.at],
      );
      expect(unheld.rows).toEqual([]);
      break;
    }
    expect(Buffer.byteLength(page.frontier)).toBeLessThanOrEqual(2048);
    frontier = page.frontier;
    if (afterConsume && page.records.length) await afterConsume(frontier, page.records);
  }
  while (!proof) {
    if (Date.now() >= end) throw new Error('Independent native Source terminal proof did not complete');
    proof = await readSubjectErasureSourceProof({ pool: f.db.pool }, b, context());
    if (!proof) await Bun.sleep(10);
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
async function mergeMapped(
  moderator: Awaited<ReturnType<AccountErasureFixture['author']>>,
  left: string,
  right: string,
) {
  const merged = await f.call(moderator, 'POST', '/v1/subjects:merge', { subjects: [left, right] });
  expect(merged.status, JSON.stringify(merged.body)).toBe(202);
  const operationId = merged.body.operation.id as string;
  expect(typeof operationId).toBe('string');
  const [terminal, original] = [left, right].sort() as [string, string];
  const end = Date.now() + 180_000;
  for (;;) {
    const observed = await f.call(moderator, 'GET', `/v1/subjectIdentityOperations/${operationId}`);
    if (observed.status === 200 && observed.body.operation?.done === true) {
      expect(observed.body.operation.result.redirected).toBe(original);
      expect(observed.body.operation.result.survivor).toBe(terminal);
      return { original, terminal };
    }
    if (Date.now() >= end) throw new Error('Mapped original identity publication did not complete');
    await Bun.sleep(20);
  }
}

test('a new Book and its replay retain each native record role and just one original write basis', async () => {
  const actor = await f.person();
  await f.grant(GLOBAL_CONTEXT, actor, ['subject:create']);
  const stores = [
    'fact',
    'identity_epoch_home_gate',
    'identity_epoch_mapping',
    'record_source_set',
    'record_source_set_member',
    'revision',
    'subject',
  ];
  const expected = [
    ...stores.flatMap((store) => ['actor', 'operator'].map((role) => `${store}/${role}`)),
    'write_basis/actor',
  ].sort();
  const revisionRoles = () =>
    f.db.admin.query(
      "SELECT record_key FROM semantic.erasure_locator WHERE account_id=$1 AND role='operator' AND store='revision'",
      [actor.accountId],
    );
  expect((await revisionRoles()).rows).toHaveLength(0);
  for (const label of ['First native Book', 'Second native Book']) {
    const body = { type: 'schema:Book', labels: { en: label } };
    const headers = { 'idempotency-key': JSON.stringify(crypto.randomUUID()) };
    const created = await f.call(actor, 'POST', '/v1/subjects', body, headers);
    expect(created.status, JSON.stringify(created.body)).toBe(201);
    const id = created.body.subject.id as string;
    expect(created.headers.get('location')).toBe(`/v1/subjects/${id}`);
    const inventory = () =>
      f.db.admin.query<{ record: string; inventory: boolean }>(
        `SELECT l.store || '/' || l.role AS record, EXISTS (
         SELECT FROM semantic.erasure_source_record o
         WHERE (o.partition_no,o.account_id,o.role,o.store,o.record_key,o.source_transaction_id,
                o.source_position,o.delivery_position)
             = (l.partition_no,l.account_id,l.role,l.store,l.record_key,l.source_transaction_id,
                l.source_position,l.delivery_position)
       ) AS inventory
       FROM semantic.subject s JOIN editorial.write_basis b
         ON b.partition_no=s.route/16 AND b.transaction_id=s.recorded_transaction_id
       JOIN semantic.erasure_locator l ON l.partition_no=b.partition_no AND l.source_transaction_id=b.transaction_id
         AND l.account_id=$3 AND l.source_position=b.position AND l.delivery_position=b.position
       WHERE s.route=$1 AND s.subject_id=$2 AND l.store=ANY($4) ORDER BY (l.store || '/' || l.role) COLLATE "C"`,
        [routeOf(id)!, id, actor.accountId, [...stores, 'write_basis']],
      );
    const original = await inventory();
    expect(original.rows).toEqual(expected.map((record) => ({ record, inventory: true })));
    const replay = await f.call(actor, 'POST', '/v1/subjects', body, headers);
    expect(replay.status).toBe(201);
    expect(replay.body.subject).toEqual(created.body.subject);
    expect((await inventory()).rows).toEqual(original.rows);

    const route = routeOf(id)!;
    const partition = partitionOf(route);
    const aborted = new Error('Rollback after checking stale revision enrollment');
    await expect(
      runCommand(
        f.db.pool,
        {
          partition,
          basis: { actorAccountId: actor.accountId, clientId: 'native-revision-source-test', requestedBy: null },
        },
        async (tx, { transactionId }) => {
          expect(await enrollRevisionErasureSource(tx, route, id, 1)).toBe(false);
          const result = await tx.query(
            `SELECT nullif(current_setting('semantic.erasure_native_transaction',true),'') IS NOT NULL AS origin,
                  EXISTS(SELECT FROM semantic.erasure_source_role WHERE partition_no=$1 AND transaction_id=$2) AS role,
                  EXISTS(SELECT FROM semantic.erasure_source_commit WHERE partition_no=$1 AND transaction_id=$2) AS fence`,
            [partition, transactionId],
          );
          expect(result.rows).toEqual([{ origin: false, role: false, fence: false }]);
          throw aborted;
        },
      ),
    ).rejects.toBe(aborted);
  }
  expect((await revisionRoles()).rows).toHaveLength(2);
}, 90_000);

test('repeated native Source capture keeps one write-basis row and reopens a completed home for pending work', async () => {
  const actor = await f.author();
  const id = await subject(actor, 'Repeated actor source');
  const route = routeOf(id)!;
  const home = partitionOf(route);
  const client = await f.db.pool.connect();
  try {
    await client.query('BEGIN');
    const revision = (
      await client.query<{ key: string; tx: string }>(
        'SELECT erasure_key::text AS key,recorded_transaction_id::text AS tx FROM semantic.revision WHERE route=$1 AND subject_id=$2 AND revision=1',
        [route, id],
      )
    ).rows[0]!;
    const stores = ['fact', 'identity_epoch_home_gate', 'identity_epoch_mapping', 'revision', 'subject'];
    const enrolled = await client.query<{ store: string; present: boolean }>(
      `SELECT store,bool_and(native_present) AS present FROM semantic.erasure_source_record
       WHERE partition_no=$1 AND account_id=$2 AND source_transaction_id=$3 AND store=ANY($4)
       GROUP BY store ORDER BY store`,
      [home, actor.accountId, revision.tx, stores],
    );
    expect(enrolled.rows).toEqual(stores.map((store) => ({ store, present: true })));
    const otherHome = (home + 1) % 4096;
    await client.query("SELECT semantic.record_erasure_locator($1,$2,'actor','revision',$3,$4,NULL)", [
      otherHome,
      actor.accountId,
      revision.key,
      revision.tx,
    ]);
    const misplaced = await client.query(
      `SELECT native_present FROM semantic.erasure_source_record
       WHERE partition_no=$1 AND account_id=$2 AND store='revision' AND record_key=$3 AND role='actor'`,
      [otherHome, actor.accountId, revision.key],
    );
    expect(misplaced.rows).toEqual([{ native_present: false }]);
    const capture = () =>
      client.query("SELECT semantic.capture_erasure_roles($1,'revision',$2,$3)", [home, revision.key, revision.tx]);
    const row = async () =>
      (
        await client.query<{ key: string; version: string }>(
          'SELECT record_key::text AS key,ctid::text AS version FROM semantic.erasure_provenance WHERE partition_no=$1 AND transaction_id=$2',
          [home, revision.tx],
        )
      ).rows[0]!;
    await capture();
    const owned = await row();
    expect(owned).toBeDefined();
    const pending = await client.query(
      "SELECT 1 FROM semantic.erasure_locator WHERE partition_no=$1 AND account_id=$2 AND role='actor' AND store='write_basis' AND record_key=$3 AND state='pending'",
      [home, actor.accountId, owned.key],
    );
    expect(pending.rowCount).toBe(1);
    await client.query(
      "INSERT INTO semantic.erasure_home(partition_no,account_id,at,state) VALUES($1,$2,now(),'complete')",
      [home, actor.accountId],
    );
    await capture();
    expect(await row()).toEqual(owned);
    expect(
      (
        await client.query('SELECT state FROM semantic.erasure_home WHERE partition_no=$1 AND account_id=$2', [
          home,
          actor.accountId,
        ])
      ).rows[0]?.state,
    ).toBe('local');
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
}, 60_000);

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
}, 720_000);

test('Original funded Subject erasure pages account for every mapping and command child and resume to independent all-home tombstone readback within declared bounds', async () => {
  const author = await f.author();
  const moderator = await f.author();
  await f.grant(GLOBAL_CONTEXT, moderator, ['subject:merge', 'moderation:hide']);
  const left = await subject(author, 'Mapped original A');
  const right = await subject(author, 'Mapped original B');
  const { original } = await mergeMapped(moderator, left, right);
  await f.tombstone(author);
  const b = await barrier(author.accountId);
  await local(b);
  const tight = await createSubjectErasureSource(config()).readPage({
    barrier: b,
    frontier: null,
    inputLimit: 4,
    context: context(),
  });
  expect(tight.cost.inputKeys).toBeLessThanOrEqual(4);
  expect(tight.status).toBe('pending');
  if (tight.status === 'pending') {
    expect(tight.error).toBe('keys');
    expect(tight.funding).toBe(4);
    expect(tight.count).toBeGreaterThan(tight.funding);
  }
  const result = await complete(b);
  expect(result.records.some((r) => r.original === original)).toBe(true);
  expect(result.records.every((r) => r.disposition !== 'pending')).toBe(true);
}, 720_000);

test('sealed empty native role homes advance before filters while a hidden original never borrows visible terminal disposition', async () => {
  const author = await f.author();
  const moderator = await f.author();
  await f.grant(GLOBAL_CONTEXT, moderator, ['subject:merge', 'moderation:hide']);
  const left = await subject(author, 'Original A');
  const right = await subject(author, 'Original B');
  const { original, terminal } = await mergeMapped(moderator, left, right);
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
}, 720_000);

test('changed native account custody rejects both serialized Source receipts and the independent terminal proof', async () => {
  const person = await f.person();
  await f.tombstone(person);
  const b = await barrier(person.accountId);
  await local(b);
  const result = await complete(b);
  const verifyReceivedTerminal = async () =>
    (
      await command(b, async (tx) => ({
        value: await verifySubjectErasureSourceProof(tx, b, result.proof, result.receipt.id),
        events: events(b),
      }))
    ).value;
  expect(await verifyReceivedTerminal()).toBe(true);

  // A previous binary persisted this receipt without a numeric traversal binding.
  const removeBinding = (id: string) =>
    f.db.admin.query(
      'UPDATE semantic.erasure_source_page SET numeric_cursor_id=NULL WHERE route=$1 AND account_id=$2 AND id=$3',
      [b.accountRoute, b.accountId, id],
    );
  expect((await removeBinding(result.receipt.id)).rowCount).toBe(1);
  expect(await verifyReceivedTerminal()).toBe(false);
  // A retained Search completion header can still name the consumed pre-upgrade page.
  await f.db.admin.query(
    `UPDATE search.erasure_progress SET phase='done',source_complete=true,personal_complete=true,frontier=$3
     WHERE (partition_no,account_id)=($1,$2)`,
    [partitionOf(b.accountRoute), b.accountId, result.receipt.id],
  );
  await expect(acknowledgeSearchErasure(f.db.pool, b.accountId, context())).rejects.toThrow(
    'Search erasure Source proof changed',
  );
  expect(
    (
      await f.db.admin.query(
        "SELECT 1 FROM access.erasure_acknowledgement WHERE route=$1 AND account_id=$2 AND participant='search'",
        [b.accountRoute, b.accountId],
      )
    ).rows,
  ).toEqual([]);
  const readAfterTerminal = () =>
    createSubjectErasureSource(config()).readPage({
      barrier: b,
      frontier: result.receipt.id,
      inputLimit: 100,
      context: context(),
    });
  const first = await readAfterTerminal();
  expect(first.status).toBe('progress');
  if (first.status !== 'progress') throw new Error('Expected a new numeric traversal from the retained terminal');
  const original = (
    await f.db.admin.query(
      'SELECT source_partition,previous_id::text,numeric_cursor_id=id AS bound,consumed FROM semantic.erasure_source_page WHERE id=$1',
      [first.receipt.id],
    )
  ).rows[0];
  expect(original).toEqual({ source_partition: 0, previous_id: result.receipt.id, bound: true, consumed: false });

  // Replaying an unconsumed receipt must preserve its ID even across a binary downgrade.
  expect((await removeBinding(first.receipt.id)).rowCount).toBe(1);
  const replay = await readAfterTerminal();
  expect(replay).toMatchObject({ status: 'progress', receipt: first.receipt, frontier: first.frontier });
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
}, 720_000);

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
          { transaction_id: revision.transaction_id, position },
          { transaction_id: native, position },
        ];
        const locatorUpdates = async () =>
          (
            await tx.query<{ count: string }>(
              "SELECT pg_stat_get_xact_tuples_updated('semantic.erasure_locator'::regclass)::text AS count",
            )
          ).rows[0]!.count;
        for (const origin of nativeFirst ? [...origins].reverse() : origins) {
          const report = () =>
            tx.query("SELECT semantic.record_erasure_locator($1,$2,'actor','revision',$3,$4,$5)", [
              partition,
              author.accountId,
              revision.key,
              origin.transaction_id,
              origin.position,
            ]);
          await report();
          const before = await locatorUpdates();
          await report();
          expect(await locatorUpdates()).toBe(before);
        }
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
    const prefix = `${partition}:revision:${revision.key}:actor:${captured.position}:`;
    const result = await complete(b, prefix);
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

test('account agent Subject roles retain the source transaction position across account tombstoning', async () => {
  const author = await f.author();
  await f.tombstone(author);
  await synchronizeAccountAgent(f.db.pool, author.accountId);
  const roles = await f.db.admin.query(
    `SELECT r.delivery_position::text,r.source_position::text,r.origin_key,r.native_present,
      r.source_transaction_id::text,b.position::text AS basis,c.position::text AS committed
     FROM semantic.erasure_source_record r
     LEFT JOIN editorial.write_basis b ON (b.partition_no,b.transaction_id)=(r.partition_no,r.source_transaction_id)
     LEFT JOIN semantic.erasure_source_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.source_transaction_id)
     WHERE r.account_id=$1 AND r.store='subject' AND r.role='subject' ORDER BY r.delivery_position`,
    [author.accountId],
  );
  expect(roles.rows.some((row) => row.delivery_position !== row.basis && row.basis !== null)).toBe(true);
  for (const row of roles.rows) expect(row.source_position).toBe(row.basis ?? row.committed);
}, 120_000);

test('a retained inherited Subject resumes at its pre-upgrade key with the original transaction receipt', async () => {
  const author = await f.author();
  const captureMigration = await Bun.file(
    new URL('../../db/semantic/migrations/20261120233000_erasure_original_role_position.sql', import.meta.url),
  ).text();
  const [up, down] = captureMigration.split('-- migrate:down');
  await f.db.admin.query(down!);
  try {
    await f.tombstone(author);
    await synchronizeAccountAgent(f.db.pool, author.accountId);
  } finally {
    await f.db.admin.query(up!);
  }
  const {
    rows: [origin],
  } = await f.db.admin.query<{
    partition_no: number;
    record_key: string;
    delivery_position: string;
    transaction_id: string;
    origin_key: string;
    position: string;
  }>(
    `SELECT r.partition_no,r.record_key,r.delivery_position,r.source_transaction_id AS transaction_id,r.origin_key,b.position
     FROM semantic.erasure_source_record r JOIN editorial.write_basis b
       ON (b.partition_no,b.transaction_id)=(r.partition_no,r.source_transaction_id)
     WHERE r.account_id=$1 AND r.store='subject' AND r.role='subject'
       AND r.source_position=r.delivery_position AND b.position<r.source_position`,
    [author.accountId],
  );
  if (!origin) throw new Error('Expected the retained pre-upgrade Subject delivery');
  const prefix = `${origin.partition_no}:subject:${origin.record_key}:subject:`;
  const retainedKey = `${prefix}${origin.delivery_position}:${origin.origin_key}`;
  const firstKey = `${prefix}${origin.position}:${origin.transaction_id}/${origin.position}`;
  const b = await barrier(author.accountId);
  await local(b);
  const identity = [origin.partition_no, author.accountId, origin.transaction_id];
  const exact = "partition_no=$1 AND account_id=$2 AND role='subject' AND transaction_id=$3";
  let exercised = false;
  const result = await complete(b, retainedKey, async (frontier, records) => {
    if (!records.some((r) => r.key === firstKey)) return;
    // The preceding delivery has been consumed. Neither a wrong nor a lost obligation may transfer the next one.
    for (const fault of [
      `UPDATE semantic.erasure_shared_custody SET outbox_position=$4 WHERE ${exact}`,
      `DELETE FROM semantic.erasure_shared_custody WHERE ${exact}`,
    ]) {
      const args = fault.startsWith('UPDATE') ? [...identity, origin.delivery_position] : identity;
      expect((await f.db.admin.query(fault, args)).rowCount).toBe(1);
      const pending = await createSubjectErasureSource(config()).readPage({
        barrier: b,
        frontier,
        inputLimit: 100,
        context: context(),
      });
      expect(pending.status).toBe('pending');
      expect(
        (await f.db.admin.query(`SELECT outbox_position FROM semantic.erasure_shared_custody WHERE ${exact}`, identity))
          .rows,
      ).toEqual([{ outbox_position: origin.position }]);
      expect(
        (
          await f.db.admin.query(
            'SELECT id,consumed FROM semantic.erasure_source_page WHERE route=$1 AND account_id=$2',
            [b.accountRoute, b.accountId],
          )
        ).rows,
      ).toEqual([{ id: frontier, consumed: true }]);
    }
    exercised = true;
  });
  expect(exercised).toBe(true);
  expect(result.records.filter((r) => r.key === retainedKey)).toHaveLength(1);
}, 720_000);

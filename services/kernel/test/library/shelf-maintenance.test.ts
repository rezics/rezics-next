import { afterAll, beforeAll, expect, test } from 'bun:test';
import {
  createShelfMaintenanceOps,
  type ShelfMaintenanceBinding,
} from '../../src/library/shelf-maintenance-ops-contract.ts';
import { createLibraryCommandRunner } from '../../src/library/command-support.ts';
import { noEffect } from '../../src/command/command.ts';
import { partitionOf, routeOf } from '../../src/route/route.ts';
import { readErasureStatus } from '../../src/access/erasure.ts';
import { createOwnedErasureFixture } from './support/erasure-worker.ts';
import { deletePersona } from '../support/account-deletion.ts';
import { observePreparationSource, observePreparationIdentity } from '../../src/library/preparation-source.ts';
import advance from '../../src/library/shelf-maintenance-advance.sql';
import type { PoolClient } from 'pg';
import type { CloudEvent } from '../../src/events/log.ts';

let f: Awaited<ReturnType<typeof createOwnedErasureFixture>>;
beforeAll(async () => {
  f = await createOwnedErasureFixture();
}, 360000);
afterAll(async () => {
  await f?.close();
});
const owner = (accountId: string) => ({ route: routeOf(accountId)!, accountId });
const actor = (person: { bearer: string }) =>
  f.kernel.testAccess.authenticate(person.bearer, { pool: f.db.pool, deadline: Date.now() + 5000 });
const ops = () => createShelfMaintenanceOps({ pool: f.db.pool, access: f.kernel.testAccess, client: f.client });
async function finish(binding: ShelfMaintenanceBinding) {
  for (let n = 0; n < 100; n++) {
    const receipt = await ops().page(binding);
    if (receipt.terminal) return receipt;
    expect(receipt.next).not.toBeNull();
    binding = receipt.next!;
  }
  throw new Error('Quiescent empty native shelf did not finish');
}

test('default native empty owner initializes, drains, fences a late writer and atomically publishes with exact Core replay', async () => {
  const person = f.people.alice,
    as = await actor(person),
    account = owner(person.accountId);
  const runner = createLibraryCommandRunner({ pool: f.db.pool });
  const initialized = await runner.ownAccount(
    as,
    { action: 'library_entry:update', kind: 'library.shelf.init.probe', requestKey: crypto.randomUUID(), input: {} },
    async (tx) => noEffect(await ops().initialize(tx, account)),
  );
  expect(initialized.value).toMatchObject({
    readiness: 'ready',
    generationId: '00000000-0000-0000-0000-000000000000',
    requested: null,
  });
  const request = {
    owner: { ...account },
    kind: 'backfill' as 'backfill' | 'counters',
    requestKey: crypto.randomUUID(),
  };
  const requesting = ops().requestRebuild(as, request);
  // Authorization yields before the native body. Its receipt must retain the
  // original request even if the caller reuses its input container meanwhile.
  request.kind = 'counters';
  request.owner.accountId = f.people.bob.accountId;
  const requested = await requesting;
  expect(
    (await f.db.admin.query('SELECT kind FROM library.shelf_maintenance_run WHERE run_id=$1', [requested.runId]))
      .rows[0].kind,
  ).toBe('backfill');
  const recovered = await ops().recover({ after: null, limit: 100 });
  expect(recovered.enqueued.some((binding) => binding.runId === requested.runId)).toBe(true);
  expect((await f.client.getWorkflow(`shelf:${account.accountId}:${requested.runId}:0:0:0:0`))?.workflowName).toBe(
    'library.shelfMaintenance',
  );
  // An uncommitted future locator has neither a durable header nor receipt authority.
  await expect(ops().page({ ...requested, sequence: '1' })).rejects.toThrow();
  const drained = await ops().page(requested);
  expect(await ops().page(requested)).toEqual(drained);
  expect(drained.next?.epoch).toBe('1');
  await expect(
    runner.ownAccount(
      as,
      { action: 'library_entry:update', kind: 'library.shelf.late.probe', requestKey: crypto.randomUUID(), input: {} },
      async () => noEffect(null),
    ),
  ).rejects.toThrow();
  const terminal = await finish(drained.next!);
  expect(terminal.terminal).toBe(true);
  expect(await ops().requestRebuild(as, { ...request, owner: account, kind: 'backfill' })).toEqual(requested);
  expect(await ops().page(requested)).toEqual(drained);
  const gate = (
    await f.db.admin.query(
      'SELECT mode,ready,active_generation FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2',
      [account.route, account.accountId],
    )
  ).rows[0];
  expect(gate).toMatchObject({ mode: 'open', ready: true });
  expect(gate.active_generation).not.toBe('00000000-0000-0000-0000-000000000000');
  const next = await ops().requestRebuild(as, { owner: account, kind: 'counters', requestKey: crypto.randomUUID() });
  await expect(ops().page(drained.next!)).rejects.toThrow();
  let interrupted = next;
  for (;;) {
    const step = await ops().page(interrupted);
    interrupted = step.next!;
    if (step.phase === 'count-collections') break;
  }
  const native = (
    await f.db.admin.query(
      'SELECT build_generation,sequence::text FROM library.shelf_maintenance_run WHERE run_id=$1',
      [next.runId],
    )
  ).rows[0];
  // The empty count-collections aggregate still INSERTs a real zero counter. Fail the later
  // checkpoint CAS so rollback must remove useful work as well as preserve the exact header.
  const clients = new Map<PoolClient, PoolClient['query']>();
  let failed = false;
  const interrupt = (client: PoolClient) => {
    if (clients.has(client)) return;
    const query = client.query;
    clients.set(client, query);
    client.query = new Proxy(query, {
      apply(target, receiver, args) {
        const sql = typeof args[0] === 'string' ? args[0] : args[0].text;
        if (!failed && sql === advance.sql) {
          failed = true;
          return Promise.reject(new Error('interrupt after native counter insert'));
        }
        return Reflect.apply(target, receiver, args);
      },
    });
  };
  f.db.pool.on('acquire', interrupt);
  try {
    await expect(ops().page(interrupted)).rejects.toThrow('interrupt after native counter insert');
  } finally {
    f.db.pool.off('acquire', interrupt);
    for (const [client, query] of clients) client.query = query;
  }
  expect(failed).toBe(true);
  expect(
    (await f.db.admin.query('SELECT sequence::text FROM library.shelf_maintenance_run WHERE run_id=$1', [next.runId]))
      .rows[0].sequence,
  ).toBe(native.sequence);
  expect(
    (
      await f.db.admin.query(
        'SELECT n::text FROM library.shelf_count WHERE route=$1 AND account_id=$2 AND generation_id=$3',
        [account.route, account.accountId, native.build_generation],
      )
    ).rows,
  ).toEqual([]);
  const retried = await ops().page(interrupted);
  expect(retried.phase).toBe('validate');
  expect(await ops().page(interrupted)).toEqual(retried);
  await finish(retried.next!);
  expect(
    (
      await f.db.admin.query(
        `SELECT NOT EXISTS (SELECT 1 FROM library.shelf_count c
       WHERE c.route=g.route AND c.account_id=g.account_id AND c.generation_id<>g.active_generation) AS retired,
       NOT EXISTS (SELECT 1 FROM library.shelf_type_reservation r
       WHERE r.route=g.route AND r.account_id=g.account_id) AS reservations_retired
     FROM library.shelf_maintenance g WHERE g.route=$1 AND g.account_id=$2`,
        [account.route, account.accountId],
      )
    ).rows[0],
  ).toEqual({ retired: true, reservations_retired: true });
}, 30000);

test('source change before type work preserves the native boundary and advanced replay has no fresh source dependency', async () => {
  const person = f.people.alice,
    as = await actor(person),
    account = owner(person.accountId);
  const subjectId = await f.subject();
  await f.json(person, 'PUT', `/v1/libraryEntries/${subjectId}`, 201, { state: 'planned' });
  let binding = await ops().requestRebuild(as, { owner: account, kind: 'backfill', requestKey: crypto.randomUUID() });
  for (;;) {
    const step = await ops().page(binding);
    binding = step.next!;
    if (step.phase === 'types') break;
  }
  const read = async () =>
    (
      await f.db.admin.query(
        `SELECT type_id,type_source_id,type_source_epoch,type_source_position,transaction_id FROM library.entry
     WHERE route=$1 AND account_id=$2 AND subject_id=$3`,
        [account.route, account.accountId, subjectId],
      )
    ).rows[0];
  const before = await read();
  let changed = false;
  const changing = createShelfMaintenanceOps({
    pool: f.db.pool,
    access: f.kernel.testAccess,
    client: f.client,
    sources: {
      async observe(id) {
        const source = await observePreparationSource({ pool: f.db.pool }, id);
        if (!changed) {
          changed = true;
          // The original source RR is released before a real external source command changes visibility.
          await f.json(f.people.staff, 'POST', `/v1/subjects/${subjectId}:hide`, 200, {
            reason: 'Interrupted rebuild source',
          });
        }
        return source;
      },
      observeIdentity: (id) => observePreparationIdentity({ pool: f.db.pool }, id),
    },
  });
  await expect(changing.page(binding)).rejects.toThrow();
  expect(changed).toBe(true);
  expect(await read()).toEqual(before);
  const pending = (
    await f.db.admin.query('SELECT sequence::text FROM library.shelf_maintenance_run WHERE run_id=$1', [binding.runId])
  ).rows[0];
  expect(pending.sequence).toBe(binding.sequence);
  expect(
    (
      await f.db.admin.query('SELECT ready FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2', [
        account.route,
        account.accountId,
      ])
    ).rows[0].ready,
  ).toBe(false);
  await f.json(f.people.staff, 'POST', `/v1/subjects/${subjectId}:restore`, 200, {
    reason: 'Resume exact rebuild source',
  });
  const retried = await ops().page(binding);
  await finish(retried.next!);
  const replayOnly = createShelfMaintenanceOps({
    pool: f.db.pool,
    access: f.kernel.testAccess,
    client: f.client,
    sources: {
      observe: async () => {
        throw new Error('advanced header must not prepare another source');
      },
      observeIdentity: async () => {
        throw new Error('advanced header must not observe another source');
      },
    },
  });
  expect(await replayOnly.page(binding)).toEqual(retried);
}, 60000);

test('terminal native tombstone rejects fabricated envelopes and late writers; private completion leaves shared erasure pending', async () => {
  const person = f.people.bob,
    as = await actor(person),
    account = owner(person.accountId);
  await deletePersona(f.options, person);
  const row = (
    await f.db.admin.query(
      "SELECT id,epoch,position::text,data,to_char(recorded_at AT TIME ZONE 'UTC','YYYY-MM-DD\"T\"HH24:MI:SS.US\"Z\"') AS time FROM core.outbox WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.access.account-tombstoned.v1' ORDER BY position LIMIT 1",
      [partitionOf(account.route), account.accountId],
    )
  ).rows[0];
  const envelope: CloudEvent = {
    specversion: '1.0',
    id: row.id,
    source: `urn:rezics:log:${partitionOf(account.route)}.${row.epoch}`,
    type: 'com.rezics.access.account-tombstoned.v1',
    subject: account.accountId,
    time: row.time,
    datacontenttype: 'application/json',
    sequence: row.position.padStart(19, '0'),
    data: row.data,
  };
  await expect(ops().requestPurge({ ...envelope, id: crypto.randomUUID() })).rejects.toThrow();
  const requested = await ops().requestPurge(envelope);
  const terminal = await finish(requested);
  expect(terminal.sharedEvidence).toBe('separate-contract');
  expect(await ops().page(terminal.binding)).toEqual(terminal);
  await expect(
    ops().requestRebuild(as, { owner: account, kind: 'backfill', requestKey: crypto.randomUUID() }),
  ).rejects.toThrow();
  expect((await readErasureStatus(f.db.pool, account.accountId))?.state).toBe('pending');
  const recovered = await ops().recover({ after: null, limit: 100 });
  expect(recovered.enqueued.some((b) => b.runId === requested.runId)).toBe(false);
}, 30000);

test('counter-only rebuild serves the last complete generation while field backfill withholds until publication', async () => {
  const person = f.people.operator,
    as = await actor(person),
    account = owner(person.accountId);
  const runner = createLibraryCommandRunner({ pool: f.db.pool });
  await runner.ownAccount(
    as,
    { action: 'library_entry:update', kind: 'library.shelf.init.probe', requestKey: crypto.randomUUID(), input: {} },
    async (tx) => noEffect(await ops().initialize(tx, account)),
  );
  const published = await finish(
    await ops().requestRebuild(as, { owner: account, kind: 'backfill', requestKey: crypto.randomUUID() }),
  );
  expect(published.terminal).toBe(true);
  expect((await f.request(person, 'GET', '/v1/libraryShelfSummary')).status).toBe(200);
  const subjectId = await f.subject();
  const created = await f.json(person, 'POST', '/v1/libraryLabels', 201, { name: 'Published shelf' });
  const labelId = created.label.id as string;
  expect((await f.request(person, 'POST', `/v1/libraryLabels/${labelId}:assign`, { subjectId })).status).toBe(200);
  const assignmentsPath = `/v1/libraryLabelAssignments?labelId=${labelId}&view=FULL`;
  const full = await f.request(person, 'GET', assignmentsPath);
  expect(full.status).toBe(200);
  const fullPage = await full.json();
  expect(fullPage.label).toEqual({ id: labelId, name: 'Published shelf', revision: created.label.revision });
  expect(fullPage.assignments).toHaveLength(1);
  expect(fullPage.assignments[0]).toMatchObject({ subjectId, labelId });
  expect(fullPage.assignments[0]).toHaveProperty('subject');
  const generation = (
    await f.db.admin.query('SELECT active_generation FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2', [
      account.route,
      account.accountId,
    ])
  ).rows[0]!.active_generation;
  const counters = await ops().requestRebuild(as, {
    owner: account,
    kind: 'counters',
    requestKey: crypto.randomUUID(),
  });
  const counting = await ops().page(counters);
  expect(
    (
      await f.db.admin.query(
        'SELECT mode,ready,active_generation FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2',
        [account.route, account.accountId],
      )
    ).rows[0],
  ).toMatchObject({ mode: 'rebuilding', ready: true, active_generation: generation });
  const lastComplete = await f.request(person, 'GET', '/v1/libraryShelfSummary');
  expect(lastComplete.status).toBe(200);
  expect((await lastComplete.json()).tabs.all).toEqual({ total: 0, shown: 0 });
  expect((await f.request(person, 'GET', assignmentsPath)).status).toBe(200);
  const blocked = await f.request(person, 'POST', '/v1/libraryLabels', { name: 'During rebuild' });
  expect(blocked.status).toBe(503);
  expect(await blocked.json()).toMatchObject({ code: 'transaction_retry_exhausted' });
  if (!counting.terminal) await finish(counting.next!);
  const backfill = await ops().requestRebuild(as, {
    owner: account,
    kind: 'backfill',
    requestKey: crypto.randomUUID(),
  });
  const draining = await ops().page(backfill);
  expect(
    (
      await f.db.admin.query('SELECT mode,ready FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2', [
        account.route,
        account.accountId,
      ])
    ).rows[0],
  ).toMatchObject({ mode: 'rebuilding', ready: false });
  const withheld = await f.request(person, 'GET', '/v1/libraryShelfSummary');
  expect(withheld.status).toBe(503);
  expect(await withheld.json()).toMatchObject({ code: 'dependency_unavailable' });
  const withheldShelf = await f.request(person, 'GET', assignmentsPath);
  expect(withheldShelf.status).toBe(503);
  expect(await withheldShelf.json()).toMatchObject({ code: 'dependency_unavailable' });
  expect((await f.request(person, 'GET', '/v1/libraryLabels?limit=100')).status).toBe(200);
  const completed = draining.terminal ? draining : await finish(draining.next!);
  expect(completed.terminal).toBe(true);
  expect(
    (
      await f.db.admin.query('SELECT mode,ready FROM library.shelf_maintenance WHERE route=$1 AND account_id=$2', [
        account.route,
        account.accountId,
      ])
    ).rows[0],
  ).toMatchObject({ mode: 'open', ready: true });
  expect((await f.request(person, 'GET', '/v1/libraryShelfSummary')).status).toBe(200);
  const publishedFull = await f.request(person, 'GET', assignmentsPath);
  expect(publishedFull.status).toBe(200);
  expect((await publishedFull.json()).assignments).toHaveLength(1);
  const renamed = await f.json(person, 'PATCH', `/v1/libraryLabels/${labelId}`, 200, {
    name: 'After publication',
    revision: created.label.revision,
  });
  expect(renamed.label).toEqual({ id: labelId, revision: created.label.revision + 1 });
  const listed = await f.json(person, 'GET', '/v1/libraryLabels?limit=100', 200);
  expect(listed.labels.find((label: { id: string }) => label.id === labelId)).toEqual({
    id: labelId,
    name: 'After publication',
    revision: created.label.revision + 1,
  });
}, 30000);

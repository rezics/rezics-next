import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { routeOf } from '../../src/route/route.ts';
import { resolveSubject } from '../../src/library/subject-anchor.ts';
import {
  acquireIdentityEpochAdmissionHome,
  cancelIdentityEpochAdmission,
  stepIdentityEpochAdmission,
} from '../../src/semantic/identity-epoch-admission.ts';
import { stepIdentityEpochBootstrap } from '../../src/semantic/identity-epoch-bootstrap.ts';
import { identityEpochStore as store } from '../../src/semantic/identity-epoch-store.ts';
import acquire from '../../src/semantic/identity-epoch-admission-acquire.sql';
import exportEmpty from '../../src/semantic/identity-epoch-bootstrap-export-empty.sql';
import receiveEmpty from '../../src/semantic/identity-epoch-bootstrap-receive-empty.sql';
import ackEmpty from '../../src/semantic/identity-epoch-bootstrap-ack-empty.sql';
import { IDENTITY_EPOCH_PROGRESS } from '../../src/semantic/events.ts';
import type { IdentityAdmissionInput } from '../../src/semantic/identity-epoch-contract.ts';
import { digest, epochFixture, home, release, type EpochFixture } from './support/identity-epoch.ts';

let f: EpochFixture;
const role = `identity_home_${randomUUID().replaceAll('-', '')}`;
const policy = 'identity_native_home_witness';
const protectedTables: string[] = [];

beforeAll(async () => {
  f = await epochFixture();
  // A test-only non-owner role makes PostgreSQL enforce the policy inside nested
  // PL/pgSQL too. Merely tracing SELECT function(...) cannot establish isolation.
  await f.admin.query(`CREATE ROLE ${role} NOLOGIN NOSUPERUSER NOBYPASSRLS`);
  await f.admin.query(`GRANT USAGE ON SCHEMA semantic,core,editorial TO ${role}`);
  await f.admin.query(`GRANT SELECT,INSERT,UPDATE,DELETE ON ALL TABLES IN SCHEMA semantic,core TO ${role}`);
  // The shared native command fence includes the editorial basis INSERT even
  // for a maintenance command whose basis is null.
  await f.admin.query(`GRANT SELECT,INSERT ON editorial.write_basis TO ${role}`);
  const tables = (
    await f.admin.query<{ table_name: string; key: string }>(`
      SELECT c.relname table_name,
        CASE WHEN EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname='partition_no')
          THEN 'partition_no' ELSE 'route / 16' END key
      FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='semantic' AND c.relkind='r' AND c.relname LIKE 'identity_epoch_%'
        AND EXISTS(SELECT 1 FROM pg_attribute a WHERE a.attrelid=c.oid AND a.attname IN ('route','partition_no'))
      ORDER BY c.relname
    `)
  ).rows;
  for (const table of tables) {
    await f.admin.query(`ALTER TABLE semantic.${table.table_name} ENABLE ROW LEVEL SECURITY`);
    protectedTables.push(table.table_name);
    await f.admin.query(`CREATE POLICY ${policy} ON semantic.${table.table_name} TO ${role}
      USING (${table.key}=current_setting('identity_test.home')::integer)
      WITH CHECK (${table.key}=current_setting('identity_test.home')::integer)`);
  }
});

test('empty legacy homes retain three distinct native commits and reject source ACK before receiving custody under nested RLS', async () => {
  const partition = 0x6f7;
  const exported = await isolated(/export_identity_epoch_empty_bootstrap/, partition, () =>
    runCommand(f.pool, { partition }, async (tx, { transactionId }) => {
      expect((await tx.query(exportEmpty.sql, [partition, transactionId])).rows).toEqual([{ applied: true }]);
      expect(
        (await tx.query('SELECT * FROM semantic.identity_epoch_native_commit WHERE partition_no<>$1', [partition]))
          .rows,
      ).toEqual([]);
      return { value: null, events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition, generation: '1' } }] };
    }),
  );
  await expect(
    isolated(/ack_identity_epoch_empty_bootstrap/, partition, () =>
      runCommand(f.pool, { partition }, async (tx, { transactionId }) => {
        await tx.query(ackEmpty.sql, [
          partition,
          exported.transactionId,
          randomUUID(),
          exported.epoch,
          exported.position.toString(),
          transactionId,
        ]);
        return noEffect(null);
      }),
    ),
  ).rejects.toThrow('identity_epoch_bootstrap_custody_unavailable');
  expect(
    (
      await f.admin.query('SELECT acknowledged FROM semantic.identity_epoch_bootstrap_page WHERE partition_no=$1', [
        partition,
      ])
    ).rows,
  ).toEqual([{ acknowledged: false }]);
  const received = await isolated(/receive_identity_epoch_empty_bootstrap/, partition, () =>
    runCommand(f.pool, { partition }, async (tx, { transactionId }) => {
      expect(
        (
          await tx.query(receiveEmpty.sql, [
            partition,
            exported.transactionId,
            exported.epoch,
            exported.position.toString(),
            transactionId,
          ])
        ).rows,
      ).toEqual([{ applied: true }]);
      return { value: null, events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition, generation: '1' } }] };
    }),
  );
  const acknowledged = await isolated(/ack_identity_epoch_empty_bootstrap/, partition, () =>
    runCommand(f.pool, { partition }, async (tx, { transactionId }) => {
      expect(
        (
          await tx.query(ackEmpty.sql, [
            partition,
            exported.transactionId,
            received.transactionId,
            received.epoch,
            received.position.toString(),
            transactionId,
          ])
        ).rows,
      ).toEqual([{ applied: true, sealed: true }]);
      return { value: null, events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition, generation: '1' } }] };
    }),
  );
  expect(new Set([exported.transactionId, received.transactionId, acknowledged.transactionId]).size).toBe(3);
  expect([exported.position, received.position, acknowledged.position]).toEqual([1n, 2n, 3n]);
  const rows = (
    await f.admin.query(
      `
    SELECT page.transaction_id export,b.transaction_id receiving,h.sealed_transaction_id ack,page.acknowledged
    FROM semantic.identity_epoch_bootstrap_home h
    JOIN semantic.identity_epoch_bootstrap_page page USING(partition_no)
    JOIN semantic.identity_epoch_bootstrap_basis b ON b.partition_no=h.partition_no
      AND b.source_partition=h.partition_no AND b.source_generation=page.generation
      AND b.source_transaction_id=page.transaction_id
    JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id,c.epoch,c.position)=
      (h.partition_no,h.sealed_transaction_id,h.sealed_epoch,h.sealed_position)
    WHERE h.partition_no=$1 AND NOT h.needs_work AND h.sealed_generation=1 AND c.purpose='bootstrap'
  `,
      [partition],
    )
  ).rows;
  expect(rows).toEqual([
    {
      export: exported.transactionId,
      receiving: received.transactionId,
      ack: acknowledged.transactionId,
      acknowledged: true,
    },
  ]);
  const copies = (
    await f.admin.query(
      `
    SELECT 'home' relation,count(*)::integer copies,coalesce(sum(pg_column_size(t)),0)::text row_bytes
      FROM semantic.identity_epoch_bootstrap_home t WHERE partition_no=$1
    UNION ALL SELECT 'page',count(*)::integer,coalesce(sum(pg_column_size(t)),0)::text
      FROM semantic.identity_epoch_bootstrap_page t WHERE partition_no=$1
    UNION ALL SELECT 'custody',count(*)::integer,coalesce(sum(pg_column_size(t)),0)::text
      FROM semantic.identity_epoch_bootstrap_custody t WHERE partition_no=$1
    UNION ALL SELECT 'basis',count(*)::integer,coalesce(sum(pg_column_size(t)),0)::text
      FROM semantic.identity_epoch_bootstrap_basis t WHERE partition_no=$1
    UNION ALL SELECT 'native',count(*)::integer,coalesce(sum(pg_column_size(t)),0)::text
      FROM semantic.identity_epoch_native_commit t WHERE partition_no=$1
    UNION ALL SELECT 'outbox',count(*)::integer,coalesce(sum(pg_column_size(t)),0)::text
      FROM core.outbox t WHERE partition_no=$1
  `,
      [partition],
    )
  ).rows;
  expect(copies.map((row) => [row.relation, row.copies])).toEqual([
    ['home', 1],
    ['page', 1],
    ['custody', 1],
    ['basis', 1],
    ['native', 3],
    ['outbox', 3],
  ]);
  console.info('native empty-home retained copies', JSON.stringify({ partition, receipts: rows, copies }));
});

test('an interrupted empty export recovers its same retained page through the original native receiving and ACK path', async () => {
  const partition = 0x6f8;
  const exported = await isolated(/export_identity_epoch_empty_bootstrap/, partition, () =>
    runCommand(f.pool, { partition }, async (tx, { transactionId }) => {
      expect((await tx.query(exportEmpty.sql, [partition, transactionId])).rows).toEqual([{ applied: true }]);
      return { value: null, events: [{ type: IDENTITY_EPOCH_PROGRESS, data: { partition, generation: '1' } }] };
    }),
  );
  // Stop after the real export commit. No receiving row or source ACK is installed by setup.
  expect(
    (await f.admin.query('SELECT * FROM semantic.identity_epoch_bootstrap_basis WHERE partition_no=$1', [partition]))
      .rows,
  ).toEqual([]);
  const recovered = await isolated(/identity_epoch_bootstrap_(basis|page)/, partition, () =>
    stepIdentityEpochBootstrap(f.pool, partition),
  );
  expect(recovered.state).toBe('caught-up');
  expect(recovered.generation).toBe(1n);
  expect(recovered.native.transactionId).toBe(exported.transactionId);
  expect(
    (
      await f.admin.query(
        'SELECT generation,acknowledged FROM semantic.identity_epoch_bootstrap_page WHERE partition_no=$1',
        [partition],
      )
    ).rows,
  ).toEqual([{ generation: '1', acknowledged: true }]);
});

afterAll(async () => {
  if (!f) return;
  for (const table of protectedTables.reverse()) {
    await f.admin.query(`DROP POLICY IF EXISTS ${policy} ON semantic.${table}`);
    await f.admin.query(`ALTER TABLE semantic.${table} DISABLE ROW LEVEL SECURITY`);
  }
  await f.admin.query(`DROP OWNED BY ${role}`);
  await f.admin.query(`DROP ROLE ${role}`);
  await f.close();
});

/** Restrict only the chosen native command; released preparation reads retain
 * their own clients and snapshots. All nested SQL then sees only this home.
 */
async function isolated<T>(matches: RegExp, partition: number, operation: () => Promise<T>, required = true) {
  const originals = new Map<PoolClient, PoolClient['query']>();
  let invocations = 0;
  const acquired = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = async function (...args: unknown[]) {
      const statement = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      if (statement && matches.test(statement)) {
        await Reflect.apply(query, client, [`SET LOCAL ROLE ${role}`]);
        await Reflect.apply(query, client, ["SELECT set_config('identity_test.home',$1,true)", [String(partition)]]);
        invocations++;
      }
      return Reflect.apply(query, client, args);
    } as PoolClient['query'];
  };
  f.pool.on('acquire', acquired);
  try {
    return await operation();
  } finally {
    f.pool.off('acquire', acquired);
    for (const [client, query] of originals) client.query = query;
    if (required) expect(invocations, 'the witness must reach the actual SQL operation').toBeGreaterThan(0);
  }
}

async function authority() {
  const actor = await f.actor();
  return {
    basis: { actorAccountId: actor.accountId, clientId: actor.clientId, requestedBy: actor.requestedBy },
    authorization: await f.authorization('subject:merge'),
  };
}
async function input(survivor: string, redirected: string): Promise<IdentityAdmissionInput> {
  const key = randomUUID();
  return {
    intent: { kind: 'merge', survivor, redirected, release: release.digest },
    receipt: {
      kind: 'subject.merge',
      command: { actorAccountId: (await f.actor()).accountId, kind: 'subject.merge', key, digest: digest(key) },
    },
  };
}
async function create(route: number) {
  return (await f.create('Native home isolation', route)).subject.id;
}

const receivingSQL = /SELECT semantic\.(?:acquire|close)_identity_epoch_admission\(/;
const sourceAckSQL = /INSERT INTO semantic\.identity_epoch_mapping/;
const finalizationSQL = /FROM semantic\.identity_epoch_admission_source s/;

async function bootstrap(partition: number) {
  for (let step = 0; step < 100; step++) {
    const progress = await isolated(
      sourceAckSQL,
      partition,
      () => stepIdentityEpochBootstrap(f.pool, partition),
      false,
    );
    expect(progress.work.rows).toBeLessThanOrEqual(100);
    if (progress.state === 'caught-up') return;
  }
  throw new Error('The finite native source did not close');
}

test('released job input reaches actual receiving custody before distinct-home acquisition and finalization', async () => {
  const redirected = await create(0x7a10);
  const survivor = await create(0x7a20);
  const job = await store.prepareAdmission(f.pool, await authority(), await input(survivor, redirected));
  expect(home(job.jobId)).toBe(home(redirected));
  expect(home(job.jobId)).not.toBe(home(survivor));
  await stepIdentityEpochAdmission(f.pool, job);

  // This is the old nested foreign read, under the SAME policy as the receiving
  // command below. Its job-home plan is invisible at the receiving home.
  const witness = await f.admin.connect();
  try {
    await witness.query('BEGIN');
    await witness.query(`SET LOCAL ROLE ${role}`);
    await witness.query("SELECT set_config('identity_test.home',$1,true)", [String(home(survivor))]);
    expect(
      (await witness.query('SELECT * FROM semantic.identity_epoch_admission_plan WHERE job_id=$1', [job.jobId])).rows,
    ).toEqual([]);
  } finally {
    await witness.query('ROLLBACK');
    witness.release();
  }
  // Lose the response after the genuine receiving commit, redeliver the same
  // attempt, and reconcile that immutable native receipt without a new attempt.
  await isolated(receivingSQL, home(survivor), () => acquireIdentityEpochAdmissionHome(f.pool, job, home(survivor)));
  await isolated(receivingSQL, home(survivor), () => acquireIdentityEpochAdmissionHome(f.pool, job, home(survivor)));
  await stepIdentityEpochAdmission(f.pool, job);
  const promoted = await isolated(finalizationSQL, home(job.jobId), () => stepIdentityEpochAdmission(f.pool, job));
  expect(promoted.state).toBe('pending');
  const receipts = (
    await f.admin.query(
      `SELECT r.partition_no,r.transaction_id FROM semantic.identity_epoch_admission_receipt r
       JOIN semantic.identity_epoch_native_commit c USING(partition_no,transaction_id)
       WHERE r.job_id=$1 AND r.stage='acquired' AND r.xmin=c.xmin ORDER BY r.partition_no`,
      [job.jobId],
    )
  ).rows;
  expect(receipts.map((r) => r.partition_no)).toEqual([home(redirected), home(survivor)]);
  await expect(cancelIdentityEpochAdmission(f.pool, job)).rejects.toMatchObject({ code: 'identity_effect_stale' });
  await expect(
    runCommand(f.pool, { partition: home(job.jobId) }, (tx) => store.publish(tx, job)),
  ).rejects.toMatchObject({ code: 'identity_participants_incomplete' });
});

/** The source ACK fails before executing; every receiving command has already
 * committed, so recovery must reuse the retained native export and custody.
 */
async function loseSourceAck(partition: number) {
  let interrupted = false;
  const originals = new Map<PoolClient, PoolClient['query']>();
  const acquired = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = async function (...args: unknown[]) {
      const statement = typeof args[0] === 'string' ? args[0] : '';
      if (sourceAckSQL.test(statement)) {
        interrupted = true;
        throw new Error('lost source ACK response');
      }
      return Reflect.apply(query, client, args);
    } as PoolClient['query'];
  };
  f.pool.on('acquire', acquired);
  try {
    await expect(stepIdentityEpochBootstrap(f.pool, partition)).rejects.toThrow('lost source ACK response');
    expect(interrupted).toBe(true);
  } finally {
    f.pool.off('acquire', acquired);
    for (const [client, query] of originals) client.query = query;
  }
}

test('source ACK after a Library bootstrap redirect uses a committed receiving basis, including replay after lost ACK', async () => {
  const original = await create(0x7b10);
  const terminal = await create(0x7b20);
  await f.merge(original, terminal);
  expect(home(original)).not.toBe(home(terminal));
  await loseSourceAck(home(original));
  const retained = (
    await f.admin.query(
      `SELECT p.transaction_id FROM semantic.identity_epoch_bootstrap_page p
       JOIN semantic.identity_epoch_native_commit c USING(partition_no,transaction_id)
       WHERE p.partition_no=$1 AND NOT p.acknowledged AND p.xmin=c.xmin`,
      [home(original)],
    )
  ).rows;
  expect(retained).toHaveLength(1);
  const custody = (
    await f.admin.query(
      `SELECT native_transaction_id FROM semantic.identity_epoch_bootstrap_custody
       WHERE partition_no=$1 AND source_partition=$2 AND stage='add'`,
      [home(terminal), home(original)],
    )
  ).rows;
  expect(custody.some((r) => r.native_transaction_id === retained[0]!.transaction_id)).toBe(true);
  await bootstrap(home(original));
  expect(await resolveSubject({ pool: f.pool, access: f.access }, await f.actor(), original)).toEqual({
    subjectId: terminal,
    requestedSubjectId: original,
  });
  expect(
    (
      await f.admin.query('SELECT partition_no,terminal FROM semantic.identity_epoch_original WHERE original=$1', [
        original,
      ])
    ).rows,
  ).toEqual([{ partition_no: home(terminal), terminal }]);
});

test('first-absence close and delayed acquire serialize at every distinct planned home without another slot', async () => {
  const redirected = await create(0x7c10);
  const survivor = await create(0x7c20);
  const job = await store.prepareAdmission(f.pool, await authority(), await input(survivor, redirected));
  await cancelIdentityEpochAdmission(f.pool, job);
  for (const partition of [home(redirected), home(survivor)]) {
    const progress = await isolated(receivingSQL, partition, () => stepIdentityEpochAdmission(f.pool, job));
    expect(progress.state).toBe('cancelling');
  }
  expect((await stepIdentityEpochAdmission(f.pool, job)).state).toBe('cancelled');
  const saved = (
    await f.admin.query('SELECT scope_digest FROM semantic.identity_epoch_job WHERE partition_no=$1 AND job_id=$2', [
      home(job.jobId),
      job.jobId,
    ])
  ).rows[0];
  for (const partition of [home(redirected), home(survivor)]) {
    await expect(
      isolated(receivingSQL, partition, () =>
        runCommand(f.pool, { partition }, async (tx) => {
          await tx.query(acquire.sql, [partition, job.jobId, job.epoch.toString(), saved.scope_digest]);
          return noEffect(null);
        }),
      ),
    ).rejects.toMatchObject({ message: 'identity_effect_stale' });
  }
  expect(await store.readMapping(f.pool, redirected)).toMatchObject({ state: 'mapped', terminal: redirected });
});

test('the explicit native receipt bridge rejects changed intent at a different job home', async () => {
  const first = [await create(0x7d10), await create(0x7d10)];
  const second = [await create(0x7d20), await create(0x7d20)];
  const original = await input(first[0]!, first[1]!);
  const auth = await authority();
  const bindingHome = home(f.accounts.editor);
  expect(bindingHome).not.toBe(home(first[0]!));
  expect(bindingHome).not.toBe(home(second[0]!));
  const binding = await isolated(/semantic.identity_epoch_receipt_(?:binding|claim)/, bindingHome, () =>
    store.bindReceipt(f.pool, auth, original),
  );
  const admitted = await isolated(receivingSQL, home(first[0]!), () =>
    runCommand(f.pool, { ...auth, partition: home(first[0]!) }, (tx) => store.admit(tx, { ...original, binding })),
  );
  const accepted = await isolated(/UPDATE semantic.identity_epoch_receipt_binding/, bindingHome, () =>
    store.bindReceipt(f.pool, auth, original),
  );
  expect(
    (
      await runCommand(f.pool, { ...auth, partition: home(first[0]!) }, async (tx) =>
        noEffect(await store.findJob(tx, original.receipt, accepted)),
      )
    ).value?.ref,
  ).toEqual(admitted.value);
  // Receipt identity has no home field. Its public contract rejects conflicting
  // intent before any new job, even when the changed groups are in another home.
  // A per-job-home UNIQUE key plus this local command is insufficient for that.
  const changed = {
    ...original,
    intent: { kind: 'merge' as const, survivor: second[0]!, redirected: second[1]!, release: release.digest },
  };
  await expect(
    isolated(/semantic.identity_epoch_receipt_binding/, bindingHome, () => store.bindReceipt(f.pool, auth, changed)),
  ).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
  expect(
    (await f.admin.query('SELECT job_id FROM semantic.identity_epoch_job WHERE partition_no=$1', [home(second[0]!)]))
      .rows,
  ).toEqual([]);
  expect(routeOf(admitted.value.jobId)! >> 4).toBe(home(first[0]!));
});

test('source head h+1 survives ACK of a retained h and a native owner move cannot certify finalization', async () => {
  const original = await create(0x7e10);
  const terminal = await create(0x7e20);
  await loseSourceAck(home(original));
  const retained = (
    await f.admin.query(
      `SELECT r.source_revision FROM semantic.identity_epoch_bootstrap_row r
     JOIN semantic.identity_epoch_bootstrap_page p USING(partition_no,transaction_id)
     WHERE r.partition_no=$1 AND r.original=$2 AND NOT p.acknowledged`,
      [home(original), original],
    )
  ).rows[0];
  expect(retained).toBeDefined();
  await f.merge(original, terminal);
  await isolated(sourceAckSQL, home(original), () => stepIdentityEpochBootstrap(f.pool, home(original)));
  const dirty = (
    await f.admin.query(
      'SELECT revision,captured_revision FROM semantic.identity_epoch_dirty WHERE route=$1 AND original=$2',
      [routeOf(original), original],
    )
  ).rows[0];
  expect(BigInt(dirty.captured_revision)).toBe(BigInt(retained.source_revision));
  expect(BigInt(dirty.revision)).toBeGreaterThan(BigInt(dirty.captured_revision));
  expect(await store.readMapping(f.pool, original)).toMatchObject({ state: 'unavailable' });
  await bootstrap(home(original));
  const peer = await create(0x7e30);
  const job = await store.prepareAdmission(f.pool, await authority(), await input(peer, original));
  expect(home(job.jobId)).toBe(home(terminal));
  expect(home(job.jobId)).not.toBe(home(original));
  await stepIdentityEpochAdmission(f.pool, job);
  await isolated(receivingSQL, home(peer), () => acquireIdentityEpochAdmissionHome(f.pool, job, home(peer)));
  await stepIdentityEpochAdmission(f.pool, job);
  await f.admin.query("UPDATE core.partition SET write_state='moved',moved_to='other-node' WHERE partition_no=$1", [
    home(original),
  ]);
  try {
    const progress = await isolated(finalizationSQL, home(job.jobId), () => stepIdentityEpochAdmission(f.pool, job));
    expect(progress.state).toBe('cancelling');
    expect(await store.readMapping(f.pool, original)).toEqual({ state: 'unavailable', reason: 'moved-owner' });
  } finally {
    await f.admin.query("UPDATE core.partition SET write_state='active',moved_to=NULL WHERE partition_no=$1", [
      home(original),
    ]);
  }
  for (let step = 0; step < 3; step++) await stepIdentityEpochAdmission(f.pool, job);
  expect((await store.readJob(f.pool, job))?.state).toBe('cancelled');
});

/** Lose only the response after PostgreSQL has committed the selected native command. */
async function loseCommittedReply<T>(selected: RegExp, operation: () => Promise<T>) {
  const originals = new Map<PoolClient, PoolClient['query']>();
  let reached = false,
    lost = false;
  const acquired = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    let selectedCommand = false;
    client.query = async function (...args: unknown[]) {
      const text = typeof args[0] === 'string' ? args[0] : (args[0] as { text?: string })?.text;
      if (text && selected.test(text)) {
        selectedCommand = true;
        reached = true;
      }
      const result = await Reflect.apply(query, client, args);
      if (text === 'COMMIT' && selectedCommand && !lost) {
        lost = true;
        throw new Error('lost committed binding reply');
      }
      return result;
    } as PoolClient['query'];
  };
  f.pool.on('acquire', acquired);
  try {
    await expect(operation()).rejects.toThrow('lost committed binding reply');
  } finally {
    f.pool.off('acquire', acquired);
    for (const [client, query] of originals) client.query = query;
  }
  expect(reached).toBe(true);
  expect(lost).toBe(true);
}

async function bindingRows(request: IdentityAdmissionInput) {
  const key =
    request.receipt.kind === 'subject.merge'
      ? JSON.stringify([
          request.receipt.kind,
          request.receipt.command.actorAccountId,
          request.receipt.command.kind,
          request.receipt.command.key,
        ])
      : JSON.stringify([request.receipt.kind, request.receipt.account, request.receipt.receipt]);
  return (
    await f.admin.query(
      `SELECT b.state,b.accepted_job,c.*,k.transaction_id AS binding_commit
 FROM semantic.identity_epoch_receipt_binding b JOIN semantic.identity_epoch_receipt_claim c USING(partition_no,receipt_key)
 JOIN semantic.identity_epoch_receipt_claim_commit k
 ON (k.partition_no,k.receipt_key,k.generation)=(c.partition_no,c.receipt_key,c.generation)
 WHERE b.partition_no=$1 AND b.receipt_key=$2 ORDER BY c.generation`,
      [home(f.accounts.editor), key],
    )
  ).rows;
}

for (const lost of ['pending', 'accepted'] as const)
  test(`native ${lost} claim/publication lost reply replays the retained single job`, async () => {
    const survivor = await create(lost === 'pending' ? 0x7f10 : 0x7f20),
      redirected = await create(lost === 'pending' ? 0x7f10 : 0x7f20);
    const request = await input(survivor, redirected),
      auth = await authority();
    if (lost === 'pending')
      await loseCommittedReply(/INSERT INTO semantic.identity_epoch_receipt_binding/, () =>
        store.bindReceipt(f.pool, auth, request),
      );
    let binding = await store.bindReceipt(f.pool, auth, request);
    const claims = await bindingRows(request);
    expect(claims).toHaveLength(1);
    expect(claims[0].state).toBe('pending');
    expect(
      (await f.admin.query('SELECT job_id FROM semantic.identity_epoch_job WHERE partition_no=$1', [home(survivor)]))
        .rows,
    ).toEqual([]);
    const changed = {
      ...request,
      intent: {
        ...request.intent,
        kind: 'merge' as const,
        survivor: redirected,
        redirected: survivor,
        release: release.digest,
      },
    };
    await expect(store.bindReceipt(f.pool, auth, changed)).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
    const admitted = await isolated(receivingSQL, home(survivor), () =>
      runCommand(f.pool, { ...auth, partition: home(survivor) }, (tx) => store.admit(tx, { ...request, binding })),
    );
    // First reservation/job is already durable while the binding still says pending.
    expect((await bindingRows(request))[0].state).toBe('pending');
    expect(admitted.value.jobId).toBe(claims[0].job_id);
    if (lost === 'accepted')
      await loseCommittedReply(/UPDATE semantic.identity_epoch_receipt_binding/, () =>
        store.bindReceipt(f.pool, auth, request),
      );
    binding = await store.bindReceipt(f.pool, auth, request);
    const replay = await runCommand(f.pool, { ...auth, partition: home(survivor) }, (tx) =>
      store.admit(tx, { ...request, binding }),
    );
    expect(replay.value).toEqual(admitted.value);
    const retained = await bindingRows(request);
    expect(retained).toHaveLength(1);
    expect(retained[0].state).toBe('accepted');
    expect(retained[0].accepted_job).toBe(admitted.value.jobId);
    expect(retained[0].binding_commit).toBe(claims[0].binding_commit);
    expect(
      (await f.admin.query('SELECT job_id FROM semantic.identity_epoch_job WHERE partition_no=$1', [home(survivor)]))
        .rows,
    ).toEqual([{ job_id: admitted.value.jobId }]);
    await expect(store.bindReceipt(f.pool, auth, changed)).rejects.toMatchObject({ name: 'IdempotencyConflictError' });
  });

test('equal concurrent native claims and reservations choose one job and denied authority sees no replay or conflict', async () => {
  const survivor = await create(0x7f30),
    redirected = await create(0x7f30),
    request = await input(survivor, redirected),
    auth = await authority();
  const claims = await Promise.all([
    store.bindReceipt(f.pool, auth, request),
    store.bindReceipt(f.pool, auth, request),
  ]);
  const results = await Promise.all(
    claims.map((binding) =>
      runCommand(f.pool, { ...auth, partition: home(survivor) }, (tx) => store.admit(tx, { ...request, binding })),
    ),
  );
  expect(results[0]!.value).toEqual(results[1]!.value);
  const accepted = await store.bindReceipt(f.pool, auth, request);
  expect(await bindingRows(request)).toHaveLength(1);
  const changed = {
    ...request,
    intent: { kind: 'merge' as const, survivor: redirected, redirected: survivor, release: release.digest },
  };
  await f.real.revoke({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:merge');
  try {
    await expect(store.bindReceipt(f.pool, await authority(), request)).rejects.toThrow('Denied subject:merge');
    await expect(store.bindReceipt(f.pool, await authority(), changed)).rejects.toThrow('Denied subject:merge');
    await expect(
      runCommand(f.pool, { ...(await authority()), partition: home(survivor) }, async (tx) =>
        noEffect(await store.findJob(tx, request.receipt, accepted)),
      ),
    ).rejects.toThrow('Denied subject:merge');
  } finally {
    await f.real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'editor', 'subject:merge');
  }
  expect((await bindingRows(request))[0].accepted_job).toBe(results[0]!.value.jobId);
});

test('a failed provisional basis closes every planned home before a same-intent later generation and rejects delayed acquisition', async () => {
  const original = await create(0x7f40),
    peer = await create(0x7f50),
    terminal = await create(0x7f60);
  const request = await input(peer, original),
    auth = await authority();
  const first = await store.bindReceipt(f.pool, auth, request),
    before = (await bindingRows(request))[0];
  await f.merge(original, terminal);
  await bootstrap(home(original));
  await expect(
    runCommand(f.pool, { ...auth, partition: before.job_home }, (tx) =>
      store.admit(tx, { ...request, binding: first }),
    ),
  ).rejects.toMatchObject({ code: 'identity_effect_stale' });
  const next = await store.bindReceipt(f.pool, auth, request),
    history = await bindingRows(request);
  expect(history).toHaveLength(2);
  expect(history.map((r) => r.generation)).toEqual(['1', '2']);
  expect(history[0].intent_digest).toBe(history[1].intent_digest);
  expect(history[0].job_id).not.toBe(history[1].job_id);
  const closed = (
    await f.admin.query(
      `SELECT c.resource_home,c.transaction_id FROM semantic.identity_epoch_receipt_closure c WHERE c.partition_no=$1 AND c.receipt_key=$2 AND c.generation=1 ORDER BY resource_home`,
      [home(f.accounts.editor), before.receipt_key],
    )
  ).rows;
  expect(closed.map((r) => r.resource_home)).toEqual([home(original), home(peer)]);
  for (const q of [home(original), home(peer)])
    await expect(
      isolated(receivingSQL, q, () =>
        runCommand(f.pool, { partition: q }, async (tx) => {
          await tx.query(acquire.sql, [q, before.job_id, before.job_epoch, before.scope_digest]);
          return noEffect(null);
        }),
      ),
    ).rejects.toMatchObject({ message: 'identity_effect_stale' });
  const result = await runCommand(f.pool, { ...auth, partition: history[1].job_home }, (tx) =>
    store.admit(tx, { ...request, binding: next }),
  );
  await store.bindReceipt(f.pool, auth, request);
  expect(result.value.jobId).toBe(history[1].job_id);
  expect((await bindingRows(request))[0].accepted_job).toBe(result.value.jobId);
  expect(
    (await f.admin.query('SELECT job_id FROM semantic.identity_epoch_job WHERE job_id=$1', [before.job_id])).rows,
  ).toEqual([]);
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { mergeVerifiedAgent } from '../../src/access/agent-verification.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { routeOf } from '../../src/route/route.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { readAccountIdentityUndo } from '../../src/semantic/identity-epoch-binding.ts';
import {
  readIdentitySourceConsumerCustody,
  verifyIdentitySourceConsumerCustody,
  type IdentitySourceConsumerCustody,
  type IdentitySourceConsumerReference,
} from '../../src/semantic/identity-source-consumer-custody.ts';
import {
  identitySourceConsumerLibraryWork,
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import { readIdentitySourceMaintenanceConfig } from '../../src/semantic/identity-source-maintenance-config.ts';
import { approvedVerification, cutoverFixture } from './support/identity-epoch-cutover.ts';

// Authored native cases only. Run through the existing kernel fixture runner after integration.
let f: Awaited<ReturnType<typeof cutoverFixture>>;
let reference: IdentitySourceConsumerReference;
beforeAll(async () => {
  f = await cutoverFixture();
  const catalogue = (await f.create('Custody verification catalogue')).subject.id;
  const approved = await approvedVerification(f, catalogue);
  await ensureAccountAgent(f.pool, { account: approved.account, kind: 'person', name: null });
  await mergeVerifiedAgent(f.pool, approved.workflow);
  const receipt = {
    kind: 'account-agent.verify' as const,
    account: approved.account,
    receipt: approved.workflow.receiptId,
  };
  const accepted = await readAccountIdentityUndo(f.pool, receipt);
  reference = {
    receipt,
    job: accepted.job,
    source: {
      partition: accepted.source.partition,
      epoch: accepted.source.epoch,
      position: accepted.source.position,
      transactionId: accepted.source.transactionId,
    },
    sourceDigest: accepted.source.digest,
    barrier: {
      accountId: approved.account,
      accountRoute: routeOf(approved.account)!,
      version: 1,
      at: new Date().toISOString(),
    },
    erasedRole: 'subject',
  };
});
afterAll(async () => {
  await f?.close();
});

async function originalBytes() {
  return (
    await f.admin.query<{ bytes: string }>(
      `SELECT row_to_json(i)::text AS bytes FROM access.agent_identity_intent i
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [
        routeOf(reference.receipt.account),
        reference.receipt.account,
        reference.receipt.kind,
        reference.receipt.receipt,
      ],
    )
  ).rows[0]?.bytes;
}

test('Original account identity source bytes remain retained until exact native consumer discharge or durable technical undo transfer is verified at the original source home independently of shared copy closure', async () => {
  const before = await originalBytes();
  expect(before).toBeString();
  // The job is actually published by the native producer, with real participant receipts.
  // No History-copy result or synthetic receiving record is supplied to complete the source.
  const deadline = Date.now() + 5000;
  const proof = await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: process.env },
    { deadline },
    (funded) => readIdentitySourceConsumerCustody(f.pool, reference, funded),
  );
  expect(proof, 'publication alone does not discharge future native undo/replay consumers').toBeNull();
  expect(await originalBytes()).toBe(before);
  const retained = await f.admin.query<{ state: string; source_position: string }>(
    `SELECT state,source_position::text FROM semantic.identity_epoch_source_consumer_custody
     WHERE partition_no=$1 AND receipt_key=$2 AND source_digest=$3 AND barrier_account_id=$4
       AND barrier_version=$5 AND barrier_at=$6::timestamptz AND erased_role=$7`,
    [
      reference.source.partition,
      JSON.stringify([reference.receipt.kind, reference.receipt.account, reference.receipt.receipt]),
      reference.sourceDigest,
      reference.barrier.accountId,
      reference.barrier.version,
      reference.barrier.at,
      reference.erasedRole,
    ],
  );
  expect(retained.rows).toEqual([{ state: 'retained', source_position: reference.source.position.toString() }]);
  expect(await readIdentitySourceConsumerCustody(f.pool, reference, { deadline: Date.now() + 5000 })).toBeNull();
  expect(await originalBytes()).toBe(before);
});

test('Source maintenance issues one genuinely configured live accounting frame with separate native and Library allocations and refuses all consumer I/O without that frame', async () => {
  const configured = readIdentitySourceMaintenanceConfig(process.env);
  expect(configured.native.rows).toBeGreaterThan(0);
  expect(configured.native.statements).toBeGreaterThan(0);
  expect(configured.library.candidateKeys).toBe(1);
  expect(configured.library.nativeRows).toBeGreaterThan(0);
  expect(configured.native).not.toBe(configured.library);

  const deadline = Date.now() + 5000;
  let work: import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceWork | undefined;
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: process.env }, { deadline }, async (funded) => {
    work = funded.identityConsumerWork;
    expect(isLiveIdentitySourceConsumerMaintenance(f.pool, work, funded.deadline)).toBe(true);
    expect(identitySourceConsumerLibraryWork(f.pool, work, funded.deadline)).toBeDefined();
    expect(reserveIdentitySourceConsumerNativeWork(f.pool, work, {
      rows: 1, points: 1, statements: 1, bytes: 1, engineRequests: 0,
    })).toBe(true);
  });
  expect(isLiveIdentitySourceConsumerMaintenance(f.pool, work, deadline)).toBe(false);
  let checkouts = 0;
  const pool = { connect: () => { checkouts++; throw new Error('unexpected Source checkout'); } } as unknown as Pool;
  expect(await readIdentitySourceConsumerCustody(pool, reference, { deadline: Date.now() + 5000 })).toBeNull();
  expect(checkouts).toBe(0);
});

test('wrong original source receipt job digest and erased logical role cannot stage custody for another obligation', async () => {
  const variants: IdentitySourceConsumerReference[] = [
    { ...reference, source: { ...reference.source, position: reference.source.position + 1n } },
    { ...reference, source: { ...reference.source, epoch: reference.source.epoch + 1 } },
    { ...reference, source: { ...reference.source, transactionId: randomUUID() } },
    { ...reference, receipt: { ...reference.receipt, receipt: randomUUID() } },
    { ...reference, job: { ...reference.job, epoch: reference.job.epoch + 1n } },
    { ...reference, sourceDigest: '0'.repeat(64) },
    {
      ...reference,
      erasedRole: 'requester',
      barrier: { ...reference.barrier, accountId: f.accounts.outsider, accountRoute: routeOf(f.accounts.outsider)! },
    },
  ];
  const before = await originalBytes();
  for (const other of variants)
    expect(await readIdentitySourceConsumerCustody(f.pool, other, { deadline: Date.now() + 5000 })).toBeNull();
  expect(await originalBytes()).toBe(before);
});

test('a retained locator or copied brand cannot authorize cleanup for any barrier role or original owner', async () => {
  const fake = Object.freeze({}) as IdentitySourceConsumerCustody;
  const variants: IdentitySourceConsumerReference[] = [
    reference,
    { ...reference, barrier: { ...reference.barrier, version: reference.barrier.version + 1 } },
    {
      ...reference,
      barrier: { ...reference.barrier, at: new Date(Date.parse(reference.barrier.at) + 1).toISOString() },
    },
    { ...reference, erasedRole: 'decider' },
    { ...reference, source: { ...reference.source, epoch: reference.source.epoch + 1 } },
  ];
  for (const other of variants) {
    const verified = await runCommand(f.pool, { partition: reference.source.partition }, async (tx) =>
      noEffect(await verifyIdentitySourceConsumerCustody(tx, other, fake)),
    );
    expect(verified.value).toBe(false);
  }
});

test('Source funding remains one allocation across awaits and ends even when its callback fails', async () => {
  const configured = readIdentitySourceMaintenanceConfig({});
  let work: import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceWork | undefined;
  const deadline = Date.now() + 5000;
  const failure = new Error('maintenance callback failed');
  await expect(withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    work = funded.identityConsumerWork;
    const library = identitySourceConsumerLibraryWork(f.pool, work, deadline);
    expect(library).not.toBeNull();
    expect(reserveIdentitySourceConsumerNativeWork(f.pool, work, configured.native)).toBe(true);
    await Promise.resolve();
    expect(identitySourceConsumerLibraryWork(f.pool, work, deadline)).toBe(library);
    expect(reserveIdentitySourceConsumerNativeWork(f.pool, work, {
      rows: 1, points: 0, statements: 0, bytes: 0, engineRequests: 0,
    })).toBe(false);
    expect(library?.available('nativeRows')).toBe(configured.library.nativeRows);
    throw failure;
  })).rejects.toBe(failure);
  if (!work) throw new Error('Source maintenance did not enter its callback');
  expect(isLiveIdentitySourceConsumerMaintenance(f.pool, work, deadline)).toBe(false);
  expect(identitySourceConsumerLibraryWork(f.pool, work, deadline)).toBeNull();
  expect(await readIdentitySourceConsumerCustody(f.pool, reference, {
    deadline, identityConsumerWork: work,
  })).toBeNull();
});

test('Source consumer refuses copied foreign expired and ended frames before checkout', async () => {
  let checkouts = 0;
  const pool = { connect: () => { checkouts++; throw new Error('unexpected Source checkout'); } } as unknown as Pool;
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    expect(await readIdentitySourceConsumerCustody(pool, reference, funded)).toBeNull();
    expect(await readIdentitySourceConsumerCustody(pool, reference, {
      ...funded, identityConsumerWork: { ...funded.identityConsumerWork },
    })).toBeNull();
  });
  let ended: import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceContext | undefined;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    ended = funded;
    expect(await readIdentitySourceConsumerCustody(pool, reference, {
      ...funded, deadline: Date.now() - 1,
    })).toBeNull();
  });
  expect(ended).toBeDefined();
  expect(await readIdentitySourceConsumerCustody(pool, reference, ended!)).toBeNull();
  expect(checkouts).toBe(0);
});

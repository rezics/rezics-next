import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import {
  createAgentVerificationCommands,
  recordPendingAgentVerification,
} from '../../src/access/agent-verification.ts';
import { loadAccountIdentitySource } from '../../src/access/agent-verification-identity.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { partitionOf, routeOf, newId } from '../../src/route/route.ts';
import { readAgentIdentityNativeInventory } from '../../src/history/agent-identity-inventory.ts';
import { readAgentIdentityRecoveryInventoryInTransaction } from '../../src/history/agent-identity-inventory.ts';
import { verifyAgentIdentityRecoveryArtifactReadiness } from '../../src/history/agent-identity-recovery-receiving.ts';
import { readAgentIdentitySDKRetirementGap } from '../../src/history/agent-identity-retirement.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { readOriginalAccountAgentIdentity } from '../../src/semantic/account-agent-identity-recovery.ts';
import { stepIdentityEpochAdmission } from '../../src/semantic/identity-epoch-admission.ts';
import { identityEpochStore } from '../../src/semantic/identity-epoch-store.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { createRealAccess } from '../semantic/real-access.ts';
import { epochFixture, type EpochFixture } from '../semantic/support/identity-epoch.ts';

let fixture: EpochFixture;
beforeAll(async () => {
  fixture = await epochFixture();
});
afterAll(async () => {
  await fixture?.close();
});

test('missing-source recovery seals its exact receipt and account-updated cut without certifying original inventory or SDK custody', async () => {
  const route = 0x9d10;
  const accounts = { owner: newId(route), reviewer: newId(route) };
  const actions = ['account:update', 'account:verify_agent'];
  const real = await createRealAccess(fixture.admin, accounts, actions);
  const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  await real.grant({ route, id: accounts.owner }, 'owner', 'account:update');
  await real.grant(PLATFORM_RESOURCE, 'reviewer', 'account:verify_agent');
  const context = async (persona: 'owner' | 'reviewer') => {
    const deadline = Date.now() + 5000;
    return {
      pool: fixture.pool,
      deadline,
      actor: await access.authenticate(real.bearer(persona), { pool: fixture.pool, deadline }),
    };
  };
  const catalogue = (await fixture.create('Recovery retention subject', route)).id;
  await ensureAccountAgent(fixture.pool, { account: accounts.owner, kind: 'person', name: 'Recovery owner' });
  const commands = createAgentVerificationCommands({ pool: fixture.pool, access, clock: () => new Date() });
  const request = await commands.request(await context('owner'), {
    accountId: accounts.owner,
    subject: catalogue,
    statement: 'I represent this recovered identity',
    links: [{ label: 'Profile', url: 'https://example.test/profile' }],
    key: randomUUID(),
  });
  const decision = await commands.approve(await context('reviewer'), {
    requestId: request.value.id,
    key: randomUUID(),
  });
  const receipt = decision.value.decisionReceiptId!;
  await recordPendingAgentVerification(fixture.pool, { ...decision.value, receiptId: receipt }, () => new Date());
  const identityReceipt = { kind: 'account-agent.verify' as const, account: accounts.owner, receipt };
  const original = await loadAccountIdentitySource(fixture.pool, identityReceipt);
  const job = await identityEpochStore.prepareAdmission(fixture.pool, {}, original.input);
  for (let page = 0; page < 512; page++) {
    const progress = await stepIdentityEpochAdmission(fixture.pool, job);
    if (progress.state === 'pending') break;
    expect(progress.state).toBe('preparing');
    if (page === 511) throw new Error('Original Source admission did not finish');
  }

  const selection = { account: accounts.owner, direction: identityReceipt.kind, receipt };
  const accepted = await readOriginalAccountAgentIdentity(fixture.pool, selection);
  expect(accepted?.input).toEqual(original.input);
  const restore = await fixture.pool.connect();
  try {
    await restore.query('BEGIN');
    await restore.query("SET LOCAL session_replication_role='replica'");
    await restore.query(
      `DELETE FROM access.agent_identity_intent
       WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [routeOf(accounts.owner), accounts.owner, identityReceipt.kind, receipt],
    );
    await restore.query('COMMIT');
  } finally {
    restore.release();
  }

  const recovered = await loadAccountIdentitySource(fixture.pool, identityReceipt);
  expect(recovered.input).toEqual(original.input);
  expect(recovered.digest).toBe(original.digest);
  const recovery = (
    await fixture.pool.query<{
      requested_by: string;
      recovery_epoch: number;
      recovery_position: string;
      recovery_transaction_id: string;
      recovery_receipt_key: string;
    }>(
      `SELECT requested_by,recovery_epoch,recovery_position::text,recovery_transaction_id,recovery_receipt_key
       FROM access.agent_identity_recovery
       WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4`,
      [routeOf(accounts.owner), accounts.owner, identityReceipt.kind, receipt],
    )
  ).rows[0]!;
  const cut = (
    await fixture.pool.query<{
      source_digest: string;
      recovery_epoch: number;
      recovery_position: string;
      recovery_transaction_id: string;
      native_command_kind: string;
      native_receipt_key: string;
      expected_locators: Buffer[];
      expected_event_types: string[];
      state: string;
      native_writer_state: string;
    }>(
      `SELECT source_digest,recovery_epoch,recovery_position::text,recovery_transaction_id,
         native_command_kind,native_receipt_key,expected_locators,expected_event_types,state,native_writer_state
       FROM core.agent_identity_recovery_inventory
       WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3
         AND source_direction=$4 AND source_receipt_id=$5`,
      [partitionOf(route), routeOf(accounts.owner), accounts.owner, identityReceipt.kind, receipt],
    )
  ).rows[0]!;
  expect(cut).toMatchObject({
    source_digest: original.digest,
    recovery_epoch: recovery.recovery_epoch,
    recovery_position: recovery.recovery_position,
    recovery_transaction_id: recovery.recovery_transaction_id,
    native_command_kind: 'access.agent-identity.recover',
    native_receipt_key: recovery.recovery_receipt_key,
    expected_event_types: ['com.rezics.access.account-updated.v1'],
    state: 'sealed',
    native_writer_state: 'closed',
  });
  expect(cut.expected_locators).toHaveLength(2);

  const copies = (
    await fixture.pool.query<{ artifact_type: string; locator: Buffer }>(
      `SELECT artifact_type,locator FROM core.agent_identity_history_copy
       WHERE partition_no=$1 AND source_route=$2 AND source_account_id=$3
         AND source_direction=$4 AND source_receipt_id=$5 AND source_transaction_id=$6
       ORDER BY artifact_type`,
      [
        partitionOf(route),
        routeOf(accounts.owner),
        accounts.owner,
        identityReceipt.kind,
        receipt,
        recovery.recovery_transaction_id,
      ],
    )
  ).rows;
  expect(copies.map(({ artifact_type }) => artifact_type)).toEqual(['command-receipt/v1', 'outbox-event/v1']);
  expect(copies.map(({ locator }) => Buffer.from(locator).toString('hex')).sort()).toEqual(
    cut.expected_locators.map((locator) => Buffer.from(locator).toString('hex')).sort(),
  );
  const serializedReceipt = (
    await fixture.pool.query<{ transaction_id: string; payload_state: string; position: string }>(
      `SELECT transaction_id,payload_state,position::text FROM core.receipt
       WHERE partition_no=$1 AND principal_kind='account' AND principal_id=$2
         AND command_kind='access.agent-identity.recover' AND idempotency_key=$3`,
      [partitionOf(route), recovery.requested_by, recovery.recovery_receipt_key],
    )
  ).rows;
  expect(serializedReceipt).toEqual([
    {
      transaction_id: recovery.recovery_transaction_id,
      payload_state: 'present',
      position: recovery.recovery_position,
    },
  ]);
  const event = (
    await fixture.pool.query<{ type: string; event_seq: number; event_count: number; subject: string; data: unknown }>(
      `SELECT type,event_seq,event_count,subject,data FROM core.outbox
       WHERE partition_no=$1 AND epoch=$2 AND position=$3 ORDER BY event_seq`,
      [partitionOf(route), recovery.recovery_epoch, recovery.recovery_position],
    )
  ).rows;
  expect(event).toEqual([
    {
      type: 'com.rezics.access.account-updated.v1',
      event_seq: 0,
      event_count: 1,
      subject: accounts.owner,
      data: { accountId: accounts.owner },
    },
  ]);

  const receivingContext = { deadline: Date.now() + 5000 };
  await expect(
    readAgentIdentityNativeInventory(
      fixture.pool,
      {
        route: routeOf(accounts.owner)!,
        accountId: accounts.owner,
        direction: identityReceipt.kind,
        receiptId: receipt,
      },
      receivingContext,
    ),
  ).resolves.toMatchObject({ state: 'pending', gap: 'agent-identity-original-inventory-unsealed' });
  await expect(
    readAgentIdentitySDKRetirementGap(
      fixture.pool,
      { kind: identityReceipt.kind, account: accounts.owner, receipt },
      receivingContext,
    ),
  ).resolves.toBe('agent-identity-sdk-recording-port-unavailable');

  const recoveryReceiving = (
    await runCommand(fixture.pool, { partition: partitionOf(route) }, async (tx) => {
      const current = await readAgentIdentityRecoveryInventoryInTransaction(tx, {
        route: routeOf(accounts.owner)!,
        accountId: accounts.owner,
        direction: identityReceipt.kind,
        receiptId: receipt,
      });
      if (current.state !== 'sealed')
        return noEffect({
          state: 'pending' as const,
          gap: current.gap ?? 'agent-identity-recovery-inventory-unsealed',
        });
      const event = current.proof.artifacts.find(({ locator }) => locator.artifactType === 'outbox-event/v1');
      if (!event) return noEffect({ state: 'pending' as const, gap: 'agent-identity-recovery-event-cut-unavailable' });
      const readiness = await verifyAgentIdentityRecoveryArtifactReadiness(tx, event, undefined, fixture.pool);
      return noEffect({
        state: readiness.state,
        gap: readiness.state === 'pending' ? readiness.gap : null,
      });
    })
  ).value;
  expect(recoveryReceiving.state).toBe('pending');
  expect(recoveryReceiving.gap).toMatch(
    /^agent-identity-recovery-(effects-pending|effect-consumer-unavailable|search-observation-unavailable)$/,
  );
  const retainedEvent = await fixture.pool.query<{ payload_state: string }>(
    `SELECT payload_state FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position=$3 AND event_seq=0`,
    [partitionOf(route), recovery.recovery_epoch, recovery.recovery_position],
  );
  expect(retainedEvent.rows[0]?.payload_state).toBe('present');

  const replay = await loadAccountIdentitySource(fixture.pool, identityReceipt);
  expect(replay.input).toEqual(original.input);
  const replayCounts = await fixture.pool.query<{ cuts: string; recovery_copies: string; events: string }>(
    `SELECT
       (SELECT count(*)::text FROM core.agent_identity_recovery_inventory WHERE partition_no=$1
         AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5) AS cuts,
       (SELECT count(*)::text FROM core.agent_identity_history_copy WHERE partition_no=$1
         AND source_route=$2 AND source_account_id=$3 AND source_direction=$4 AND source_receipt_id=$5
         AND source_transaction_id=$6) AS recovery_copies,
       (SELECT count(*)::text FROM core.outbox WHERE partition_no=$1 AND epoch=$7 AND position=$8) AS events`,
    [
      partitionOf(route),
      routeOf(accounts.owner),
      accounts.owner,
      identityReceipt.kind,
      receipt,
      recovery.recovery_transaction_id,
      recovery.recovery_epoch,
      recovery.recovery_position,
    ],
  );
  expect(replayCounts.rows[0]).toEqual({ cuts: '1', recovery_copies: '2', events: '1' });
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { PoolClient } from 'pg';
import { bundledRelease } from '@rezics/definitions/bundled';
import {
  createAgentVerificationCommands,
  recordPendingAgentVerification,
} from '../../src/access/agent-verification.ts';
import { loadAccountIdentitySource } from '../../src/access/agent-verification-identity.ts';
import { PLATFORM_RESOURCE } from '../../src/access/bootstrap-governance.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { accessCheck, accessCommandAuthorization } from '../../src/request/access.ts';
import { newId, partitionOf, routeOf } from '../../src/route/route.ts';
import {
  readOriginalAccountAgentIdentity,
  verifyOriginalAccountAgentIdentity,
} from '../../src/semantic/account-agent-identity-recovery.ts';
import { ensureAccountAgent } from '../../src/semantic/account-agents.ts';
import { activeRelease, activateRelease, publishRelease, GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { identityEpochStore as store, identityReceiptKey } from '../../src/semantic/identity-epoch-store.ts';
import { identityBindingDigest } from '../../src/semantic/identity-epoch-binding.ts';
import { createRealAccess } from './real-access.ts';
import { epochFixture, type EpochFixture } from './support/identity-epoch.ts';

let f: EpochFixture;
beforeAll(async () => {
  f = await epochFixture();
});
afterAll(async () => {
  await f?.close();
});

test('Exact retained original account identity admission input and native accepted claim provenance can be recovered without a current source or fresh admission while missing historical custody remains unavailable', async () => {
  const route = 0x9d10;
  const home = partitionOf(route);
  const accounts = { owner: newId(route), reviewer: newId(route) };
  const actions = ['account:update', 'account:verify_agent', 'definitions:publish', 'definitions:activate'];
  const real = await createRealAccess(f.admin, accounts, actions);
  const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  await real.grant({ route, id: accounts.owner }, 'owner', 'account:update');
  await real.grant(PLATFORM_RESOURCE, 'reviewer', 'account:verify_agent');
  for (const action of ['definitions:publish', 'definitions:activate'])
    await real.grant({ route: 0, id: GLOBAL_CONTEXT }, 'reviewer', action);
  const context = async (persona: 'owner' | 'reviewer') => ({
    pool: f.pool,
    deadline: Date.now() + 5000,
    actor: await access.authenticate(real.bearer(persona), { pool: f.pool, deadline: Date.now() + 5000 }),
  });
  const catalogue = (await f.create('Original reviewed person', route)).id;
  await ensureAccountAgent(f.pool, { account: accounts.owner, kind: 'person', name: 'Account person' });
  const commands = createAgentVerificationCommands({ pool: f.pool, access, clock: () => new Date() });
  const request = await commands.request(await context('owner'), {
    accountId: accounts.owner,
    subject: catalogue,
    statement: 'This is my catalogue identity',
    links: [{ label: 'Profile', url: 'https://example.test/profile' }],
    key: randomUUID(),
  });
  const decision = await commands.approve(await context('reviewer'), {
    requestId: request.value.id,
    key: randomUUID(),
  });
  const receipt = decision.value.decisionReceiptId!;
  await recordPendingAgentVerification(f.pool, { ...decision.value, receiptId: receipt }, () => new Date());
  const identityReceipt = { kind: 'account-agent.verify' as const, account: accounts.owner, receipt };
  const input = (await loadAccountIdentitySource(f.pool, identityReceipt)).input;
  const admitted = await runCommand(f.pool, { partition: home }, (tx) => store().admit(tx, input));
  const selection = { account: accounts.owner, direction: identityReceipt.kind, receipt };

  // Change the real active release AFTER admission; recovery must retain the original release.
  const nextRelease = structuredClone(bundledRelease);
  nextRelease.catalogue.version = `recovery-${randomUUID()}`;
  const options = async (action: string) => {
    const current = await context('reviewer');
    if (current.actor.kind !== 'account') throw new Error('Expected authenticated reviewer');
    return {
      actor: current.actor,
      idempotencyKey: randomUUID(),
      digest: new Uint8Array(32).fill(5),
      authorize: await accessCheck(access, current.actor, action, PLATFORM_RESOURCE, current),
      authorization: await accessCommandAuthorization(
        access,
        current.actor,
        action,
        PLATFORM_RESOURCE,
        current,
        () => new Error('Denied definition write'),
      ),
    };
  };
  const next = await publishRelease(f.pool, { ...(await options('definitions:publish')), release: nextRelease });
  await activateRelease(f.pool, {
    ...(await options('definitions:activate')),
    releaseDigest: next.digest,
    expectedHead: (await activeRelease(f.pool))!.head,
  });
  expect(next.digest).not.toBe(input.intent.release);

  const before = await f.snapshot([]);
  const originals = new Map<PoolClient, PoolClient['query']>();
  const denyCurrentSource = (client: PoolClient) => {
    if (originals.has(client)) return;
    const query = client.query;
    originals.set(client, query);
    client.query = function (this: PoolClient, ...args: unknown[]) {
      const sql = typeof args[0] === 'string' ? args[0] : ((args[0] as { text?: string })?.text ?? '');
      if (/access\.agent_identity_intent|semantic\.definition_activation|semantic\.subject\b/.test(sql))
        throw new Error('Recovery recursed into current source/release/subject');
      return Reflect.apply(query, this, args);
    } as PoolClient['query'];
  };
  f.pool.on('acquire', denyCurrentSource);
  let recovered;
  try {
    recovered = await readOriginalAccountAgentIdentity(f.pool, selection);
    expect(recovered).not.toBeNull();
    expect(recovered!.input).toEqual(input);
    expect(recovered!.digest).toBe(identityBindingDigest(input));
    expect(recovered!.job).toEqual(admitted.value);
    expect(recovered!.native).toEqual({
      partition: home,
      epoch: admitted.epoch,
      position: admitted.position,
      transactionId: admitted.transactionId,
    });
    expect(recovered!.claim).toMatchObject({
      partition: home,
      key: identityReceiptKey(identityReceipt),
      transactionId: admitted.transactionId,
      generation: '1',
      home,
    });
    expect(recovered!.priorVerification).toBeNull();
    expect(await readOriginalAccountAgentIdentity(f.pool, { ...selection, receipt: randomUUID() })).toBeNull();
    expect(
      await readOriginalAccountAgentIdentity(f.pool, { ...selection, direction: 'account-agent.unverify' }),
    ).toBeNull();
    const verified = await runCommand(f.pool, { partition: home }, async (tx) => {
      expect(await verifyOriginalAccountAgentIdentity(tx, selection, { ...recovered! })).toBe(false);
      expect(await verifyOriginalAccountAgentIdentity(tx, { ...selection, receipt: randomUUID() }, recovered!)).toBe(
        false,
      );
      expect(await verifyOriginalAccountAgentIdentity(tx, selection, { ...recovered!, digest: '0'.repeat(64) })).toBe(
        false,
      );
      return noEffect(await verifyOriginalAccountAgentIdentity(tx, selection, recovered!));
    });
    expect(verified.value).toBe(true);
    expect(verified.transactionId).not.toBe(recovered!.native.transactionId);
    expect(
      (
        await runCommand(f.pool, { partition: home + 1 }, async (tx) =>
          noEffect(await verifyOriginalAccountAgentIdentity(tx, selection, recovered!)),
        )
      ).value,
    ).toBe(false);
  } finally {
    f.pool.off('acquire', denyCurrentSource);
    for (const [client, query] of originals) client.query = query;
  }
  expect(await f.snapshot([])).toEqual(before);

  // A genuine live transaction must still revalidate its local native owner after the released read.
  const fresh = (await readOriginalAccountAgentIdentity(f.pool, selection))!;
  const rollback = new Error('Rollback the negative owner probe');
  await expect(
    runCommand(f.pool, { partition: home }, async (tx) => {
      await tx.query('UPDATE core.partition SET epoch=epoch+1 WHERE partition_no=$1', [home]);
      expect(await verifyOriginalAccountAgentIdentity(tx, selection, fresh)).toBe(false);
      throw rollback;
    }),
  ).rejects.toBe(rollback);
  // A current mapping, decision or old receipt without accepted original custody is unavailable.
  expect(
    await readOriginalAccountAgentIdentity(f.pool, {
      account: accounts.owner,
      direction: 'account-agent.unverify',
      receipt: randomUUID(),
    }),
  ).toBeNull();
  expect(routeOf(accounts.owner)).toBe(route);
});

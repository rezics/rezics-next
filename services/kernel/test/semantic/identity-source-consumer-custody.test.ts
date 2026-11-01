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
  identitySourceConsumerNativeWork,
  isLiveIdentitySourceConsumerMaintenance,
  reserveIdentitySourceConsumerNativeWork,
  withIdentitySourceConsumerMaintenance,
} from '../../src/semantic/identity-source-consumer-maintenance.ts';
import {
  identitySourceConsumerDirectoryPlan,
  readIdentitySourceMaintenanceConfig,
} from '../../src/semantic/identity-source-maintenance-config.ts';
import { approvedVerification, cutoverFixture } from './support/identity-epoch-cutover.ts';
import * as bindingConsumer from '../../src/semantic/identity-epoch-binding.ts';
import {
  readIdentityScopeConsumerWork,
  retainIdentityScopeConsumerFence,
} from '../../src/semantic/identity-scoped-observations.ts';
import type { IdentityPrearmTicketData } from '../../src/semantic/identity-epoch-prearm-contract.ts';
import type { LibraryScopeEffectSeal } from '../../src/library/identity-scope-effects.ts';

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

test('Original native binding and scoped writers serialize terminal Source consumer cuts and retained scope obligations using genuine work admission and owner-native receipts rather than publication or inventory alone', async () => {
  // Required producer delivery remains observable. A missing native implementation
  // must fail this case, rather than be hidden behind an injected test adapter.
  const read = Reflect.get(bindingConsumer, 'readIdentitySourceConsumerWork');
  const lock = Reflect.get(bindingConsumer, 'lockIdentitySourceConsumerCut');
  const verify = Reflect.get(bindingConsumer, 'verifyIdentitySourceConsumerCut');
  expect(read).toBeFunction();
  expect(lock).toBeFunction();
  expect(verify).toBeFunction();
  const before = await originalBytes();
  expect(
    await read(
      f.pool,
      { ...reference, job: { ...reference.job, epoch: reference.job.epoch + 1n } },
      { deadline: Date.now() + 5000 },
    ),
  ).toBeNull();
  const forged = {
    replayGeneration: '9223372036854775807',
    undoGeneration: '9223372036854775807',
    restoreGeneration: '9223372036854775807',
  };
  const rejected = await runCommand(f.pool, { partition: reference.source.partition }, async (tx) => {
    expect(await lock(tx, reference, forged)).toBeNull();
    expect(await verify(tx, reference, forged, 'discharged')).toBeFalse();
    expect(await verify(tx, reference, forged, 'transferred')).toBeFalse();
    return noEffect(null);
  });
  expect(rejected.replayed).toBeFalse();
  expect(await originalBytes()).toBe(before);
});

test('unsupported public scope custody cannot manufacture a native consumer fence from a copied Library seal', async () => {
  const ticket = { scope: { source: { kind: 'public' } } } as unknown as IdentityPrearmTicketData;
  const seal = Object.freeze({}) as LibraryScopeEffectSeal;
  const before = await originalBytes();
  const result = await runCommand(f.pool, { partition: reference.source.partition }, async (tx) =>
    noEffect(await retainIdentityScopeConsumerFence(tx, ticket, seal)),
  );
  expect(result.value).toBeNull();
  expect(await originalBytes()).toBe(before);
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
  let work:
    | import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceWork
    | undefined;
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: process.env }, { deadline }, async (funded) => {
    work = funded.identityConsumerWork;
    expect(isLiveIdentitySourceConsumerMaintenance(f.pool, work, funded.deadline)).toBe(true);
    expect(identitySourceConsumerLibraryWork(f.pool, work, funded.deadline)).toBeDefined();
    expect(
      reserveIdentitySourceConsumerNativeWork(f.pool, work, {
        rows: 1,
        points: 1,
        statements: 1,
        bytes: 1,
        engineRequests: 0,
      }),
    ).toBe(true);
  });
  expect(isLiveIdentitySourceConsumerMaintenance(f.pool, work, deadline)).toBe(false);
  let checkouts = 0;
  const pool = {
    connect: () => {
      checkouts++;
      throw new Error('unexpected Source checkout');
    },
  } as unknown as Pool;
  expect(await readIdentitySourceConsumerCustody(pool, reference, { deadline: Date.now() + 5000 })).toBeNull();
  expect(checkouts).toBe(0);
});

test('History-sized Source funding preserves the directory child bounds and refuses an underfunded real Source read before checkout', async () => {
  const configured = readIdentitySourceMaintenanceConfig({});
  expect(configured.native).toEqual({
    rows: 577,
    points: 577,
    statements: 173,
    bytes: 630784,
    engineRequests: 0,
  });
  expect(identitySourceConsumerDirectoryPlan(configured.native)).toEqual({
    envelope: { rows: 100, points: 200, statements: 36, bytes: 229376, engineRequests: 0 },
    child: { rows: 50, points: 100, statements: 18, bytes: 114688, engineRequests: 0 },
  });
  expect(
    identitySourceConsumerDirectoryPlan({
      rows: 60,
      points: 140,
      statements: 20,
      bytes: 170000,
      engineRequests: 0,
    }),
  ).toEqual({
    envelope: { rows: 60, points: 140, statements: 20, bytes: 170000, engineRequests: 0 },
    child: { rows: 30, points: 70, statements: 10, bytes: 85000, engineRequests: 0 },
  });

  let checkouts = 0;
  const pool = {
    connect: () => {
      checkouts++;
      throw new Error('underfunded Source work must refuse before checkout');
    },
  } as unknown as Pool;
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance(
    { pool, env: { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ROWS: '31' } },
    { deadline },
    async (funded) => {
      expect(await readIdentitySourceConsumerCustody(pool, reference, funded)).toBeNull();
    },
  );
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
  let work:
    | import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceWork
    | undefined;
  const deadline = Date.now() + 5000;
  const failure = new Error('maintenance callback failed');
  await expect(
    withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
      work = funded.identityConsumerWork;
      const library = identitySourceConsumerLibraryWork(f.pool, work, deadline);
      expect(library).not.toBeNull();
      expect(reserveIdentitySourceConsumerNativeWork(f.pool, work, configured.native)).toBe(true);
      await Promise.resolve();
      expect(identitySourceConsumerLibraryWork(f.pool, work, deadline)).toBe(library);
      expect(
        reserveIdentitySourceConsumerNativeWork(f.pool, work, {
          rows: 1,
          points: 0,
          statements: 0,
          bytes: 0,
          engineRequests: 0,
        }),
      ).toBe(false);
      expect(library?.available('nativeRows')).toBe(configured.library.nativeRows);
      throw failure;
    }),
  ).rejects.toBe(failure);
  if (!work) throw new Error('Source maintenance did not enter its callback');
  expect(isLiveIdentitySourceConsumerMaintenance(f.pool, work, deadline)).toBe(false);
  expect(identitySourceConsumerLibraryWork(f.pool, work, deadline)).toBeNull();
  expect(
    await readIdentitySourceConsumerCustody(f.pool, reference, {
      deadline,
      identityConsumerWork: work,
    }),
  ).toBeNull();
});

test('Source consumer refuses copied foreign expired and ended frames before checkout', async () => {
  let checkouts = 0;
  const pool = {
    connect: () => {
      checkouts++;
      throw new Error('unexpected Source checkout');
    },
  } as unknown as Pool;
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    expect(await readIdentitySourceConsumerCustody(pool, reference, funded)).toBeNull();
    expect(
      await readIdentitySourceConsumerCustody(pool, reference, {
        ...funded,
        identityConsumerWork: { ...funded.identityConsumerWork },
      }),
    ).toBeNull();
  });
  let ended:
    | import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceContext
    | undefined;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    ended = funded;
    expect(
      await readIdentitySourceConsumerCustody(pool, reference, {
        ...funded,
        deadline: Date.now() - 1,
      }),
    ).toBeNull();
  });
  expect(ended).toBeDefined();
  expect(await readIdentitySourceConsumerCustody(pool, reference, ended!)).toBeNull();
  expect(checkouts).toBe(0);
});

test('accepted Account binding lookup preserves native input and job without minting admission source custody', async () => {
  const accepted = await readAccountIdentityUndo(f.pool, {
    kind: 'account-agent.verify',
    account: reference.receipt.account,
    receipt: reference.receipt.receipt,
  });
  const before = await originalBytes();
  await runCommand(f.pool, { partition: reference.source.partition }, async (tx) => {
    const binding = await bindingConsumer.readAcceptedAccountIdentityBinding(tx, accepted.source.input);
    expect(binding).not.toBeNull();
    const data = bindingConsumer.identityBindingData(binding!);
    expect(data.state).toBe('accepted');
    expect(data.digest).toBe(accepted.source.digest);
    expect(data.job).toEqual(accepted.job);
    expect(() => bindingConsumer.assertIdentityBindingSource(binding!, accepted.source.input.receipt)).toThrow(
      'Missing released Accounts source custody',
    );
    expect(bindingConsumer.identityBindingAccountRoles(binding!)).toEqual([]);
    return noEffect(null);
  });
  expect(await originalBytes()).toBe(before);
});

test('accepted Account binding lookup rejects another home receipt or immutable input before effects', async () => {
  const accepted = await readAccountIdentityUndo(f.pool, {
    kind: 'account-agent.verify',
    account: reference.receipt.account,
    receipt: reference.receipt.receipt,
  });
  const input = accepted.source.input;
  const before = await originalBytes();
  await runCommand(f.pool, { partition: (reference.source.partition + 1) % 4096 }, async (tx) => {
    expect(await bindingConsumer.readAcceptedAccountIdentityBinding(tx, input)).toBeNull();
    return noEffect(null);
  });
  await runCommand(f.pool, { partition: reference.source.partition }, async (tx) => {
    expect(
      await bindingConsumer.readAcceptedAccountIdentityBinding(tx, {
        ...input,
        receipt: { ...input.receipt, receipt: randomUUID() },
      }),
    ).toBeNull();
    expect(
      await bindingConsumer.readAcceptedAccountIdentityBinding(tx, {
        ...input,
        intent: { ...input.intent, release: `${input.intent.release}:changed` },
      }),
    ).toBeNull();
    expect(
      await bindingConsumer.readAcceptedAccountIdentityBinding(tx, {
        ...input,
        receipt: { ...input.receipt, kind: 'account-agent.unverify' },
      }),
    ).toBeNull();
    return noEffect(null);
  });
  expect(await originalBytes()).toBe(before);
});

test('native consumer generations use retained original provenance and debit the live Source frame before directory planning', async () => {
  const before = await originalBytes();
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline: Date.now() + 5000 }, (funded) =>
    readIdentitySourceConsumerCustody(f.pool, reference, funded),
  );
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async (funded) => {
      const initial = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, funded.deadline)!;
      const observed = await bindingConsumer.readIdentitySourceConsumerWork(f.pool, reference, funded);
      expect(observed).not.toBeNull();
      const balance = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, funded.deadline)!;
      expect(initial.rows - balance.rows).toBe(13);
      expect(initial.points - balance.points).toBe(13);
      expect(initial.statements - balance.statements).toBe(10);
      expect(initial.bytes - balance.bytes).toBe(16384);
      expect(observed!.allowance.rows).toBe(balance.rows - 4);
      expect(observed!.allowance.statements).toBe(balance.statements - 6);
      const native = (
        await f.admin.query(
          `SELECT b.generation::text AS replay,b.consumer_undo_generation::text AS undo,n.epoch::text AS restore
         FROM semantic.identity_epoch_receipt_binding b
         JOIN semantic.identity_epoch_receipt_claim_commit k USING(partition_no,receipt_key,generation)
         JOIN semantic.identity_epoch_native_commit n ON n.partition_no=k.partition_no AND n.transaction_id=k.transaction_id
         WHERE b.partition_no=$1 AND b.receipt_key=$2`,
          [
            reference.source.partition,
            JSON.stringify([reference.receipt.kind, reference.receipt.account, reference.receipt.receipt]),
          ],
        )
      ).rows[0];
      expect(observed!.replayGeneration).toBe(native.replay);
      expect(observed!.undoGeneration).toBe(native.undo);
      expect(observed!.restoreGeneration).toBe(native.restore);
      await runCommand(f.pool, { partition: reference.source.partition }, async (tx) => {
        // Publication and retained directory inventory cannot discharge the live undo input.
        expect(await bindingConsumer.lockIdentitySourceConsumerCut(tx, reference, observed!)).toBe('transferred');
        expect(
          await bindingConsumer.verifyIdentitySourceConsumerCut(tx, reference, observed!, 'discharged'),
        ).toBeFalse();
        return noEffect(null);
      });
    },
  );
  expect(await originalBytes()).toBe(before);
});

test('both original work readers reject absent copied foreign ended or exhausted funding before a Source probe', async () => {
  let checkouts = 0;
  const pool = {
    connect: () => {
      checkouts++;
      throw new Error('unfunded checkout');
    },
  } as unknown as Pool;
  const ticket = { scope: { source: { kind: 'public' } } } as unknown as IdentityPrearmTicketData;
  const deadline = Date.now() + 5000;
  expect(await bindingConsumer.readIdentitySourceConsumerWork(pool, reference, { deadline })).toBeNull();
  expect(await readIdentityScopeConsumerWork(pool, ticket, { deadline })).toBeNull();
  let ended:
    | import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceContext
    | undefined;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    ended = funded;
    const copied = { ...funded, identityConsumerWork: { ...funded.identityConsumerWork } };
    for (const invalid of [copied, { ...funded, deadline: Date.now() - 1 }]) {
      expect(await bindingConsumer.readIdentitySourceConsumerWork(pool, reference, invalid)).toBeNull();
      expect(await readIdentityScopeConsumerWork(pool, ticket, invalid)).toBeNull();
    }
    expect(await bindingConsumer.readIdentitySourceConsumerWork(f.pool, reference, funded)).toBeNull();
    expect(await readIdentityScopeConsumerWork(f.pool, ticket, funded)).toBeNull();
    expect(
      reserveIdentitySourceConsumerNativeWork(
        pool,
        funded.identityConsumerWork,
        readIdentitySourceMaintenanceConfig({}).native,
      ),
    ).toBeTrue();
    expect(await bindingConsumer.readIdentitySourceConsumerWork(pool, reference, funded)).toBeNull();
  });
  expect(await bindingConsumer.readIdentitySourceConsumerWork(pool, reference, ended!)).toBeNull();
  expect(await readIdentityScopeConsumerWork(pool, ticket, ended!)).toBeNull();
  expect(checkouts).toBe(0);
});

test('The original Source owner durably guards exact History readiness and closure handoff under current same-home source and SDK fences with bounded single-frame accounting', async () => {
  const { newId } = await import('../../src/route/route.ts');
  const { createRealAccess } = await import('./real-access.ts');
  const { bootstrapGovernance, PLATFORM_RESOURCE } = await import('../../src/access/bootstrap-governance.ts');
  const { createAgentVerificationCommands, readAgentVerificationWorkflowRequest, recordPendingAgentVerification } =
    await import('../../src/access/agent-verification.ts');
  const { lockIdentitySourceHistoryAuthority, lockIdentitySourceHistoryHandoff, IDENTITY_SOURCE_HISTORY_GUARD_COST } =
    await import('../../src/semantic/identity-source-consumer-custody.ts');
  const { readAgentIdentityRetirementStage } = await import('../../src/history/agent-identity-retirement.ts');
  const { readAgentIdentitySDKReceivingBinding } = await import('../../src/history/agent-identity-sdk-fence.ts');
  const { enqueueAgentIdentityVerification } = await import('../../src/history/agent-identity-work.ts');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { readSdkWorkflowWriterState } = await import('../../src/work/sdk-retirement-fence.ts');
  // Genuine co-home Accounts source, native decision, accepted job and original SDK
  // association. No Source terminal, Account settlement or Library seal is fabricated.
  const accounts = { person: newId(1), staff: newId(2) };
  const actions = ['account:update', 'account:verify_agent'];
  const real = await createRealAccess(f.admin, accounts, actions);
  const access = real.access({ actions: new Map(actions.map((action) => [action, { anonymous: false }])) });
  await bootstrapGovernance(f.pool, accounts.staff);
  await real.grant({ route: 1, id: accounts.person }, 'person', 'account:update');
  await real.grant(PLATFORM_RESOURCE, 'staff', 'account:verify_agent');
  const context = async (persona: 'person' | 'staff') => ({
    pool: f.pool,
    deadline: Date.now() + 5000,
    actor: await access.authenticate(real.bearer(persona), { pool: f.pool, deadline: Date.now() + 5000 }),
  });
  const commands = createAgentVerificationCommands({ pool: f.pool, access, clock: () => new Date() });
  const catalogue = (await f.create('History Source native guard')).subject.id;
  const requested = await commands.request(await context('person'), {
    accountId: accounts.person,
    subject: catalogue,
    statement: 'This is my catalogue identity',
    links: [],
    key: randomUUID(),
  });
  const decided = await commands.approve(await context('staff'), { requestId: requested.value.id, key: randomUUID() });
  const saved = await readAgentVerificationWorkflowRequest(f.pool, requested.value.id);
  if (!saved?.decisionReceiptId) throw new Error('Expected actual original decision');
  if (!decided.value.decisionReceiptId) throw new Error('Expected committed decision receipt');
  expect(saved.decisionReceiptId).toBe(decided.value.decisionReceiptId);
  const workflow = { ...saved, receiptId: saved.decisionReceiptId };
  await recordPendingAgentVerification(f.pool, workflow, () => new Date());
  await ensureAccountAgent(f.pool, { account: accounts.person, kind: 'person', name: null });
  await mergeVerifiedAgent(f.pool, workflow);
  const receipt = { kind: 'account-agent.verify' as const, account: accounts.person, receipt: workflow.receiptId };
  const accepted = await readAccountIdentityUndo(f.pool, receipt);
  const erased = (
    await f.admin.query(
      'INSERT INTO access.erasure(route,account_id,version,at) VALUES(1,$1,1,now()) RETURNING at::text',
      [accounts.person],
    )
  ).rows[0];
  const original: IdentitySourceConsumerReference = {
    receipt,
    job: accepted.job,
    source: {
      partition: accepted.source.partition,
      epoch: accepted.source.epoch,
      position: accepted.source.position,
      transactionId: accepted.source.transactionId,
    },
    sourceDigest: accepted.source.digest,
    erasedRole: 'subject',
    barrier: { accountId: accounts.person, accountRoute: 1, version: 1, at: erased.at },
  };
  expect(original.source.partition).toBe(0);
  const deadline = Date.now() + 20_000;
  const native = (ref = original, expected = null) =>
    runCommand(f.pool, { partition: 0, deadline }, async (tx) =>
      noEffect(await lockIdentitySourceHistoryAuthority(tx, ref, expected)),
    ).then((result) => result.value);
  expect(await native()).toBeNull(); // no live frame
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    // Real default Source preparation retains the obligation. Publication and a
    // receiver association do not invent the missing real consumer discharge.
    expect(await readIdentitySourceConsumerCustody(f.pool, original, funded)).toBeNull();
  });
  // A separate invocation tests repeated guarded reads. It does not replenish the
  // preparation invocation or fund any continuation of that earlier operation.
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    const balance = () => identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline)!;
    for (const ref of [
      original,
      { ...original, sourceDigest: '0'.repeat(64) },
      { ...original, source: { ...original.source, position: original.source.position + 1n } },
      { ...original, source: { ...original.source, epoch: original.source.epoch + 1 } },
      { ...original, job: { ...original.job, epoch: original.job.epoch + 1n } },
      { ...original, barrier: { ...original.barrier, version: 2 } },
      { ...original, erasedRole: 'decider' as const },
    ]) {
      const before = balance();
      expect(await native(ref)).toBeNull();
      // Each missing/stale native lookup is charged before dispatch; repeated
      // failures receive neither refunds nor a cached verdict.
      expect(balance()).toEqual({
        rows: before.rows - IDENTITY_SOURCE_HISTORY_GUARD_COST.rows,
        points: before.points - IDENTITY_SOURCE_HISTORY_GUARD_COST.points,
        statements: before.statements - IDENTITY_SOURCE_HISTORY_GUARD_COST.statements,
        bytes: before.bytes - IDENTITY_SOURCE_HISTORY_GUARD_COST.bytes,
        engineRequests: 0,
      });
    }
  });
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: { KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS: '1' } },
    { deadline },
    async (funded) => {
      const before = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline);
      expect(await native()).toBeNull();
      expect(identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline)).toEqual(before);
    },
  );
  const client = await createWorkClient(f.pool.options.connectionString!, f.pool);
  try {
    await client.registerQueue('workflows', {});
    expect(await enqueueAgentIdentityVerification(f.pool, client, requested.value.id, workflow.receiptId)).toBe(
      'admitted',
    );
    const stage = await readAgentIdentityRetirementStage(f.pool, original, { deadline });
    if (!stage) throw new Error('Expected genuine original source association');
    const receiving = (
      await runCommand(f.pool, { partition: 0, deadline }, async (tx) =>
        noEffect(
          await readAgentIdentitySDKReceivingBinding(
            tx,
            {
              partition: 0,
              locator: { artifactType: 'durable-work/v1', workId: stage.handoff.custodyId },
              accounts: stage.handoff.source.accounts,
            },
            original.barrier,
          ),
        ),
      )
    ).value;
    if (receiving.state !== 'observed') throw new Error('Expected genuine original receiver');
    const writer = await readSdkWorkflowWriterState(stage.handoff.source.workflowId, client);
    if (!writer) throw new Error('Expected original SDK writer state');
    await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
      const call = (
        binding = receiving.binding,
        expectedWriter = writer,
        phase: 'readiness' | 'closure' = 'readiness',
      ) =>
        runCommand(f.pool, { partition: 0, deadline }, async (tx) =>
          noEffect(await lockIdentitySourceHistoryHandoff(tx, stage, binding, expectedWriter, phase, client)),
        ).then((result) => result.value);
      expect(await call()).toEqual({ state: 'pending', gap: 'identity-source-consumer-custody-pending' });
      const before = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline);
      for (const binding of [
        { ...receiving.binding, custodyId: randomUUID() },
        { ...receiving.binding, barrier: { ...original.barrier, version: 2 } },
        { ...receiving.binding, receiver: { ...receiving.binding.receiver, generation: randomUUID() } },
      ])
        expect((await call(binding)).state).toBe('pending');
      expect((await call(receiving.binding, { ...writer, workflowID: randomUUID() })).state).toBe('pending');
      expect((await call(receiving.binding, writer, 'closure')).state).toBe('pending');
      expect(identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline)).toEqual(before);
    });
    expect((await client.getWorkflowWriterState(writer.workflowID))?.generation).toBe('1');
    expect(
      (
        await f.admin.query('SELECT owner_ready,absence_verified,state FROM core.history_work WHERE work_id=$1', [
          stage.handoff.custodyId,
        ])
      ).rows,
    ).toEqual([{ owner_ready: false, absence_verified: false, state: 'pending' }]);
  } finally {
    await client.close();
  }
}, 60_000);

test('independent Source verification prepays its complete nested body on every entry and refuses an insufficient frame before SQL', async () => {
  const { spyOn } = await import('bun:test');
  const { IDENTITY_SOURCE_CONSUMER_VERIFY_COST } =
    await import('../../src/semantic/identity-source-consumer-custody.ts');
  // A copied object grants no authority. It still consumes the full admitted
  // verification reservation, rather than benefiting from the History wrapper's
  // reservation or a previous miss. No native verdict is injected here.
  const copied = Object.freeze({}) as IdentitySourceConsumerCustody;
  const deadline = Date.now() + 10_000;
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    const balance = () => identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline)!;
    await runCommand(f.pool, { partition: reference.source.partition, deadline }, async (tx) => {
      const queries = spyOn(tx, 'query');
      try {
        for (let attempt = 0; attempt < 3; attempt++) {
          const before = balance();
          expect(await verifyIdentitySourceConsumerCustody(tx, reference, copied)).toBe(false);
          expect(balance()).toEqual({
            rows: before.rows - 100,
            points: before.points - 100,
            statements: before.statements - 22,
            bytes: before.bytes - 139264,
            engineRequests: 0,
          });
        }
        expect(queries).not.toHaveBeenCalled();
      } finally {
        queries.mockRestore();
      }
      return noEffect(null);
    });
  });
  // Every axis must fund the native body before its first SQL statement. This
  // includes direct initial/post-commit callers, outside the composed History H.
  for (const [axis, available] of [
    ['ROWS', IDENTITY_SOURCE_CONSUMER_VERIFY_COST.rows - 1],
    ['POINTS', IDENTITY_SOURCE_CONSUMER_VERIFY_COST.points - 1],
    ['STATEMENTS', IDENTITY_SOURCE_CONSUMER_VERIFY_COST.statements - 1],
    ['BYTES', IDENTITY_SOURCE_CONSUMER_VERIFY_COST.bytes - 1],
  ] as const) {
    await withIdentitySourceConsumerMaintenance(
      { pool: f.pool, env: { [`KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_${axis}`]: String(available) } },
      { deadline },
      async (funded) => {
        const before = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline);
        await runCommand(f.pool, { partition: reference.source.partition, deadline }, async (tx) => {
          const queries = spyOn(tx, 'query');
          try {
            expect(await verifyIdentitySourceConsumerCustody(tx, reference, copied)).toBe(false);
            expect(queries).not.toHaveBeenCalled();
          } finally {
            queries.mockRestore();
          }
          return noEffect(null);
        });
        expect(identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, deadline)).toEqual(before);
      },
    );
  }
});

import { afterAll, beforeAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import type { Pool } from 'pg';
import { mergeVerifiedAgent } from '../../src/access/agent-verification.ts';
import { noEffect, runCommand } from '../../src/command/command.ts';
import { verifyAgentIdentityRecoveryArtifactReadiness } from '../../src/history/agent-identity-recovery-receiving.ts';
import {
  IdentityHistoryWorkUnavailable,
  identityHistoryCommand,
  nativeWork,
  reserveIdentityHistoryWork,
} from '../../src/history/agent-identity-inventory-work.ts';
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
  activeIdentitySourceConsumerMaintenance,
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

test('Complete original-frame History accounting refuses implicit wrong-Pool expired settled copied or exhausted Source authority before IO while preserving original cumulative failure and repeat charging and genuine independently funded owner admission through real callers', async () => {
  const { spyOn } = await import('bun:test');
  const cost = nativeWork(1, 1, 1, 1);
  let foreignCheckouts = 0;
  const foreignPool = {
    connect() {
      foreignCheckouts++;
      throw new Error('foreign Source Pool checkout sentinel');
    },
  } as unknown as Pool;
  const deadline = Date.now() + 5000;
  let ended:
    | import('../../src/semantic/identity-source-consumer-maintenance.ts').IdentitySourceConsumerMaintenanceContext
    | undefined;

  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    ended = funded;
    expect(activeIdentitySourceConsumerMaintenance(f.pool)).toEqual(funded);
    const before = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, funded.deadline)!;
    await reserveIdentityHistoryWork(f.pool, cost);
    const after = identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, funded.deadline)!;
    expect(after).toEqual({
      rows: before.rows - 1,
      points: before.points - 1,
      statements: before.statements - 1,
      bytes: before.bytes - 1,
      engineRequests: before.engineRequests,
    });
    await expect(reserveIdentityHistoryWork(foreignPool, cost)).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
    await expect(
      reserveIdentityHistoryWork(f.pool, cost, {
        ...funded,
        identityConsumerWork: { ...funded.identityConsumerWork },
      }),
    ).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
    await expect(reserveIdentityHistoryWork(foreignPool, cost, funded)).rejects.toBeInstanceOf(
      IdentityHistoryWorkUnavailable,
    );
    await expect(
      reserveIdentityHistoryWork(f.pool, cost, {
        deadline: funded.deadline,
        identityConsumerWork: undefined as unknown as typeof funded.identityConsumerWork,
      }),
    ).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
  });
  await expect(reserveIdentityHistoryWork(f.pool, cost, ended!)).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
  expect(foreignCheckouts).toBe(0);

  for (const [axis, property, value] of [
    ['ROWS', 'rows', 1],
    ['POINTS', 'points', 1],
    ['STATEMENTS', 'statements', 1],
    ['BYTES', 'bytes', 1],
    ['ENGINE_REQUESTS', 'engineRequests', 0],
  ] as const) {
    let checkouts = 0;
    const pool = {
      connect() {
        checkouts++;
        throw new Error(`${axis} exhausted checkout sentinel`);
      },
    } as unknown as Pool;
    await withIdentitySourceConsumerMaintenance(
      {
        pool,
        env: { [`KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_${axis}`]: String(value) },
      },
      { deadline },
      async () => {
        const amount = { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 };
        amount[property] = 2;
        await expect(reserveIdentityHistoryWork(pool, amount)).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
      },
    );
    expect(checkouts).toBe(0);
  }

  let expiredCheckouts = 0;
  const expiredPool = {
    connect() {
      expiredCheckouts++;
      throw new Error('expired Source checkout sentinel');
    },
  } as unknown as Pool;
  const expiringDeadline = Date.now() + 20;
  await withIdentitySourceConsumerMaintenance(
    { pool: expiredPool, env: {} },
    { deadline: expiringDeadline },
    async () => {
      await new Promise<void>((resolve) => setTimeout(resolve, 30));
      expect(activeIdentitySourceConsumerMaintenance(expiredPool)?.deadline).toBe(expiringDeadline);
      await expect(reserveIdentityHistoryWork(expiredPool, cost)).rejects.toBeInstanceOf(
        IdentityHistoryWorkUnavailable,
      );
    },
  );
  expect(expiredCheckouts).toBe(0);

  let settledCheckouts = 0;
  const settledPool = {
    connect() {
      settledCheckouts++;
      throw new Error('settled Source checkout sentinel');
    },
  } as unknown as Pool;
  let detached!: Promise<void>;
  await withIdentitySourceConsumerMaintenance(
    { pool: settledPool, env: {} },
    { deadline: Date.now() + 5000 },
    async (funded) => {
      detached = new Promise<void>((resolve) => setTimeout(resolve, 0)).then(async () => {
        expect(activeIdentitySourceConsumerMaintenance(settledPool)).toEqual(funded);
        await reserveIdentityHistoryWork(settledPool, cost);
      });
    },
  );
  await expect(detached).rejects.toBeInstanceOf(IdentityHistoryWorkUnavailable);
  expect(settledCheckouts).toBe(0);

  const rollbackBudget = {
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_ROWS: '3',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_POINTS: '1',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_STATEMENTS: '8',
    KERNEL_IDENTITY_SOURCE_MAINTENANCE_NATIVE_BYTES: '256',
  };
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: rollbackBudget },
    { deadline: Date.now() + 10_000 },
    async (funded) => {
      const failure = new Error('rollback must not refund History work');
      await expect(identityHistoryCommand(f.pool, funded, async () => Promise.reject(failure))).rejects.toBe(failure);
      expect(identitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, funded.deadline)).toEqual({
        rows: 0,
        points: 0,
        statements: 0,
        bytes: 0,
        engineRequests: 0,
      });
      const checkout = spyOn(f.pool, 'connect');
      try {
        await expect(identityHistoryCommand(f.pool, funded, async () => null)).rejects.toBeInstanceOf(
          IdentityHistoryWorkUnavailable,
        );
        expect(checkout).not.toHaveBeenCalled();
      } finally {
        checkout.mockRestore();
      }
    },
  );

  // This real History owner call has no Source ALS frame. Its live native command
  // and exact command resources remain its admission; absence alone is not used as
  // evidence for this path.
  expect(activeIdentitySourceConsumerMaintenance(f.pool)).toBeNull();
  const artifact = {
    partition: reference.source.partition,
    locator: {
      artifactType: 'command-receipt/v1' as const,
      partitionNo: reference.source.partition,
      principalKind: 'account' as const,
      principalId: reference.receipt.account,
      commandKindId: 1,
      keyVersion: 0,
      keyToken: '0'.repeat(64),
    },
    accounts: [],
  };
  const independent = await runCommand(f.pool, { partition: reference.source.partition }, async (tx) => {
    expect(activeIdentitySourceConsumerMaintenance(f.pool)).toBeNull();
    return noEffect(await verifyAgentIdentityRecoveryArtifactReadiness(tx, artifact, undefined, f.pool));
  });
  expect(independent.value).toEqual({ state: 'not-recovery' });
});

test('one Source Library remainder cumulatively pays the page receiving and both independent seal checks', async () => {
  const { withIdentitySourceConsumerLibraryRemainder, currentIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async (funded) => {
      const ledger = identitySourceConsumerLibraryWork(f.pool, funded.identityConsumerWork, funded.deadline)!;
      const amount = (
        rows: number,
        statements: number,
      ): import('../../src/library/collection-source.ts').WorkDimensions => ({
        candidateKeys: 0,
        identityMetadataRows: 0,
        nativeRows: rows,
        nativePoints: rows,
        witnessKeys: 0,
        statements,
        bytes: rows * 1024,
        emptySeeks: 0,
      });
      const plan = { reservationId: ledger.receipt().reservationId, remaining: amount(6, 8) };
      const charge = (rows: number, statements: number) => {
        const operation = ledger.reserve(amount(rows, statements));
        operation.dispatch();
        operation.settle();
      };
      await withIdentitySourceConsumerLibraryRemainder(
        f.pool,
        funded.identityConsumerWork,
        funded.deadline,
        plan,
        async (same) => {
          expect(same).toBe(ledger);
          expect(currentIdentitySourceConsumerLibraryRemainder(f.pool, funded.deadline)).toBe(ledger);
          await ledger.compose(async (allowance) => ({
            work: { reservationId: allowance.reservationId, used: amount(2, 2) },
          }));
          charge(2, 2); // Receiving work.
          charge(1, 1); // Per-page current check.
          charge(1, 1); // Independent exhausted-page fence check, including sealed zero.
          expect(() => charge(1, 1)).toThrow();
          expect(ledger.receipt().used.nativeRows).toBe(6);
          expect(ledger.receipt().used.statements).toBe(6);
          expect(ledger.receipt().reservationId).toBe(plan.reservationId);
          expect(identitySourceConsumerLibraryWork(f.pool, funded.identityConsumerWork, funded.deadline)).toBe(ledger);
          // Native Source terminal work remains in its own units on this SAME frame.
          expect(
            reserveIdentitySourceConsumerNativeWork(f.pool, funded.identityConsumerWork, {
              rows: 1,
              points: 1,
              statements: 1,
              bytes: 1024,
              engineRequests: 0,
            }),
          ).toBeTrue();
        },
      );
      expect(currentIdentitySourceConsumerLibraryRemainder(f.pool, funded.deadline)).toBeNull();
      expect(ledger.receipt().used.nativeRows).toBe(6);
    },
  );
});

/** Accounting transport only: this supplies no Library seal, Source or receiving proof. */
async function accountingTransport(failSQL?: string) {
  const { EventEmitter } = await import('node:events');
  const dispatched: string[] = [];
  const client = {
    query: (sql: string) => {
      dispatched.push(sql);
      if (sql === failSQL) return Promise.reject(new Error('dispatched accounting failure'));
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  } as unknown as import('pg').PoolClient;
  const pool = Object.assign(new EventEmitter(), {
    connect: async () => {
      pool.emit('acquire', client);
      return client;
    },
  }) as unknown as Pool;
  return { pool, dispatched };
}

test('unknown SQL cannot hide behind a transferred Library local ledger and rollback stays funded', async () => {
  const { NativeCollectionWork, instrumentNativeCollectionWork, requireNativeCollectionFootprint } =
    await import('../../src/library/collection-source-work.ts');
  const { withIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { pool, dispatched } = await accountingTransport();
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, deadline)!;
    const remaining = {
      candidateKeys: 0,
      identityMetadataRows: 0,
      nativeRows: 5,
      nativePoints: 6,
      witnessKeys: 0,
      statements: 5,
      bytes: 8192,
      emptySeeks: 0,
    };
    const allowance = { reservationId: ledger.receipt().reservationId, remaining };
    const bound = { ...remaining, nativeRows: 1, nativePoints: 0, statements: 1, bytes: 128 };
    await expect(
      withIdentitySourceConsumerLibraryRemainder(pool, funded.identityConsumerWork, deadline, allowance, async () =>
        ledger.compose(async (child) => {
          const local = new NativeCollectionWork(child, deadline);
          return requireNativeCollectionFootprint(
            pool,
            ledger,
            (sql) =>
              ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'SELECT 1', 'COMMIT', 'ROLLBACK'].includes(sql)
                ? bound
                : undefined,
            () =>
              instrumentNativeCollectionWork(
                pool,
                local,
                () => bound,
                async () => {
                  const tx = await pool.connect();
                  await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
                  await tx.query('SELECT 1');
                  try {
                    await tx.query('SELECT 2'); // Even a permissive local producer cannot admit it.
                  } finally {
                    await tx.query('ROLLBACK');
                  }
                  return { work: local.receipt() };
                },
              ),
          );
        }),
      ),
    ).rejects.toThrow();
    expect(dispatched).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'SELECT 1', 'ROLLBACK']);
    expect(ledger.receipt().used).toEqual(remaining); // An incomplete child never refunds the transfer.
    expect(() => ledger.assertReady()).toThrow();
  });
});

test('held terminal work and failed dispatched SQL consume the cumulative planned remainder', async () => {
  const { instrumentNativeCollectionWork } = await import('../../src/library/collection-source-work.ts');
  const { withIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { pool, dispatched } = await accountingTransport('SELECT 1');
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, deadline)!;
    const zero = {
      candidateKeys: 0,
      identityMetadataRows: 0,
      nativeRows: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
      emptySeeks: 0,
    };
    const allowance = {
      reservationId: ledger.receipt().reservationId,
      remaining: { ...zero, nativeRows: 1, nativePoints: 1, statements: 4, bytes: 512 },
    };
    await withIdentitySourceConsumerLibraryRemainder(pool, funded.identityConsumerWork, deadline, allowance, async () =>
      instrumentNativeCollectionWork(
        pool,
        ledger,
        (sql) => ({ ...zero, nativeRows: sql === 'SELECT 1' ? 1 : 0, statements: 1, bytes: 128 }),
        async () => {
          const tx = await pool.connect();
          await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
          expect(ledger.available('statements')).toBe(1); // Both terminal alternatives are already held.
          await expect(tx.query('SELECT 1')).rejects.toThrow('dispatched accounting failure');
          expect(ledger.available('statements')).toBe(0);
          await tx.query('ROLLBACK');
          expect(ledger.available('statements')).toBe(1); // Undispatched COMMIT alone was cancelled.
        },
      ),
    );
    expect(dispatched).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'SELECT 1', 'ROLLBACK']);
    expect(ledger.receipt().used).toEqual({ ...allowance.remaining, statements: 3, bytes: 384 });
  });
});

test('a planned Library remainder rejects foreign identity and cannot escape its live callback', async () => {
  const { withIdentitySourceConsumerLibraryRemainder, currentIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool: f.pool, env: {} }, { deadline }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(f.pool, funded.identityConsumerWork, deadline)!;
    const remaining = {
      candidateKeys: 0,
      identityMetadataRows: 0,
      nativeRows: 1,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 1024,
      emptySeeks: 0,
    };
    let entered = false;
    await expect(
      withIdentitySourceConsumerLibraryRemainder(
        f.pool,
        funded.identityConsumerWork,
        deadline,
        { reservationId: 'foreign', remaining },
        async () => {
          entered = true;
        },
      ),
    ).rejects.toThrow('Foreign source work reservation');
    expect(entered).toBeFalse();
    let escaped: Promise<void> | undefined;
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    await withIdentitySourceConsumerLibraryRemainder(
      f.pool,
      funded.identityConsumerWork,
      deadline,
      { reservationId: ledger.receipt().reservationId, remaining },
      async () => {
        escaped = gate.then(() => {
          expect(() => currentIdentitySourceConsumerLibraryRemainder(f.pool, deadline)).toThrow();
          expect(() => ledger.reserve(remaining)).toThrow();
        });
      },
    );
    release();
    await escaped;
    expect(ledger.receipt().used.nativeRows).toBe(0);
  });
});

test('an undispatched reservation and nested remainder cannot outlive their original plan', async () => {
  const { NativeCollectionWork } = await import('../../src/library/collection-source-work.ts');
  const remaining = {
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 1024,
    emptySeeks: 0,
  };
  const allowance = { reservationId: randomUUID(), remaining };
  const ledger = new NativeCollectionWork(allowance, Date.now() + 5000);
  let held: ReturnType<typeof ledger.reserve> | undefined;
  await ledger.withinAllowance(allowance, async () => {
    held = ledger.reserve(remaining);
  });
  expect(() => held!.dispatch()).toThrow();
  expect(ledger.receipt().used.nativeRows).toBe(0); // It never dispatched.
  expect(ledger.available('nativeRows')).toBe(1);

  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let nested: Promise<void> | undefined;
  await ledger.withinAllowance(allowance, async () => {
    nested = ledger.withinAllowance(allowance, async () => {
      await gate;
      expect(() => ledger.reserve(remaining)).toThrow();
    });
    // Attach rejection handling before releasing the parent callback.
    void nested.catch(() => undefined);
  });
  release();
  await expect(nested!).rejects.toThrow();
  expect(ledger.receipt().used.nativeRows).toBe(0);
});

test('Source callback return permanently closes escaped ledger handles and cannot mint a nested original or deadline', async () => {
  const { pool, dispatched } = await accountingTransport();
  const escaped: { ledger?: import('../../src/library/collection-source-work.ts').NativeCollectionWork } = {};
  let held:
    | ReturnType<import('../../src/library/collection-source-work.ts').NativeCollectionWork['reserve']>
    | undefined;
  const deadline = Date.now() + 5000;
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    escaped.ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, deadline)!;
    expect(funded.deadline).toBe(deadline);
    expect(isLiveIdentitySourceConsumerMaintenance(pool, funded.identityConsumerWork, deadline + 1)).toBeFalse();
    expect(() =>
      withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: deadline + 1000 }, async () => null),
    ).toThrow();
    held = escaped.ledger.reserve({
      candidateKeys: 0,
      nativeRows: 1,
      identityMetadataRows: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 128,
      emptySeeks: 0,
    });
  });
  expect(() => held!.dispatch()).toThrow();
  expect(() => escaped.ledger!.assertReady()).toThrow();
  expect(escaped.ledger!.available('nativeRows')).toBe(0);
  expect(escaped.ledger!.receipt().used.nativeRows).toBe(0);
  expect(dispatched).toEqual([]);
});

test('a completed nested instrumenter cannot dispatch through an escaped callback while its Source frame remains live', async () => {
  const { instrumentNativeCollectionWork, requireNativeCollectionFootprint } =
    await import('../../src/library/collection-source-work.ts');
  const { pool, dispatched } = await accountingTransport();
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, funded.deadline)!;
    const bound = {
      candidateKeys: 0,
      nativeRows: 1,
      identityMetadataRows: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 128,
      emptySeeks: 0,
    };
    let release!: () => void;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let escaped: Promise<void> | undefined;
    await requireNativeCollectionFootprint(
      pool,
      ledger,
      () => bound,
      () =>
        instrumentNativeCollectionWork(
          pool,
          ledger,
          () => bound,
          async () => {
            const tx = await pool.connect();
            escaped = gate.then(async () => {
              // The original frame is still live, but this instrumenter's callback ended.
              expect(isLiveIdentitySourceConsumerMaintenance(pool, funded.identityConsumerWork)).toBeTrue();
              expect(() => tx.query('SELECT 1')).toThrow();
              await expect(
                instrumentNativeCollectionWork(
                  pool,
                  ledger,
                  () => bound,
                  async () => {
                    await tx.query('SELECT 1');
                  },
                ),
              ).rejects.toThrow();
            });
          },
        ),
    );
    release();
    await escaped;
    expect(ledger.receipt().used.statements).toBe(0);
  });
  expect(dispatched).toEqual([]);
});

test('a manually metered local custody ledger cannot suppress the existing Source observer or add receiving funds', async () => {
  const { NativeCollectionWork, instrumentNativeCollectionWork } =
    await import('../../src/library/collection-source-work.ts');
  const { withIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { pool, dispatched } = await accountingTransport();
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, funded.deadline)!;
    const bound = {
      candidateKeys: 0,
      nativeRows: 1,
      identityMetadataRows: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 128,
      emptySeeks: 0,
    };
    const local = new NativeCollectionWork(
      {
        reservationId: 'local-cap',
        remaining: {
          ...bound,
          nativeRows: 100,
          nativePoints: 100,
          statements: 100,
          bytes: 12800,
        },
      },
      funded.deadline,
    );
    const planned = {
      reservationId: ledger.receipt().reservationId,
      remaining: {
        ...bound,
        nativeRows: 2,
        nativePoints: 3,
        statements: 2,
        bytes: 256,
      },
    };
    await expect(
      withIdentitySourceConsumerLibraryRemainder(pool, funded.identityConsumerWork, funded.deadline, planned, () =>
        instrumentNativeCollectionWork(
          pool,
          ledger,
          () => bound,
          async () => {
            const tx = await pool.connect();
            for (let call = 0; call < 3; call++) {
              const admitted = local.reserve(bound);
              admitted.dispatch();
              try {
                await admitted.query(() => tx.query('SELECT 1'));
              } finally {
                admitted.settle();
              }
            }
          },
        ),
      ),
    ).rejects.toThrow();
    expect(ledger.receipt().used.statements).toBe(2);
    expect(ledger.receipt().used.nativeRows).toBe(2);
    expect(local.available('statements')).toBe(97); // Local spare work is not Source funding.
  });
  expect(dispatched).toEqual(['SELECT 1', 'SELECT 1']);
});

test('selected History cannot use configured Source funds when its authentic private additive allocation is unavailable', async () => {
  const { pool, dispatched } = await accountingTransport();
  const { IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const client = {} as import('../../src/work/client.ts').WorkClient;
  let entered = false;
  expect(() =>
    withIdentitySourceConsumerMaintenance({ pool, client, env: {} }, { deadline: Date.now() + 5000 }, async () => {
      entered = true;
    }),
  ).toThrow(IDENTITY_SOURCE_ORIGINAL_TRANSFER_UNAVAILABLE);
  expect(entered).toBeFalse();
  expect(dispatched).toEqual([]);
});

test('original parent composition requires every explicit eight-axis operand and never treats null children or a legacy vector as funds', async () => {
  const { composeIdentitySourceOriginalCosts } =
    await import('../../src/semantic/identity-source-maintenance-config.ts');
  const local = {
    candidateKeys: 0,
    nativeRows: 3,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 8,
    bytes: 256,
    emptySeeks: 0,
  };
  const parts = {
    accountsLocalControl: local,
    sourceHistoryNativeAllReachedCalls: null,
    libraryAllReachedCalls: null,
    additionalOriginalTransferControl: null,
  };
  expect(composeIdentitySourceOriginalCosts(parts)).toEqual({
    total: null,
    missing: ['sourceHistoryNativeAllReachedCalls', 'libraryAllReachedCalls', 'additionalOriginalTransferControl'],
  });
  expect(() =>
    composeIdentitySourceOriginalCosts({
      ...parts,
      accountsLocalControl: nativeWork(3, 1, 8, 256) as unknown as typeof local,
    }),
  ).toThrow('eight explicit dimensions');
  const complete = composeIdentitySourceOriginalCosts({
    accountsLocalControl: local,
    sourceHistoryNativeAllReachedCalls: local,
    libraryAllReachedCalls: local,
    additionalOriginalTransferControl: local,
  });
  expect(complete.total).toEqual({ ...local, nativeRows: 12, nativePoints: 4, statements: 32, bytes: 1024 });
  expect(complete.missing).toEqual([]);
});

test('The actual Library scope seal verifier and receiving and durable fence commands are charged before dispatch to the one existing Source frame with exact known SQL footprints, while unknown SQL is refused and same-home verification remains mandatory', async () => {
  const { scopeConsumerFootprint } = await import('../../src/semantic/identity-scoped-observations.ts');
  const { instrumentNativeCollectionWork } = await import('../../src/library/collection-source-work.ts');
  const { withIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const selection = (await import('../../src/semantic/identity-receiving-selection-read.sql')).default;
  const insert = (await import('../../src/semantic/identity-scoped-consumer-insert.sql')).default;
  const { pool, dispatched } = await accountingTransport();
  const deadline = Date.now() + 5000;
  const selectionValues = [0, randomUUID(), '1', 'effect', randomUUID(), randomUUID()];
  const known = scopeConsumerFootprint(selection.sql, selectionValues);
  expect(known).toEqual({
    candidateKeys: 0,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 2,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(selection.sql) + Buffer.byteLength(JSON.stringify(selectionValues)) + 128,
    emptySeeks: 1,
  });
  const fence = scopeConsumerFootprint(insert.sql, [
    0,
    'a'.repeat(64),
    'scope',
    randomUUID(),
    randomUUID(),
    randomUUID(),
    '1',
    '{}',
    'generation',
    '1',
    'b'.repeat(64),
    1,
    '1',
    randomUUID(),
  ]);
  expect(fence!.nativeRows).toBe(10);
  expect(fence!.statements).toBe(4); // INSERT, two FK checks and deferred current fence.
  expect(scopeConsumerFootprint('SELECT 1 /* undeclared Library planner */', [])).toBeUndefined();
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, deadline)!;
    const allowance = { reservationId: ledger.receipt().reservationId, remaining: { ...known!, nativePoints: 3 } };
    await expect(
      withIdentitySourceConsumerLibraryRemainder(pool, funded.identityConsumerWork, deadline, allowance, async () => {
        await expect(
          instrumentNativeCollectionWork(pool, ledger, scopeConsumerFootprint, async () => {
            const tx = await pool.connect();
            await tx.query(selection.sql, selectionValues);
            expect(ledger.receipt().used.nativeRows).toBe(2);
            await tx.query('SELECT 1 /* undeclared Library planner */');
          }),
        ).rejects.toThrow();
      }),
    ).rejects.toThrow(); // Admission failure remains recorded on the same poisoned ledger.
    expect(ledger.receipt().used.nativeRows).toBe(2);
    expect(() => ledger.assertReady()).toThrow();
  });
  expect(dispatched).toEqual([selection.sql]);
  // This genuine same-home command supplies no successful seal. Even a sealed-zero
  // claim may not skip the native verifier or create the durable Source fence.
  const ticket = { scope: { source: { kind: 'public' } } } as unknown as IdentityPrearmTicketData;
  const noSeal = Object.freeze({}) as LibraryScopeEffectSeal;
  await withIdentitySourceConsumerMaintenance(
    { pool: f.pool, env: {} },
    { deadline: Date.now() + 5000 },
    async (funded) => {
      const ledger = identitySourceConsumerLibraryWork(f.pool, funded.identityConsumerWork, funded.deadline)!;
      await withIdentitySourceConsumerLibraryRemainder(
        f.pool,
        funded.identityConsumerWork,
        funded.deadline,
        { reservationId: ledger.receipt().reservationId, remaining: ledger.receipt().used },
        async () => {
          const result = await runCommand(f.pool, { partition: reference.source.partition }, async (tx) =>
            noEffect(await retainIdentityScopeConsumerFence(tx, ticket, noSeal)),
          );
          expect(result.value).toBeNull();
        },
      );
    },
  );
});

// Use the actual Accounts admission/control fixture. No private grant, original
// partition, positive Library declaration or native receiver is synthesized here.
async function authenticSourceOriginal<T>(
  body: (
    deps: import('../../src/access/identity-original-admission.ts').HistoryOriginalDependencies,
    parent: import('../../src/access/identity-original-admission.ts').IdentityOriginalSourceContext,
  ) => Promise<T>,
) {
  const { newId, partitionOf } = await import('../../src/route/route.ts');
  const { HistoryRegistry } = await import('../../src/history/registry.ts');
  const { createWorkClient } = await import('../../src/work/client.ts');
  const { admitSharedHistory } = await import('../../src/access/shared-history.ts');
  const { withSelectedHistoryOriginal, consumeSelectedHistoryOriginal, withIdentityOriginalSourceTransfer } =
    await import('../../src/access/identity-original-admission.ts');
  const registry = new HistoryRegistry();
  const account = newId(0x9d20);
  const home = partitionOf(routeOf(account)!);
  const job = randomUUID();
  await f.admin.query("INSERT INTO core.partition(partition_no,node) VALUES($1,'local') ON CONFLICT DO NOTHING", [
    home,
  ]);
  await f.admin.query('INSERT INTO access.erasure(route,account_id,version,at) VALUES($1,$2,1,now())', [
    routeOf(account),
    account,
  ]);
  const generation = (
    await f.admin.query(
      `INSERT INTO core.history_registry(singleton,digest,gaps) VALUES(true,$1,'[]')
     ON CONFLICT(singleton) DO UPDATE SET digest=EXCLUDED.digest,generation=core.history_registry.generation+1
     RETURNING generation::text`,
      [registry.digest()],
    )
  ).rows[0]!.generation;
  await runCommand(f.pool, { partition: home }, async (tx) => noEffect(await admitSharedHistory(tx, account, job)));
  await f.admin.query(
    `UPDATE core.preference_history_job SET registry_digest=$2,registry_generation=$3,
    next_run='-infinity' WHERE job_id=$1`,
    [job, registry.digest(), generation],
  );
  const client = await createWorkClient(f.pool.options.connectionString!, f.pool);
  const deps = { pool: f.pool, client, registry };
  try {
    return await withSelectedHistoryOriginal(deps, async (selected, original) => {
      expect(selected).toBe(job);
      await consumeSelectedHistoryOriginal(deps, original, selected);
      return withIdentityOriginalSourceTransfer(deps, original, selected, (parent) => body(deps, parent));
    });
  } finally {
    await f.admin.query("UPDATE core.preference_history_job SET next_run='infinity' WHERE job_id=$1", [job]);
    await client.close();
  }
}

test('authentic Accounts private Source receiving keeps one original deadline and exact cumulative Library object, refuses copied wrong expired reentered ended grants before IO and never refills', async () => {
  const { spyOn } = await import('bun:test');
  const { withPrepaidIdentitySourceConsumerMaintenance, withIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { identityOriginalLibraryWork } = await import('../../src/access/identity-original-admission.ts');
  // This positive oracle intentionally requires actual installed child declarations.
  // A local-only admission must fail at the real producer, never become test funding.
  let ended: (() => Promise<unknown>) | undefined;
  await authenticSourceOriginal(async (deps, parent) => {
    ended = () => withPrepaidIdentitySourceConsumerMaintenance(deps, parent, async () => undefined);
    const ledger = identityOriginalLibraryWork(deps, parent.original, parent.jobId);
    expect(ledger).toBe(parent.library);
    const connect = spyOn(deps.pool, 'connect');
    const zero = {
      candidateKeys: 0,
      nativeRows: 0,
      identityMetadataRows: 0,
      nativePoints: 0,
      witnessKeys: 0,
      statements: 0,
      bytes: 0,
      emptySeeks: 0,
    };
    let callbackCount = 0;
    const never = async () => {
      throw new Error('invalid private grant reached callback');
    };
    const before = connect.mock.calls.length;
    try {
      for (const changed of [
        { ...parent, original: { ...parent.original } },
        { ...parent, jobId: randomUUID() },
        { ...parent, originalId: randomUUID() },
        { ...parent, position: { ...parent.position } },
        { ...parent, deadline: parent.deadline + 1 },
        { ...parent, native: { ...parent.native } },
        { ...parent, native: null as never },
        { ...parent, library: null as never },
        { ...parent, library: { ...parent.library } as typeof ledger },
      ])
        await expect(withPrepaidIdentitySourceConsumerMaintenance(deps, changed, never)).rejects.toThrow();
      for (const changed of [
        { ...deps, pool: f.admin },
        { ...deps, client: { ...deps.client } as typeof deps.client },
        { ...deps, registry: Object.create(deps.registry) as typeof deps.registry },
      ])
        await expect(withPrepaidIdentitySourceConsumerMaintenance(changed, parent, never)).rejects.toThrow();
      const now = Date.now;
      try {
        Date.now = () => parent.deadline;
        await expect(withPrepaidIdentitySourceConsumerMaintenance(deps, parent, never)).rejects.toThrow();
      } finally {
        Date.now = now;
      }
      expect(connect.mock.calls.length).toBe(before);
      let escaped: (() => void) | undefined;
      await withPrepaidIdentitySourceConsumerMaintenance(deps, parent, async (funded) => {
        callbackCount++;
        expect(funded.deadline).toBe(parent.deadline);
        expect(identitySourceConsumerLibraryWork(deps.pool, funded.identityConsumerWork, funded.deadline)).toBe(ledger);
        expect(
          reserveIdentitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, {
            rows: 0,
            points: 0,
            statements: 0,
            bytes: 0,
            engineRequests: 0,
          }),
        ).toBeFalse();
        // Complete explicit zero describes no native operation, not missing axes.
        expect(
          reserveIdentitySourceConsumerNativeWork(
            deps.pool,
            funded.identityConsumerWork,
            { rows: 0, points: 0, statements: 0, bytes: 0, engineRequests: 0 },
            zero,
          ),
        ).toBeTrue();
        const entire = {
          rows: parent.native.nativeRows,
          points: parent.native.nativePoints,
          statements: parent.native.statements,
          bytes: parent.native.bytes,
          engineRequests: 0,
        };
        expect(entire.statements).toBeGreaterThan(0);
        expect(
          reserveIdentitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, entire, parent.native),
        ).toBeTrue();
        expect(
          reserveIdentitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, entire, parent.native),
        ).toBeFalse();
        await expect(withPrepaidIdentitySourceConsumerMaintenance(deps, parent, never)).rejects.toThrow();
        const step = { ...zero, nativeRows: 1, nativePoints: 1, statements: 1, bytes: 1 };
        const start = ledger.receipt();
        await withIdentitySourceConsumerLibraryRemainder(
          deps.pool,
          funded.identityConsumerWork,
          funded.deadline,
          {
            reservationId: parent.originalId,
            remaining: {
              ...step,
              nativeRows: 3,
              nativePoints: 3,
              statements: 3,
              bytes: 3,
            },
          },
          async (same) => {
            for (let phase = 0; phase < 3; phase++) {
              const held = same.reserve(step);
              held.dispatch();
              held.settle();
              expect(same).toBe(ledger);
            }
          },
        );
        expect(ledger.receipt().used.statements).toBe(start.used.statements + 3);
        expect(start.used.statements).toBe(0); // Receipt counters are immutable snapshots.
        await withIdentitySourceConsumerLibraryRemainder(
          deps.pool,
          funded.identityConsumerWork,
          funded.deadline,
          { reservationId: parent.originalId, remaining: zero },
          async (same) => {
            expect(same).toBe(ledger);
            const held = same.reserve(zero);
            escaped = () => held.dispatch();
          },
        );
        expect(() => escaped!()).toThrow();
      });
      await expect(withPrepaidIdentitySourceConsumerMaintenance(deps, parent, never)).rejects.toThrow(
        'already-received',
      );
      expect(() => ledger.reserve(zero)).toThrow();
      expect(callbackCount).toBe(1);
      expect(connect.mock.calls.length).toBe(before);
    } finally {
      connect.mockRestore();
    }
  });
  await expect(ended!()).rejects.toThrow('private-grant-unavailable');
});

test('complete child composition repeats every reached term and exposes missing authority without a successful null declaration', async () => {
  const { composeIdentitySourceReachedCosts } =
    await import('../../src/semantic/identity-source-maintenance-config.ts');
  const { readIdentitySourceOriginalCostDisposition } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const local = {
    engineRequests: 0 as const,
    work: {
      candidateKeys: 0,
      nativeRows: 1,
      identityMetadataRows: 0,
      nativePoints: 1,
      witnessKeys: 0,
      statements: 1,
      bytes: 64,
      emptySeeks: 1,
    },
  };
  expect(composeIdentitySourceReachedCosts([{ name: 'current', calls: 3, declaration: local }])).toEqual({
    state: 'complete',
    engineRequests: 0,
    work: { ...local.work, nativeRows: 3, nativePoints: 3, statements: 3, bytes: 192, emptySeeks: 3 },
  });
  expect(
    composeIdentitySourceReachedCosts([{ name: 'Library.currentLockedPlan', calls: 2, declaration: null }]),
  ).toEqual({ state: 'missing', missing: ['Library.currentLockedPlan'] });
  expect(() =>
    composeIdentitySourceReachedCosts([{ name: 'overflow', calls: Number.MAX_SAFE_INTEGER, declaration: local }]),
  ).toThrow();
  const disposition = await readIdentitySourceOriginalCostDisposition();
  expect(disposition.state).toBe('missing');
  expect(disposition.missing.some((term) => term.includes('LibraryAllReachedCalls'))).toBeTrue();
});

test('scope literal accounting rejects malformed unbounded and receipt-writing operands before transport', async () => {
  const { scopeConsumerFootprint } = await import('../../src/semantic/identity-scoped-observations.ts');
  const selection = (await import('../../src/semantic/identity-receiving-selection-read.sql')).default;
  const noEffect = (await import('../../src/command/no-effect-fence.sql')).default;
  const values = [0, randomUUID(), '1', 'effect', randomUUID(), randomUUID()];
  expect(scopeConsumerFootprint(selection.sql, values)).toBeDefined();
  for (const bad of [
    [],
    [...values, 'extra'],
    [4096, ...values.slice(1)],
    [...values.slice(0, 3), 'x'.repeat(257), ...values.slice(4)],
  ])
    expect(scopeConsumerFootprint(selection.sql, bad)).toBeUndefined();
  expect(scopeConsumerFootprint(noEffect.sql, [0, randomUUID(), { receipt: 'write' }])).toBeUndefined();
  expect(scopeConsumerFootprint(selection.sql + ' /* copied name */', values)).toBeUndefined();
});

test('failed COMMIT keeps its charged work and dispatches the separately held ROLLBACK on the same cumulative plan', async () => {
  const { instrumentNativeCollectionWork } = await import('../../src/library/collection-source-work.ts');
  const { withIdentitySourceConsumerLibraryRemainder } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { pool, dispatched } = await accountingTransport('COMMIT');
  const zero = {
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    emptySeeks: 0,
  };
  await withIdentitySourceConsumerMaintenance({ pool, env: {} }, { deadline: Date.now() + 5000 }, async (funded) => {
    const ledger = identitySourceConsumerLibraryWork(pool, funded.identityConsumerWork, funded.deadline)!;
    await withIdentitySourceConsumerLibraryRemainder(
      pool,
      funded.identityConsumerWork,
      funded.deadline,
      {
        reservationId: ledger.receipt().reservationId,
        remaining: { ...zero, nativePoints: 1, statements: 3, bytes: 384 },
      },
      async () => {
        await instrumentNativeCollectionWork(
          pool,
          ledger,
          (sql) =>
            ['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT', 'ROLLBACK'].includes(sql)
              ? { ...zero, statements: 1, bytes: 128 }
              : undefined,
          async () => {
            const tx = await pool.connect();
            await tx.query('BEGIN ISOLATION LEVEL SERIALIZABLE');
            const before = ledger.receipt();
            await expect(tx.query('COMMIT')).rejects.toThrow('dispatched accounting failure');
            expect(ledger.available('statements')).toBe(0);
            await tx.query('ROLLBACK');
            expect(ledger.receipt().used.statements).toBe(3);
            expect(before.used.statements).toBe(1);
          },
        );
      },
    );
    expect(ledger.receipt().used.bytes).toBe(384);
  });
  expect(dispatched).toEqual(['BEGIN ISOLATION LEVEL SERIALIZABLE', 'COMMIT', 'ROLLBACK']);
});

test('a manually reserved query cannot suppress the original literal policy or repeat its single dispatch', async () => {
  const { NativeCollectionWork, instrumentNativeCollectionWork } =
    await import('../../src/library/collection-source-work.ts');
  const { pool, dispatched } = await accountingTransport();
  const bound = {
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 128,
    emptySeeks: 0,
  };
  const ledger = new NativeCollectionWork(
    {
      reservationId: randomUUID(),
      remaining: {
        ...bound,
        nativeRows: 4,
        nativePoints: 5,
        statements: 4,
        bytes: 512,
      },
    },
    Date.now() + 5000,
  );
  await expect(
    instrumentNativeCollectionWork(
      pool,
      ledger,
      (sql) => (sql === 'SELECT 1' ? bound : undefined),
      async () => {
        const tx = await pool.connect();
        const held = ledger.reserve(bound);
        held.dispatch();
        try {
          await held.query(async () => {
            await tx.query('SELECT 1');
            await tx.query('SELECT 1');
          });
        } finally {
          held.settle();
        }
      },
    ),
  ).rejects.toThrow();
  expect(dispatched).toEqual(['SELECT 1']);
  expect(ledger.receipt().used.statements).toBe(1);
});

test('an unreleased checkout and its saved query method lose dispatch authority when their observer ends', async () => {
  const { NativeCollectionWork, instrumentNativeCollectionWork } =
    await import('../../src/library/collection-source-work.ts');
  const { pool, dispatched } = await accountingTransport();
  const bound = {
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes: 128,
    emptySeeks: 0,
  };
  const ledger = new NativeCollectionWork(
    {
      reservationId: randomUUID(),
      remaining: {
        ...bound,
        nativeRows: 2,
        nativePoints: 3,
        statements: 2,
        bytes: 256,
      },
    },
    Date.now() + 5000,
  );
  let escaped: (() => unknown) | undefined;
  await instrumentNativeCollectionWork(
    pool,
    ledger,
    () => bound,
    async () => {
      const client = await pool.connect();
      escaped = () => client.query('SELECT 1');
      await client.query('SELECT 1');
    },
  );
  expect(() => escaped!()).toThrow();
  expect(dispatched).toEqual(['SELECT 1']);
});

// Bounded-original receiving cases are intentionally UNRUN at this source boundary.
// The genuine producer fixture must admit them after actual child declarations land;
// these cases never inject an allocation, private grant, seal or replacement ledger.
test('selected original exposes one irreversible custody step and the exact Library schedule without planner discovery or a third final fence', async () => {
  const { IDENTITY_SOURCE_ORIGINAL_SCHEDULE: schedule } =
    await import('../../src/semantic/identity-source-maintenance-config.ts');
  expect(schedule.custodyAdvancements).toBe(1);
  expect(schedule.directoryPages).toBe(1);
  expect(schedule.library).toEqual({
    discovery: 0,
    plannerSteps: 0,
    effectPages: 1,
    currentVerifications: 1,
    exhaustedPageRechecks: 1,
    finalFences: 0,
  });
  expect(Object.isFrozen(schedule)).toBeTrue();
  expect(Object.isFrozen(schedule.library)).toBeTrue();
  const {
    claimIdentitySourceCustodyAdvancement: claim,
    claimIdentitySourceLibraryCall: call,
    identitySourceConsumerScheduleReceipt: receipt,
    withPrepaidIdentitySourceConsumerMaintenance: receive,
  } = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { spyOn } = await import('bun:test');
  await authenticSourceOriginal(async (deps, parent) => {
    const connect = spyOn(deps.pool, 'connect');
    const before = connect.mock.calls.length;
    try {
      await receive(deps, parent, async (funded) => {
        const point = parent.position;
        const barrier = {
          accountId: point.account_id,
          accountRoute: point.account_route,
          version: point.barrier_version,
          at: point.barrier_at,
        };
        const originalReceipt = parent.library.receipt();
        expect(claim(deps.pool, funded.identityConsumerWork, funded.deadline - 1, barrier)).toBeFalse();
        expect(
          claim(deps.pool, funded.identityConsumerWork, funded.deadline, { ...barrier, version: barrier.version + 1 }),
        ).toBeFalse();
        expect(() => call(deps.pool, 'effectPages')).toThrow('not-claimed');
        expect(claim(deps.pool, funded.identityConsumerWork, funded.deadline, barrier)).toBeTrue();
        const snapshot = receipt(deps.pool, funded.identityConsumerWork, funded.deadline)!;
        // Concurrent/overlapping and sequential attempts consume no second step.
        expect(
          await Promise.all(
            [0, 1].map(async () => claim(deps.pool, funded.identityConsumerWork, funded.deadline, barrier)),
          ),
        ).toEqual([false, false]);
        for (const operation of ['discovery', 'plannerSteps', 'finalFences'] as const)
          expect(() => call(deps.pool, operation)).toThrow('schedule-exhausted');
        for (const operation of ['effectPages', 'currentVerifications', 'exhaustedPageRechecks'] as const) {
          call(deps.pool, operation);
          expect(() => call(deps.pool, operation)).toThrow('schedule-exhausted');
        }
        expect(snapshot).toEqual({ claimed: true, calls: {} });
        expect(receipt(deps.pool, funded.identityConsumerWork, funded.deadline)).toEqual({
          claimed: true,
          calls: {
            'Library.effectPages': 1,
            'Library.currentVerifications': 1,
            'Library.exhaustedPageRechecks': 1,
          },
        });
        expect(parent.library.receipt()).toEqual(originalReceipt); // Guard bookkeeping is not IO or funding.
        expect(claim(deps.pool, funded.identityConsumerWork, funded.deadline, barrier)).toBeFalse();
      });
      await expect(receive(deps, parent, async () => undefined)).rejects.toThrow('already-received');
      expect(connect.mock.calls.length).toBe(before);
    } finally {
      connect.mockRestore();
    }
  });
});

for (const effects of [0, 1]) {
  test(`selected original accounts separately for currentness and exhausted-page recheck with ${effects} effects, without minting a native seal`, async () => {
    const {
      claimIdentitySourceCustodyAdvancement: claim,
      claimIdentitySourceLibraryCall: call,
      identitySourceConsumerScheduleReceipt: receipt,
      withPrepaidIdentitySourceConsumerMaintenance: receive,
    } = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
    await authenticSourceOriginal(async (deps, parent) =>
      receive(deps, parent, async (funded) => {
        const p = parent.position;
        expect(
          claim(deps.pool, funded.identityConsumerWork, funded.deadline, {
            accountId: p.account_id,
            accountRoute: p.account_route,
            version: p.barrier_version,
            at: p.barrier_at,
          }),
        ).toBeTrue();
        call(deps.pool, 'effectPages');
        // Both zero-row and one-row exhausted branches have the SAME two possible
        // verifier dispatches. This tests the guard, not currentness/native closure.
        call(deps.pool, 'currentVerifications');
        call(deps.pool, 'exhaustedPageRechecks');
        expect(() => call(deps.pool, 'finalFences')).toThrow();
        expect(receipt(deps.pool, funded.identityConsumerWork, funded.deadline)!.calls).toEqual({
          'Library.effectPages': 1,
          'Library.currentVerifications': 1,
          'Library.exhaustedPageRechecks': 1,
        });
        expect(() => call(deps.pool, 'currentVerifications')).toThrow();
        expect(() => call(deps.pool, 'exhaustedPageRechecks')).toThrow();
      }),
    );
  });
}

test('genuine selected original adapts Core no-effect controls atomically on Source while the exact Library counters and absolute deadline stay unchanged', async () => {
  const { COMMAND_DISPATCH_ALLOWANCE: controls } = await import('../../src/command/dispatch-lifetime.ts');
  const {
    claimIdentitySourceCustodyAdvancement: claim,
    claimIdentitySourceScheduledCall: call,
    withIdentitySourceNoEffectCommand: command,
    withPrepaidIdentitySourceConsumerMaintenance: receive,
  } = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  await authenticSourceOriginal(async (deps, parent) =>
    receive(deps, parent, async (funded) => {
      const p = parent.position;
      expect(
        claim(deps.pool, funded.identityConsumerWork, funded.deadline, {
          accountId: p.account_id,
          accountRoute: p.account_route,
          version: p.barrier_version,
          at: p.barrier_at,
        }),
      ).toBeTrue();
      const before = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)!;
      const library = parent.library.receipt();
      call(deps.pool, 'retainedDiscovery');
      const result = await command(deps.pool, funded.deadline, () =>
        runCommand(deps.pool, { partition: p.partition_no, deadline: funded.deadline }, async () => noEffect(true)),
      );
      expect(result.value).toBeTrue();
      const after = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)!;
      expect(before.rows - after.rows).toBe(controls.total.work.nativeRows);
      expect(before.points - after.points).toBe(controls.total.work.nativePoints);
      expect(before.statements - after.statements).toBe(controls.total.work.statements);
      expect(before.bytes - after.bytes).toBe(controls.total.work.bytes);
      expect(parent.library.receipt()).toEqual(library);
      expect(funded.deadline).toBe(parent.deadline);
      expect(() => call(deps.pool, 'retainedDiscovery')).toThrow('schedule-exhausted');
      expect(() => command(deps.pool, funded.deadline + 1, async () => true)).toThrow();
    }),
  );
});

for (const end of ['unavailable', 'failure'] as const) {
  test(`a genuine custody claim stays spent after ${end} and cannot be reopened by callback reentry`, async () => {
    const { claimIdentitySourceCustodyAdvancement: claim, withPrepaidIdentitySourceConsumerMaintenance: receive } =
      await import('../../src/semantic/identity-source-consumer-maintenance.ts');
    await authenticSourceOriginal(async (deps, parent) => {
      let escaped: (() => boolean) | undefined;
      const enter = () =>
        receive(deps, parent, async (funded) => {
          const p = parent.position;
          const retry = () =>
            claim(deps.pool, funded.identityConsumerWork, funded.deadline, {
              accountId: p.account_id,
              accountRoute: p.account_route,
              version: p.barrier_version,
              at: p.barrier_at,
            });
          expect(retry()).toBeTrue();
          escaped = retry;
          try {
            if (end === 'failure') throw new Error('custody body failed');
          } finally {
            expect(retry()).toBeFalse();
          }
          return null;
        });
      if (end === 'failure') await expect(enter()).rejects.toThrow('custody body failed');
      else expect(await enter()).toBeNull();
      expect(escaped!()).toBeFalse();
      await expect(receive(deps, parent, async () => true)).rejects.toThrow('already-received');
    });
  });
}

test('owned literal catalogue prices complete bounded projections and exact operands, refusing comments and the unbounded ordinary published query', async () => {
  const {
    IDENTITY_SOURCE_LOCAL_SQL: sql,
    IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS: prices,
    IDENTITY_SOURCE_LOCAL_MUTATION_COMPONENTS: mutations,
    identitySourceCustodyFootprint: footprint,
  } = await import('../../src/semantic/identity-source-consumer-custody.ts');
  const { identityReceiptKey, serializeIdentityValue: json } =
    await import('../../src/semantic/identity-epoch-store.ts');
  const id = randomUUID();
  const receipt = { kind: 'account-agent.verify' as const, account: id, receipt: randomUUID() };
  const key = identityReceiptKey(receipt);
  const values = {
    retained: [0, key, 'a'.repeat(64), 1, '1', id, id, '1', id, 0, 1, '2026-11-02T00:00:00Z', 'subject'],
    progress: [0, '1'],
    accepted: [0, key, 'a'.repeat(64), id, '1', json(receipt)],
    published: [0, id, '1'],
  };
  for (const name of Object.keys(sql) as (keyof typeof sql)[]) {
    const charged = footprint(sql[name], values[name])!;
    expect(charged).toBeDefined();
    expect(charged.candidateKeys).toBe(0);
    expect(charged.identityMetadataRows).toBe(0);
    expect(charged.witnessKeys).toBe(0);
    expect(charged.statements).toBe(1);
    expect(charged.bytes).toBeLessThanOrEqual(prices[name].work.bytes);
    expect(charged.bytes).toBeGreaterThan(Buffer.byteLength(sql[name]) + Buffer.byteLength(json(values[name])));
    expect(prices[name].engineRequests).toBe(0);
    expect(Object.isFrozen(prices[name].work)).toBeTrue();
    expect(footprint(sql[name] + ' /* same name */', values[name])).toBeUndefined();
    expect(footprint(sql[name], [...values[name], 'extra'])).toBeUndefined();
    expect(footprint(sql[name], [4096, ...values[name].slice(1)])).toBeUndefined();
  }
  const ordinary = (await import('../../src/semantic/identity-source-consumer-custody-job.sql')).default;
  expect(footprint(ordinary.sql, values.published)).toBeUndefined();
  expect(footprint(sql.accepted, [...values.accepted.slice(0, 5), 'x'.repeat(257)])).toBeUndefined();
  expect(footprint(sql.progress, [0, '9223372036854775808'])).toBeUndefined();
  expect(mutations.custodyInsert.children).toContain('semantic.erasure_record_key default');
  expect(mutations.terminalAppend.foreignKeys).toHaveLength(3);
});

test('local component arithmetic preserves exact Core cleanup and exposes event profile and installed foreign composition separately', async () => {
  const { composeIdentitySourceReachedCosts: compose } =
    await import('../../src/semantic/identity-source-maintenance-config.ts');
  const { readIdentitySourceOriginalCostDisposition: read } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  const { COMMAND_DISPATCH_ALLOWANCE: command } = await import('../../src/command/dispatch-lifetime.ts');
  const { IDENTITY_SOURCE_LOCAL_READ_DECLARATIONS: reads, IDENTITY_SOURCE_WIDER_COMMAND_REQUIREMENTS: wider } =
    await import('../../src/semantic/identity-source-consumer-custody.ts');
  const total = compose([
    { name: 'Core.effect', calls: 1, declaration: command.effect },
    { name: 'Core.cleanup', calls: 1, declaration: command.cleanup },
    { name: 'Source.retained', calls: 1, declaration: reads.retained },
    { name: 'Source.progress', calls: 1, declaration: reads.progress },
  ]);
  expect(total.state).toBe('complete');
  if (total.state !== 'complete') throw new Error('Local components must be complete');
  for (const axis of Object.keys(total.work) as (keyof typeof total.work)[])
    expect(total.work[axis]).toBe(command.total.work[axis] + reads.retained.work[axis] + reads.progress.work[axis]);
  expect(command.total.work).toEqual({
    candidateKeys: 0,
    nativeRows: 2,
    identityMetadataRows: 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 8,
    bytes: 169,
    emptySeeks: 1,
  });
  expect(wider.exhaustedReceiving).toContain('SEMANTIC_ERASURE_PROGRESS');
  const disposition = await read();
  expect(disposition.schedule.library.exhaustedPageRechecks).toBe(1);
  expect(disposition.schedule.library.finalFences).toBe(0);
  expect(disposition.widerExecutor).toBe(wider);
  // Missing operands remain exact gaps, even with delivered positive Library native bodies.
  if (!disposition.librarySameWorkCallableInstalled)
    expect(disposition.missing.some((term) => term.includes('readLibraryScopeEffectsPageWithWork'))).toBeTrue();
  if (!disposition.libraryDeclaration) expect(disposition.whole.state).toBe('missing');
});

test('first genuine custody discovery spends the step even when pending, so its second public entry performs no discovery checkout', async () => {
  const { spyOn } = await import('bun:test');
  const { withPrepaidIdentitySourceConsumerMaintenance: receive, identitySourceConsumerScheduleReceipt: schedule } =
    await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  await authenticSourceOriginal(async (deps, parent) =>
    receive(deps, parent, async (funded) => {
      const p = parent.position;
      // The receipt is genuine fixture data. The selected Account barrier is bound
      // to the actual producer position; this is an honest absent custody lookup.
      const input = {
        ...reference,
        erasedRole: 'requester' as const,
        barrier: {
          accountId: p.account_id,
          accountRoute: p.account_route,
          version: p.barrier_version,
          at: p.barrier_at,
        },
      };
      const connect = spyOn(deps.pool, 'connect');
      try {
        expect(await readIdentitySourceConsumerCustody(deps.pool, input, funded)).toBeNull();
        const afterFirst = connect.mock.calls.length;
        expect(afterFirst).toBeGreaterThan(0);
        expect(await readIdentitySourceConsumerCustody(deps.pool, input, funded)).toBeNull();
        expect(connect.mock.calls.length).toBe(afterFirst);
        expect(
          schedule(deps.pool, funded.identityConsumerWork, funded.deadline)!.calls['Source.retainedDiscovery'],
        ).toBe(1);
        expect(
          schedule(deps.pool, funded.identityConsumerWork, funded.deadline)!.calls['Library.plannerSteps'],
        ).toBeUndefined();
      } finally {
        connect.mockRestore();
      }
    }),
  );
});

test('a failed real no-effect command keeps prepaid Core rollback charged and cannot refund the one selected custody advancement', async () => {
  const { COMMAND_DISPATCH_ALLOWANCE: controls } = await import('../../src/command/dispatch-lifetime.ts');
  const {
    claimIdentitySourceCustodyAdvancement: claim,
    withIdentitySourceNoEffectCommand: command,
    withPrepaidIdentitySourceConsumerMaintenance: receive,
  } = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  await authenticSourceOriginal(async (deps, parent) =>
    receive(deps, parent, async (funded) => {
      const p = parent.position;
      const retry = () =>
        claim(deps.pool, funded.identityConsumerWork, funded.deadline, {
          accountId: p.account_id,
          accountRoute: p.account_route,
          version: p.barrier_version,
          at: p.barrier_at,
        });
      expect(retry()).toBeTrue();
      const before = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)!;
      const library = parent.library.receipt();
      await expect(
        command(deps.pool, funded.deadline, () =>
          runCommand(deps.pool, { partition: p.partition_no, deadline: funded.deadline }, async () => {
            throw new Error('failed genuine receiving command');
          }),
        ),
      ).rejects.toThrow('failed genuine receiving command');
      const after = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)!;
      expect(before.statements - after.statements).toBe(controls.total.work.statements);
      expect(before.bytes - after.bytes).toBe(controls.total.work.bytes);
      expect(parent.library.receipt()).toEqual(library);
      expect(retry()).toBeFalse();
    }),
  );
});

test('genuine Source original uses the delivered progress-event executor and charges its controls only to the Source partition', async () => {
  const { SOURCE_FENCE_COMMAND_DISPATCH_ALLOWANCE: controls } =
    await import('../../src/command/dispatch-lifetime-source-fence.ts');
  const { SEMANTIC_ERASURE_PROGRESS } = await import('../../src/semantic/account-erasure.ts');
  const {
    claimIdentitySourceCustodyAdvancement: claim,
    withIdentitySourceFenceCommand: command,
    withPrepaidIdentitySourceConsumerMaintenance: receive,
  } = await import('../../src/semantic/identity-source-consumer-maintenance.ts');
  // This uses real Accounts admission and private transfer. Until the complete
  // Source declaration is delivered, its producer must refuse rather than make
  // this fixture an alternate funding path.
  await authenticSourceOriginal(async (deps, parent) =>
    receive(deps, parent, async (funded) => {
      const p = parent.position;
      expect(
        claim(deps.pool, funded.identityConsumerWork, funded.deadline, {
          accountId: p.account_id,
          accountRoute: p.account_route,
          version: p.barrier_version,
          at: p.barrier_at,
        }),
      ).toBeTrue();
      const before = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)!;
      const library = parent.library.receipt();
      const result = await command(deps.pool, funded.deadline, p.account_id, () =>
        runCommand(deps.pool, { partition: p.partition_no, deadline: funded.deadline }, async () => ({
          value: 'native progress',
          events: [{ type: SEMANTIC_ERASURE_PROGRESS, subject: p.account_id, data: { accountId: p.account_id } }],
        })),
      );
      expect(result.value).toBe('native progress');
      expect(result.replayed).toBeFalse();
      const after = identitySourceConsumerNativeWork(deps.pool, funded.identityConsumerWork, funded.deadline)!;
      expect(before.statements - after.statements).toBe(controls.total.work.statements);
      expect(before.bytes - after.bytes).toBe(controls.total.work.bytes);
      expect(before.rows - after.rows).toBe(controls.total.work.nativeRows);
      expect(parent.library.receipt()).toEqual(library);
    }),
  );
});

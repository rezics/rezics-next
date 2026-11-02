import { afterEach, expect, test } from 'bun:test';
import type {
  Approval,
  Family,
  Fixture,
  NativeAccountWorkflowDriver,
  Revocation,
  Work,
} from './native-account-workflow-driver.ts';

let driver: NativeAccountWorkflowDriver | undefined;
async function d() {
  if (driver) return driver;
  const module = process.env.NATIVE_ACCOUNT_WORKFLOW_DRIVER_MODULE;
  if (!module) throw new Error('Missing native account workflow driver');
  driver = await (await import(module)).createNativeAccountWorkflowDriver();
  return driver!;
}
afterEach(async () => {
  await driver?.close();
  driver = undefined;
});
const families: Family[] = [
  'organization',
  'transfer',
  'subject-delete',
  'operator-delete',
  'fence-operator',
  'opening',
];
// Required native phases, not an alternative authorization or coordinator.
const required: Record<Family, string[]> = {
  organization: [
    'reserve-owner',
    'create-organization',
    'operator-management-defaults',
    'reserve-handle',
    'hold-new-handle',
    'bootstrap-organization-handle',
    'finalize-handle',
    'complete-handle-operation',
  ],
  transfer: ['reserve-operator', 'record-operator', 'revoke-auth-sessions', 'retire-operator', 'release-operator'],
  'subject-delete': [
    'account-before-deletion',
    'tombstone-account',
    'erase-auth-owner',
    'retire-operator',
    'release-operator',
    'redirect-deleted-handle',
  ],
  'operator-delete': ['account-before-deletion', 'tombstone-account', 'erase-auth-owner', 'redirect-deleted-handle'],
  'fence-operator': ['fence', 'revoke-auth-sessions', 'operator-responsibility-page'],
  opening: ['authorize-opening'],
};
async function setup(family: Family) {
  const driver = await d();
  return { driver, f: await driver.fixture(family) };
}
async function approve(driver: NativeAccountWorkflowDriver, f: Fixture): Promise<Approval> {
  const a = await driver.approve(f.caller, f.work);
  expect(a.outcome).toBe('approved');
  if (a.outcome !== 'approved') throw new Error('Native approval positive control failed');
  const row = await driver.approval(a.reference);
  expect(row).toMatchObject({
    ...f.identity,
    operationKey: f.work.operationKey,
    operation: f.work.operation,
    digest: await driver.digest(f.work),
    expiresAt: a.expiresAt,
  });
  expect(row!.action.length).toBeGreaterThan(0);
  expect(row!.resourceId.length).toBeGreaterThan(0);
  expect(row!.creationReceiptId.length).toBeGreaterThan(0);
  if (f.work.operation.kind === 'delete') {
    expect(row!.action).toBe('account:delete');
    expect(row!.resourceId).toBe(f.work.operation.accountId);
  }
  if (f.work.operation.kind === 'opening') {
    expect(row!.action).toBe(f.managementAction);
    expect(row!.resourceId).toBe(f.work.operation.operatorAccountId);
  }
  if (f.work.operation.kind === 'fence-operator') {
    expect(row!.action).toBe('account:suspend');
    expect(row!.resourceId).toBe('00000000-0000-8000-8000-000000000000');
  }
  return a;
}
async function permitted(driver: NativeAccountWorkflowDriver, f: Fixture, a: Approval) {
  const result = await driver.execute(f.caller, a.reference, f.work);
  expect(result.outcome).toBe('permitted');
  if (result.outcome !== 'permitted') throw new Error('Native workflow positive control failed');
  expect(result.receiptId.length).toBeGreaterThan(0);
  expect((await driver.snapshot(f)).receipts.some((r) => r.id === result.receiptId)).toBe(true);
  return result;
}
async function denied(driver: NativeAccountWorkflowDriver, f: Fixture, a: Approval, work = f.work) {
  const before = await driver.snapshot(f);
  expect(await driver.execute(f.caller, a.reference, work)).toEqual({ outcome: 'denied' });
  expect(await driver.snapshot(f)).toEqual(before);
}
async function finishTerminal(driver: NativeAccountWorkflowDriver, f: Fixture, a: Approval) {
  // A subject deletion records management of its prior operator as the basis,
  // so an operator's manager gets the permitted result after cleanup completes.
  // Deleting the caller's own account or its basis stays denied. Fencing's caller
  // keeps authority, so the user result is the suspension.
  if (f.family === 'fence-operator') {
    const result = await permitted(driver, f, a);
    const c = await driver.continuation(f);
    expect(c).not.toBeNull();
    expect(await driver.continueCommitted(c!.reference)).toEqual({ outcome: 'continued' });
    const after = await driver.snapshot(f);
    expect(await driver.execute(f.caller, a.reference, f.work)).toEqual(result);
    expect(await driver.snapshot(f)).toEqual(after);
    return;
  }
  expect(await driver.execute(f.caller, a.reference, f.work)).toEqual({ outcome: 'denied' });
  const c = await driver.continuation(f);
  expect(c).not.toBeNull();
  expect(await driver.continueCommitted(c!.reference)).toEqual({ outcome: 'continued' });
  if (f.work.operation.kind === 'delete' && f.work.operation.responsibility) {
    const result = await permitted(driver, f, a);
    const after = await driver.snapshot(f);
    expect(await driver.execute(f.caller, a.reference, f.work)).toEqual(result);
    expect(await driver.snapshot(f)).toEqual(after);
  } else await denied(driver, f, a);
}
async function steps(driver: NativeAccountWorkflowDriver, f: Fixture) {
  const list = await driver.protectedSteps(f);
  for (const name of required[f.family]) expect(list.some((s) => s.name === name)).toBe(true);
  expect(new Set(list.map((s) => JSON.stringify(s))).size).toBe(list.length);
  expect(list.every((s) => s.target.length > 0)).toBe(true);
  expect(list.some((s) => s.authority === 'caller')).toBe(true);
  for (const s of list.filter((s) => s.authority === 'committed-continuation')) {
    expect(['subject-delete', 'operator-delete', 'fence-operator']).toContain(f.family);
    expect([
      'fence',
      'revoke-auth-sessions',
      'operator-responsibility-page',
      'erase-auth-owner',
      'retire-operator',
      'release-operator',
      'redirect-deleted-handle',
    ]).toContain(s.name);
  }
  return list;
}

test('organization creation commits native owner inverse before authority and bootstraps exactly one handle and active human owner', async () => {
  const { driver, f } = await setup('organization');
  const a = await approve(driver, f);
  let observed = false;
  const result = await driver.execute(f.caller, a.reference, f.work, {
    before: { name: 'create-organization', target: f.organizationId },
    run: async () => {
      observed = true;
      const state = await driver.snapshot(f);
      expect(state.accounts.some((x) => x.id === f.organizationId)).toBe(false);
      expect(state.ownerInverses).toContainEqual(
        expect.objectContaining({
          organizationId: f.organizationId,
          ownerId: f.identity.actorId,
          held: true,
          terminal: false,
        }),
      );
    },
  });
  expect(observed).toBe(true);
  expect(result.outcome).toBe('permitted');
  const state = await driver.snapshot(f);
  expect(state.accounts).toContainEqual(
    expect.objectContaining({ id: f.organizationId, kind: 'organization', state: 'active' }),
  );
  expect(state.owners).toContainEqual({
    organizationId: f.organizationId,
    nativeCount: 1,
    activeHumans: [f.identity.actorId],
  });
  const members = state.memberships.filter((x) => x.organizationId === f.organizationId);
  expect(members).toHaveLength(1);
  expect(state.ownerInverses).toContainEqual({
    organizationId: f.organizationId,
    ownerId: f.identity.actorId,
    reservationId: members[0]!.reservationId,
    held: true,
    terminal: false,
  });
  expect(state.handles.filter((x) => x.handle === f.handle)).toEqual([
    { handle: f.handle, accountId: f.organizationId, phase: 'active' },
  ]);
}, 660_000);

test('organization last active human owner suspension takes effect while remove demote and delete stay refused and exact native owner count stays one', async () => {
  const { driver, f } = await setup('organization');
  await permitted(driver, f, await approve(driver, f));
  for (const action of ['remove', 'demote', 'delete'] as const) {
    const before = await driver.snapshot(f);
    expect(await driver.lastOwner(f, action)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(f)).toEqual(before);
  }
  const before = await driver.snapshot(f);
  expect((await driver.lastOwner(f, 'suspend')).outcome).toBe('permitted');
  const after = await driver.snapshot(f);
  expect(after.owners).toContainEqual({
    organizationId: f.organizationId,
    nativeCount: 1,
    activeHumans: [],
  });
  expect(after.memberships).toEqual(before.memberships);
  expect(after.ownerInverses).toEqual(before.ownerInverses);
  expect(after.history).toEqual(before.history);
}, 660_000);

test('organization handle collision cannot steal an existing handle or release an owner inverse beneath published authority', async () => {
  const { driver, f } = await setup('organization');
  await permitted(driver, f, await approve(driver, f));
  const before = await driver.snapshot(f);
  const next = await driver.fixture('organization');
  if (next.work.operation.kind !== 'organization') throw new Error('Expected organization fixture');
  next.work.operation.handle = f.handle;
  const a = await driver.approve(next.caller, next.work);
  if (a.outcome === 'approved')
    expect(await driver.execute(next.caller, a.reference, next.work)).toEqual({ outcome: 'denied' });
  else expect(a).toEqual({ outcome: 'denied' });
  expect(await driver.snapshot(f)).toEqual(before);
  const s = await driver.snapshot(next);
  for (const m of s.memberships.filter((m) => m.role === 'owner'))
    expect(s.ownerInverses).toContainEqual({
      organizationId: m.organizationId,
      ownerId: m.accountId,
      reservationId: m.reservationId,
      held: true,
      terminal: false,
    });
}, 660_000);

test('operator transfer holds both inverses until subject authority switches then releases only the terminal old slot', async () => {
  const { driver, f } = await setup('transfer');
  const a = await approve(driver, f);
  let observed = false;
  expect(
    (
      await driver.execute(f.caller, a.reference, f.work, {
        before: { name: 'record-operator', target: f.subjectId },
        run: async () => {
          observed = true;
          const s = await driver.snapshot(f);
          expect(
            s.responsibilities
              .filter((x) => x.subjectAccountId === f.subjectId && x.held)
              .map((x) => x.operatorAccountId)
              .sort(),
          ).toEqual([f.ownerId, f.nextOperatorId].sort());
          expect(s.accounts.find((x) => x.id === f.subjectId)!.operatorId).toBe(f.ownerId);
        },
      })
    ).outcome,
  ).toBe('permitted');
  expect(observed).toBe(true);
  const s = await driver.snapshot(f);
  expect(s.accounts.find((x) => x.id === f.subjectId)!.operatorId).toBe(f.nextOperatorId);
  expect(s.responsibilities).toContainEqual(
    expect.objectContaining({
      operatorAccountId: f.ownerId,
      subjectAccountId: f.subjectId,
      terminal: true,
      held: false,
    }),
  );
  expect(s.responsibilities).toContainEqual(
    expect.objectContaining({
      operatorAccountId: f.nextOperatorId,
      subjectAccountId: f.subjectId,
      terminal: false,
      held: true,
    }),
  );
  expect(await driver.access(f)).toMatchObject({
    oldManagement: false,
    newManagement: true,
    oldSessionsValid: false,
    inheritedResourceAccess: false,
  });
}, 660_000);

test('transfer rejects self automated operator stale version and wrong old reservation without changing authority or holds', async () => {
  const { driver, f } = await setup('transfer');
  const a = await approve(driver, f);
  const operation = f.work.operation;
  if (operation.kind !== 'transfer') throw new Error('Expected native transfer fixture');
  for (const change of [
    { ...operation, operatorAccountId: f.subjectId },
    { ...operation, operatorAccountId: f.otherSubjectId },
    { ...operation, previous: { ...operation.previous, subjectAccountId: f.organizationId } },
    { ...operation, expectedVersion: '0' },
    { ...operation, previous: { ...operation.previous, reservationId: f.otherSubjectId } },
  ]) {
    const work = { operationKey: `${f.work.operationKey}:invalid`, operation: change };
    const invalid = await driver.approve(f.caller, work);
    if (invalid.outcome === 'approved') await denied(driver, f, invalid, work);
    else expect(invalid).toEqual({ outcome: 'denied' });
    await denied(driver, f, a, { ...f.work, operation: change });
  }
}, 660_000);

test('operator deletion fails while any responsibility is held and succeeds only after native subject deletion releases it', async () => {
  const driver = await d();
  const f = await driver.fixture('operator-delete', { heldResponsibilities: true });
  const a = await approve(driver, f);
  await denied(driver, f, a);
  const before = await driver.snapshot(f);
  for (const r of before.responsibilities.filter((x) => x.operatorAccountId === f.ownerId && x.held)) {
    const work: Work = {
      operationKey: `${f.work.operationKey}:subject:${r.subjectAccountId}`,
      operation: {
        kind: 'delete',
        accountId: r.subjectAccountId,
        responsibility: {
          operatorAccountId: r.operatorAccountId,
          subjectAccountId: r.subjectAccountId,
          reservationId: r.reservationId,
        },
      },
    };
    const subject = { ...f, family: 'subject-delete' as const, work, subjectId: r.subjectAccountId };
    await finishTerminal(driver, subject, await approve(driver, subject));
  }
  const finalApproval = await approve(driver, f);
  await finishTerminal(driver, f, finalApproval);
  expect((await driver.snapshot(f)).accounts.find((x) => x.id === f.ownerId)!.state).toBe('deleted');
}, 660_000);

test('subject deletion terminalizes native authority before inverse release and retains owner and relation history', async () => {
  const { driver, f } = await setup('subject-delete');
  const before = await driver.snapshot(f);
  const a = await approve(driver, f);
  let observed = false;
  expect(await driver.execute(f.caller, a.reference, f.work)).toEqual({ outcome: 'denied' });
  const c = await driver.continuation(f);
  expect(c).not.toBeNull();
  expect(
    await driver.continueCommitted(c!.reference, undefined, {
      before: { name: 'release-operator', target: f.ownerId },
      run: async () => {
        observed = true;
        const s = await driver.snapshot(f);
        expect(s.accounts.find((x) => x.id === f.subjectId)!.state).toBe('deleted');
        expect(s.responsibilities).toContainEqual(
          expect.objectContaining({
            subjectAccountId: f.subjectId,
            operatorAccountId: f.ownerId,
            held: true,
            terminal: true,
          }),
        );
      },
    }),
  ).toEqual({ outcome: 'continued' });
  expect(observed).toBe(true);
  const after = await driver.snapshot(f);
  expect(after.memberships).toEqual(before.memberships);
  expect(after.owners).toEqual(before.owners);
  expect(after.ownerInverses).toEqual(before.ownerInverses);
  expect(after.history).toEqual(before.history);
  for (const r of before.responsibilities)
    expect(after.responsibilities).toContainEqual(
      r.subjectAccountId === f.subjectId ? { ...r, held: false, terminal: true } : r,
    );
}, 660_000);

test('operator fencing uses bounded signed keyset pages and fences independent logins without inherited resource authority', async () => {
  const driver = await d();
  const f = await driver.fixture('fence-operator', { subjects: 205, independentCredentials: true });
  const ids = new Set<string>();
  let cursor: string | undefined;
  do {
    const page = await driver.page(f, 100, cursor);
    if ('outcome' in page) throw new Error('Native page positive control failed');
    expect(page.operators.length).toBeGreaterThan(0);
    expect(page.operators.length).toBeLessThanOrEqual(100);
    for (const x of page.operators) {
      expect(ids.has(x.subjectAccountId)).toBe(false);
      ids.add(x.subjectAccountId);
    }
    cursor = page.next ?? undefined;
  } while (cursor);
  expect(ids.size).toBe(205);
  const a = await approve(driver, f);
  await permitted(driver, f, a);
  const c = await driver.continuation(f);
  expect(c).not.toBeNull();
  expect(await driver.continueCommitted(c!.reference)).toEqual({ outcome: 'continued' });
  const s = await driver.snapshot(f);
  for (const id of [...ids, f.ownerId]) expect(s.accounts.find((x) => x.id === id)!.fenced).toBe(true);
  expect(await driver.access(f)).toMatchObject({
    oldManagement: false,
    oldSessionsValid: false,
    independentLogin: false,
    inheritedResourceAccess: false,
  });
}, 660_000);

test('operator fanout rejects oversized pages and cursors from another operator epoch or modified payload', async () => {
  const driver = await d();
  const f = await driver.fixture('fence-operator', { subjects: 3 });
  const p = await driver.page(f, 1);
  if ('outcome' in p || !p.next) throw new Error('Native cursor positive control failed');
  for (const mismatch of ['operator', 'epoch', 'bytes'] as const)
    expect(await driver.page(f, 1, p.next, mismatch)).toEqual({ outcome: 'denied' });
  for (const limit of [0, 101, 1.5]) expect(await driver.page(f, limit)).toEqual({ outcome: 'denied' });
}, 660_000);

test('crash recovery reuses exact native receipts and keys across organization transfer deletion and fanout steps', async () => {
  const driver = await d();
  for (const family of families.filter((x) => x !== 'opening')) {
    const template = await driver.fixture(family);
    for (const [index, step] of (await steps(driver, template)).entries()) {
      const f = await driver.fixture(family);
      const actual = (await steps(driver, f))[index]!;
      expect(actual.name).toBe(step.name);
      const a = await approve(driver, f);
      await driver.crashAfter(f, a.reference, actual);
      const committed = await driver.snapshot(f);
      await driver.restart();
      // Fencing/deletion finishes internally. A subject deletion whose caller's
      // authority remains intact returns its recorded management-basis result.
      const continuation = await driver.continuation(f);
      if (continuation) {
        expect(await driver.continueCommitted(continuation.reference)).toEqual({ outcome: 'continued' });
        if (
          family === 'fence-operator' ||
          (family === 'subject-delete' &&
            f.work.operation.kind === 'delete' &&
            Boolean(f.work.operation.responsibility))
        ) {
          const result = await permitted(driver, f, a);
          const after = await driver.snapshot(f);
          expect(await driver.execute(f.caller, a.reference, f.work)).toEqual(result);
          expect(await driver.snapshot(f)).toEqual(after);
        } else await denied(driver, f, a);
      } else if (['subject-delete', 'operator-delete', 'fence-operator'].includes(family))
        await finishTerminal(driver, f, a);
      else await permitted(driver, f, a);
      const after = await driver.snapshot(f);
      for (const receipt of committed.receipts) expect(after.receipts).toContainEqual(receipt);
      const keys = after.receipts.map((x) => `${x.kind}:${x.key}`);
      expect(new Set(keys).size).toBe(keys.length);
    }
  }
}, 660_000);

async function revokedAtEveryStep(fact: Revocation) {
  const driver = await d();
  for (const family of families) {
    if (fact === 'assignment' && family === 'opening') continue;
    const template = await driver.fixture(family);
    for (const [index, planned] of (await steps(driver, template)).entries()) {
      if (planned.authority !== 'caller') continue;
      for (const boundary of ['step', 'attempt-T'] as const) {
        const f = await driver.fixture(family);
        const step = (await steps(driver, f))[index]!;
        expect(step.name).toBe(planned.name);
        expect(step.authority).toBe('caller');
        const a = await approve(driver, f);
        let reached = false;
        let paused: Awaited<ReturnType<typeof driver.snapshot>> | undefined;
        const result = await driver.execute(f.caller, a.reference, f.work, {
          before: step,
          boundary,
          run: async () => {
            reached = true;
            await driver.revoke(f, fact);
            paused = await driver.snapshot(f);
          },
        });
        expect(reached).toBe(true);
        expect(result).toEqual({ outcome: 'denied' });
        expect(await driver.snapshot(f)).toEqual(paused!);
      }
    }
  }
}
test('every protected step rechecks current original actor grant before any receipt replay', async () => {
  await revokedAtEveryStep('actor-grant');
}, 660_000);
test('every protected step rechecks current original client consent', async () => {
  await revokedAtEveryStep('client-consent');
}, 660_000);
test('every protected step preserves the original consented scope ceiling', async () => {
  await revokedAtEveryStep('scope');
}, 660_000);
test('every protected step rechecks current principal grant', async () => {
  await revokedAtEveryStep('principal-grant');
}, 660_000);
test('every protected step rechecks current original principal assignment', async () => {
  await revokedAtEveryStep('assignment');
}, 660_000);
test('every protected step rejects a raised original actor epoch floor', async () => {
  await revokedAtEveryStep('actor-epoch');
}, 660_000);
test('every protected step rejects a fenced original actor', async () => {
  await revokedAtEveryStep('actor-fenced');
}, 660_000);
test('every protected step fails closed without authoritative evidence', async () => {
  await revokedAtEveryStep('missing-evidence');
}, 660_000);

test('completed DBOS private results cannot be disclosed after revocation restart or caller substitution', async () => {
  const driver = await d();
  for (const family of ['organization', 'transfer', 'opening'] as const) {
    for (const fact of [
      'actor-grant',
      'client-consent',
      'scope',
      'principal-grant',
      'assignment',
      'actor-epoch',
      'actor-fenced',
      'missing-evidence',
    ] as const) {
      if (family === 'opening' && fact === 'assignment') continue;
      const f = await driver.fixture(family);
      const a = await approve(driver, f);
      await permitted(driver, f, a);
      const before = await driver.snapshot(f);
      expect(await driver.execute(f.otherClientCaller, a.reference, f.work)).toEqual({ outcome: 'denied' });
      expect(await driver.snapshot(f)).toEqual(before);
      await driver.revoke(f, fact);
      await driver.restart();
      await denied(driver, f, a);
    }
  }
}, 660_000);

test('current callers and fresh approvals reuse the exact native operation receipts without repeating effects', async () => {
  const driver = await d();
  for (const family of ['organization', 'transfer', 'opening'] as const) {
    const f = await driver.fixture(family);
    const a = await approve(driver, f);
    const first = await permitted(driver, f, a);
    const state = await driver.snapshot(f);
    await driver.restart();
    expect(await driver.execute(f.caller, a.reference, f.work)).toEqual(first);
    expect(await driver.snapshot(f)).toEqual(state);
    const fresh = await approve(driver, f);
    expect(await driver.execute(f.caller, fresh.reference, f.work)).toEqual(first);
    expect(await driver.snapshot(f)).toEqual(state);
  }
}, 660_000);

test('immutable approvals reject changed key target old hold version handle and purpose after restart', async () => {
  const driver = await d();
  for (const family of families) {
    const f = await driver.fixture(family);
    const a = await approve(driver, f);
    const other = await driver.fixture(family);
    const untouched = await driver.snapshot(other);
    await driver.restart();
    await denied(driver, f, a, { ...f.work, operationKey: `${f.work.operationKey}:other` });
    await denied(driver, f, a, { ...f.work, operation: other.work.operation });
    await denied(driver, f, a, {
      ...f.work,
      operation: { kind: 'opening', operatorAccountId: f.ownerId, subjectAccountId: f.otherSubjectId },
    });
    expect(await driver.execute(f.caller, { ...f.identity }, f.work)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(other)).toEqual(untouched);
  }
}, 660_000);

test('exact current operator session opening requires SAME native formula for self and organization management', async () => {
  const driver = await d();
  for (const organizationOperator of [false, true]) {
    const f = await driver.fixture('opening', { organizationOperator });
    const a = await approve(driver, f);
    await permitted(driver, f, a);
    expect((await driver.consumeOpening(f)).outcome).toBe('permitted');
    expect(await driver.consumeOpening(f)).toEqual({ outcome: 'denied' });
  }
}, 660_000);

test('session opening cannot change subject purpose human client relation epoch or use stale operator authority', async () => {
  const driver = await d();
  for (const mismatch of ['subject', 'purpose', 'human', 'client', 'relation', 'epoch'] as const) {
    const f = await driver.fixture('opening');
    await permitted(driver, f, await approve(driver, f));
    const before = await driver.snapshot(f);
    expect(await driver.consumeOpening(f, mismatch)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(f)).toEqual(before);
  }
  for (const fact of ['actor-grant', 'principal-grant', 'client-consent', 'operator-relation'] as const) {
    const f = await driver.fixture('opening');
    const a = await approve(driver, f);
    await permitted(driver, f, a);
    await driver.revoke(f, fact);
    await denied(driver, f, a);
    expect(await driver.consumeOpening(f)).toEqual({ outcome: 'denied' });
  }
  const f = await driver.fixture('opening', { organizationOperator: true });
  const a = await approve(driver, f);
  await permitted(driver, f, a);
  await driver.revoke(f, 'organization-membership');
  await denied(driver, f, a);
  expect(await driver.consumeOpening(f)).toEqual({ outcome: 'denied' });
}, 660_000);

test('committed fencing cleanup survives caller revocation but grants no user result and only exact native allowlisted effects', async () => {
  const driver = await d();
  for (const family of ['fence-operator', 'subject-delete'] as const) {
    const f = await driver.fixture(family, { subjects: 3 });
    const a = await approve(driver, f);
    const beforeBarrier = await driver.snapshot(f);
    expect(await driver.continueCommitted(a.reference)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(f)).toEqual(beforeBarrier);
    const name = family === 'fence-operator' ? 'fence' : 'tombstone-account';
    const step = (await steps(driver, f)).find((s) => s.name === name)!;
    await driver.crashAfter(f, a.reference, step);
    const c = await driver.continuation(f);
    expect(c).not.toBeNull();
    expect(c!.operationKey).toBe(f.work.operationKey);
    expect(c!.operationDigest).toBe(await driver.digest(f.work));
    expect(c!.allowed.length).toBeGreaterThan(0);
    expect(Number.isFinite(Date.parse(c!.expiresAt))).toBe(true);
    expect((await driver.snapshot(f)).receipts.some((r) => r.id === c!.barrierReceiptId)).toBe(true);
    await driver.revoke(f, 'actor-grant');
    await driver.restart();
    await denied(driver, f, a);
    expect(await driver.continueCommitted(c!.reference)).toEqual({ outcome: 'continued' });
    const extended = await driver.continuation(f);
    expect(extended).not.toBeNull();
    for (const rootEntry of c!.allowed) expect(extended!.allowed).toContainEqual(rootEntry);
    const effects = await driver.continuationEffects(f);
    expect(effects.length).toBeGreaterThan(0);
    for (const { receiptId, ...effect } of effects) {
      expect(extended!.allowed).toContainEqual(effect);
      expect(
        (await driver.snapshot(f)).receipts.some(
          (r) => r.id === receiptId && r.key === effect.key && r.digest === effect.digest,
        ),
      ).toBe(true);
    }
    const after = await driver.snapshot(f);
    expect(await driver.continueCommitted(c!.reference)).toEqual({ outcome: 'continued' });
    expect(await driver.snapshot(f)).toEqual(after);
    await denied(driver, f, a);
  }
}, 660_000);

test('cleanup cannot widen target step key digest expiry or operation and expired cleanup never releases holds by TTL', async () => {
  const { driver, f } = await setup('fence-operator');
  const a = await approve(driver, f);
  await driver.crashAfter(
    f,
    a.reference,
    (await steps(driver, f)).find((s) => s.name === 'fence')!,
  );
  const c = await driver.continuation(f);
  expect(c).not.toBeNull();
  const unchanged = await driver.snapshot(f);
  expect(await driver.continueCommitted(`${c!.reference}x`)).toEqual({ outcome: 'denied' });
  expect(await driver.snapshot(f)).toEqual(unchanged);
  const item = c!.allowed[0]!;
  for (const override of [
    { operationKey: `${c!.operationKey}:other` },
    { operationDigest: '00'.repeat(32) },
    { barrierReceiptId: f.otherSubjectId },
    { expiresAt: '9999-01-01T00:00:00.000Z' },
    ...[
      { target: f.otherSubjectId },
      { step: 'authorize-opening' },
      { key: `${item.key}:other` },
      { digest: 'ff'.repeat(32) },
    ].map((change) => ({ allowed: [{ ...item, ...change }] })),
  ]) {
    const before = await driver.snapshot(f);
    expect(await driver.continueCommitted(c!.reference, override)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(f)).toEqual(before);
  }
  await driver.awaitExpiry(c!.reference);
  const before = await driver.snapshot(f);
  expect(await driver.continueCommitted(c!.reference)).toEqual({ outcome: 'denied' });
  expect(await driver.snapshot(f)).toEqual(before);
  expect(before.responsibilities.some((r) => r.held)).toBe(true);
  const result = await permitted(driver, f, a);
  const saved = await driver.snapshot(f);
  expect(await driver.execute(f.caller, a.reference, f.work)).toEqual(result);
  expect(await driver.snapshot(f)).toEqual(saved);
}, 660_000);

test('approval expiry and durable workflow storage never preserve bearer credentials or resolved actor contexts', async () => {
  const driver = await d();
  for (const family of ['organization', 'transfer', 'opening'] as const) {
    const f = await driver.fixture(family);
    const a = await approve(driver, f);
    await permitted(driver, f, a);
    const state = await driver.durableState(f);
    expect(state.records).toBeGreaterThan(0);
    expect(state.approvals).toBeGreaterThan(0);
    expect(state).toMatchObject({ bearerTokens: 0, refreshTokens: 0, credentials: 0, actorContexts: 0 });
    await driver.awaitExpiry(a.reference);
    expect(await driver.approval(a.reference)).not.toBeNull();
    await driver.restart();
    await denied(driver, f, a);
  }
}, 1_020_000);

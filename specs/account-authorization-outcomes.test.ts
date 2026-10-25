import { afterEach, expect, test } from 'bun:test';
import type { AccountAuthorizationDriver, Fixture, Operation, Approval } from './account-authorization-driver.ts';

let driver: AccountAuthorizationDriver | undefined;
async function d() {
  if (driver) return driver;
  const module = process.env.ACCOUNT_AUTHORIZATION_DRIVER_MODULE;
  if (!module) throw new Error('Missing account authorization driver');
  driver = await (await import(module)).createAccountAuthorizationDriver();
  return driver!;
}
afterEach(async () => {
  await driver?.close();
  driver = undefined;
});
async function setup() {
  const driver = await d();
  return { driver, f: await driver.seed() };
}
async function approval(driver: AccountAuthorizationDriver, f: Fixture): Promise<Approval> {
  const result = await driver.approve(f.caller, f.operation);
  expect(result.outcome).toBe('approved');
  if (result.outcome !== 'approved') throw new Error('Approval positive control failed');
  return result;
}
async function control(driver: AccountAuthorizationDriver, f: Fixture) {
  const a = await approval(driver, f);
  const result = await driver.execute(a.reference, f.operation);
  expect(result.outcome).toBe('permitted');
  expect((await driver.snapshot(f)).effects).toBe(1);
  return a;
}
async function denies(driver: AccountAuthorizationDriver, f: Fixture, reference: unknown, operation = f.operation) {
  const before = await driver.snapshot(f);
  expect(await driver.execute(reference, operation)).toEqual({ outcome: 'denied' });
  expect(await driver.snapshot(f)).toEqual(before);
}

test('authenticated approval binds exact operation actor client scopes principal target purpose and digest durably', async () => {
  const { driver, f } = await setup();
  const a = await approval(driver, f);
  expect(await driver.reference(a.reference)).toEqual({
    actorId: f.actorId,
    clientId: f.clientId,
    scopes: f.scopes,
    requestedBy: f.requestedBy,
    target: f.operation.accountId,
    purpose: 'rename',
    operationKey: f.operation.key,
    digest: await driver.operationDigest(f.operation),
    expiresAt: a.expiresAt,
  });
  await driver.restart();
  expect((await driver.execute(a.reference, f.operation)).outcome).toBe('permitted');
  expect((await driver.snapshot(f)).effects).toBe(1);
  const next = await driver.seed();
  expect(await driver.approve(next.unauthenticated, next.operation)).toEqual({ outcome: 'denied' });
});

test('durable references cannot resolve to another operation account purpose or client', async () => {
  const { driver, f } = await setup();
  await control(driver, f);
  for (const change of ['key', 'account', 'purpose', 'digest', 'client'] as const) {
    const next = await driver.seed();
    const a = await approval(driver, next);
    await driver.restart();
    const operation: Operation =
      change === 'key'
        ? { ...next.operation, key: `${next.operation.key}-other` }
        : change === 'account'
          ? { ...next.operation, accountId: next.otherAccountId }
          : change === 'purpose'
            ? { kind: 'delete', accountId: next.operation.accountId, key: next.operation.key }
            : change === 'digest'
              ? { ...next.operation, handle: `${next.operation.handle}x` }
              : next.operation;
    if (change === 'client')
      expect(await driver.resolveAs(next.otherClientCaller, a.reference, operation)).toEqual({ outcome: 'denied' });
    else await denies(driver, next, a.reference, operation);
    expect((await driver.snapshot(next)).effects).toBe(0);
  }
});

test('request JSON raw bearer tokens and caller supplied actors never replace capability references', async () => {
  const { driver, f } = await setup();
  await control(driver, f);
  const next = await driver.seed();
  const a = await approval(driver, next);
  const actor = {
    accountId: next.actorId,
    clientId: next.clientId,
    scopes: next.scopes,
    requestedBy: next.requestedBy,
    authnEpoch: 999,
  };
  for (const forged of [
    actor,
    { authorization: a.reference, actor },
    JSON.stringify(actor),
    next.rawAccessToken,
    next.rawRefreshToken,
    'approved:true',
    'unknown-reference',
  ]) {
    await denies(driver, next, forged);
  }
  expect(a.reference).not.toBe(next.rawAccessToken);
  expect(a.reference).not.toBe(next.rawRefreshToken);
  expect((await driver.execute(a.reference, next.operation)).outcome).toBe('permitted');
});

test('every protected workflow step rechecks the native formula and current state at T', async () => {
  const { driver, f } = await setup();
  await control(driver, f);
  const steps = await driver.protectedSteps(f.operation);
  expect(steps.length).toBeGreaterThan(1);
  expect(new Set(steps).size).toBe(steps.length);
  for (const step of steps) {
    for (const fact of [
      'actor-grant',
      'consent',
      'principal-grant',
      'assignment',
      'scope',
      'epoch',
      'suspended',
      'deleted',
      'fence',
      'explicit-deny',
      'missing-evidence',
    ] as const) {
      const next = await driver.seed();
      const a = await approval(driver, next);
      let reached = false;
      const result = await driver.execute(a.reference, next.operation, {
        beforeStep: step,
        run: async () => {
          reached = true;
          await driver.revoke(next, fact);
        },
      });
      expect(reached).toBe(true);
      expect(result).toEqual({ outcome: 'denied' });
      expect(await driver.effectsAfterCheckpoint(next)).toBe(0);
    }
  }
});

test('revocation hides a stored replay result and restoration replays one original effect', async () => {
  const { driver, f } = await setup();
  const a = await approval(driver, f);
  const first = await driver.execute(a.reference, f.operation);
  expect(first).toMatchObject({ outcome: 'permitted', replayed: false });
  await driver.revoke(f, 'actor-grant');
  await driver.restart();
  await denies(driver, f, a.reference);
  await driver.restoreGrant(f);
  expect(await driver.execute(a.reference, f.operation)).toEqual({ ...first, replayed: true });
  expect((await driver.snapshot(f)).effects).toBe(1);
  const next = await driver.seed();
  await denies(driver, next, a.reference);
});

test('expiry fails closed before GC and restart cannot renew the approval', async () => {
  const { driver, f } = await setup();
  await control(driver, f);
  const next = await driver.seed();
  const a = await approval(driver, next);
  expect(Number.isFinite(Date.parse(a.expiresAt))).toBe(true);
  expect(Date.parse(a.expiresAt)).toBeGreaterThan(Date.now());
  await driver.awaitExpiry(a.reference);
  expect(await driver.reference(a.reference)).not.toBeNull();
  await driver.restart();
  await denies(driver, next, a.reference);
});

test('automation requires its own credential or an exact current operator opening', async () => {
  const { driver, f } = await setup();
  expect((await driver.signInAutomated(f, 'own')).outcome).toBe('permitted');
  expect(await driver.signInAutomated(f, 'other')).toEqual({ outcome: 'denied' });
  expect(await driver.signInAutomated(f, 'none')).toEqual({ outcome: 'denied' });
  const opening = await driver.opening(f, 'session');
  expect((await driver.consumeOpening(f, opening.reference)).outcome).toBe('permitted');
  const next = await driver.seed();
  const stale = await driver.opening(next, 'session');
  await driver.revoke(next, 'operator-relation');
  expect(await driver.consumeOpening(next, stale.reference)).toEqual({ outcome: 'denied' });
});

test('operator opening consumption is atomic one use with no wrong subject purpose human or client replay', async () => {
  const { driver, f } = await setup();
  const a = await driver.opening(f, 'session');
  const concurrent = await Promise.all([driver.consumeOpening(f, a.reference), driver.consumeOpening(f, a.reference)]);
  expect(concurrent.filter((r) => r.outcome === 'permitted')).toHaveLength(1);
  expect(concurrent.filter((r) => r.outcome === 'denied')).toEqual([{ outcome: 'denied' }]);
  await driver.restart();
  expect(await driver.consumeOpening(f, a.reference)).toEqual({ outcome: 'denied' });
  for (const mismatch of ['subject', 'purpose', 'human', 'client', 'expired'] as const) {
    const next = await driver.seed();
    const opening = await driver.opening(next, 'session');
    if (mismatch === 'expired') await driver.awaitExpiry(opening.reference);
    expect(await driver.consumeOpening(next, opening.reference, mismatch)).toEqual({ outcome: 'denied' });
  }
});

test('credential authorization binds the exact Auth purpose despite a broad native credential opening', async () => {
  const { driver, f } = await setup();
  const a = await driver.opening(f, 'set-password');
  expect(await driver.consumeOpening(f, a.reference, 'remove-key')).toEqual({ outcome: 'denied' });
  expect((await driver.consumeOpening(f, a.reference)).outcome).toBe('permitted');
  expect(await driver.consumeOpening(f, a.reference)).toEqual({ outcome: 'denied' });
});

test('provisioning trusts only a committed exact pending registration command receipt', async () => {
  const { driver, f } = await setup();
  const committed = await driver.pendingProof(f, 'committed');
  await driver.restart();
  expect((await driver.provision(f, committed)).outcome).toBe('permitted');
  for (const invalid of [
    'rolled-back',
    'uncommitted',
    'expired',
    'wrong-kind',
    'other-account',
    'reservation-only',
    'shape-only',
  ] as const) {
    const next = await driver.seed();
    const reference = await driver.pendingProof(next, invalid);
    const before = await driver.snapshot(next);
    expect(await driver.provision(next, reference)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(next)).toEqual(before);
  }
});

test('consent and recovery barriers commit exact account floors and fence before Auth effects', async () => {
  const { driver } = await setup();
  for (const kind of ['consent', 'recovery'] as const) {
    const f = await driver.seed();
    let observed = false;
    expect(
      (
        await driver.barrier(f, kind, undefined, async (barrier) => {
          observed = true;
          expect(barrier.accountId).toBe(f.actorId);
          expect(barrier.previousFloor).toBe(f.floor);
          expect(BigInt(barrier.newFloor)).toBeGreaterThan(BigInt(f.floor));
          expect(barrier.receiptId.length).toBeGreaterThan(0);
          await driver.restartAccessReader();
          expect(await driver.fence(f.actorId)).toEqual({
            receiptId: barrier.receiptId,
            floor: barrier.newFloor,
            fenced: true,
          });
          expect(await driver.oldSessionAllowed(f)).toBe(false);
        })
      ).outcome,
    ).toBe('permitted');
    expect(observed).toBe(true);
    for (const invalid of [
      'account',
      'previous-floor',
      'new-floor',
      'receipt',
      'untrusted-proof',
      'stale-proof',
    ] as const) {
      const next = await driver.seed();
      const before = await driver.snapshot(next);
      expect(await driver.barrier(next, kind, invalid)).toEqual({ outcome: 'denied' });
      expect(await driver.snapshot(next)).toEqual(before);
    }
  }
});

test('missing production capabilities deny before any Auth side effects', async () => {
  const { driver, f } = await setup();
  await control(driver, f);
  for (const capability of [
    'authorizeOperation',
    'verifyProvisioningReceipt',
    'consumeAuthAuthorization',
    'invalidateAccount',
    'authorizeRecovery',
  ] as const) {
    const next = await driver.seed();
    const before = await driver.snapshot(next);
    expect(await driver.withoutCapability(next, capability)).toEqual({ outcome: 'denied' });
    expect(await driver.snapshot(next)).toEqual(before);
  }
});

test('self account read and fenced human recovery keep their native exceptions without generic allow', async () => {
  const { driver, f } = await setup();
  expect((await driver.nativeException(f, 'self-read')).outcome).toBe('permitted');
  expect((await driver.nativeException(f, 'fenced-human-recovery')).outcome).toBe('permitted');
  for (const invalid of [
    'other-account-read',
    'automated-recovery',
    'organization-recovery',
    'stale-recovery',
    'generic-write',
  ] as const) {
    expect(await driver.nativeException(f, invalid)).toEqual({ outcome: 'denied' });
  }
});

test('durable workflow state contains nonsecret references and no tokens credentials or actor contexts', async () => {
  const { driver, f } = await setup();
  await control(driver, f);
  const state = await driver.durableState(f);
  expect(state.records).toBeGreaterThan(0);
  expect(state.references).toBeGreaterThan(0);
  expect(state.accessTokens).toBe(0);
  expect(state.refreshTokens).toBe(0);
  expect(state.plaintextCredentials).toBe(0);
  expect(state.actorContexts).toBe(0);
});

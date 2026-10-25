import { afterEach, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { isAbsolute } from 'node:path';
import { pathToFileURL } from 'node:url';
import type { CredentialEffect } from '../services/auth/src/index.ts';
import type {
  Approval,
  Fixture,
  Mode,
  NativeCredentialEffectDriver,
  Operation,
  Purpose,
  Reply,
  Result,
  Revocation,
} from './native-credential-effect-driver.ts';

let driver: NativeCredentialEffectDriver | undefined;
async function d() {
  if (driver) return driver;
  const location = process.env.NATIVE_CREDENTIAL_EFFECT_DRIVER_MODULE;
  if (!location) throw new Error('Missing native credential effect driver');
  if (!isAbsolute(location) && !location.startsWith('file:'))
    throw new Error('Driver must use an absolute path or file URL');
  const url = isAbsolute(location) ? pathToFileURL(location) : new URL(location);
  if (url.protocol !== 'file:') throw new Error('Driver must use a file URL');
  driver = await (await import(url.href)).createNativeCredentialEffectDriver();
  return driver!;
}
afterEach(async () => {
  const current = driver;
  driver = undefined;
  await current?.close();
});
const purposes: Purpose[] = ['set-password', 'remove-password', 'add-key', 'remove-key'];
const modes: Mode[] = ['own-human', 'human-operator', 'organization-operator'];
async function ok<T>(reply: Reply<T>): Promise<T> {
  expect(reply.response.status).toBe(200);
  expect(reply.value).toBeDefined();
  expect(await reply.response.clone().json()).toEqual(reply.value);
  return reply.value!;
}
async function denied(reply: Reply<unknown>, effect = true) {
  expect([400, 401, 403, 404, 409]).toContain(reply.response.status);
  expect(reply.value).toBeUndefined();
  const body = await reply.response.clone().json();
  if (effect) expect(body.effect_status).toBe('not_applied');
  for (const field of ['receiptId', 'reference', 'digest', 'effectRef']) expect(body[field]).toBeUndefined();
}
function credential(f: Fixture, purpose: Purpose): CredentialEffect {
  switch (purpose) {
    case 'set-password':
      return { kind: 'password', password: f.password };
    case 'remove-password':
      return { kind: 'password', password: null };
    case 'add-key':
      return f.newKey;
    case 'remove-key':
      return { kind: 'key', kid: f.existingKid, remove: true };
  }
}
async function staged(f: Fixture, purpose: Purpose = 'set-password') {
  return ok(
    await driver!.stage(f.caller, { key: randomUUID(), subjectId: f.subjectId, credential: credential(f, purpose) }),
  );
}
async function approved(f: Fixture, op: Operation): Promise<Approval> {
  return ok(await driver!.approve(f.caller, op));
}
async function rejects(f: Fixture, a: Approval, op: Operation, caller = f.caller, reference: unknown = a.reference) {
  const before = await driver!.inspect(f);
  await denied(await driver!.apply(caller, reference, op));
  expect(await driver!.inspect(f)).toEqual(before);
}
async function applied(f: Fixture, op: Operation, a: Approval): Promise<Result> {
  const result = await ok(await driver!.apply(f.caller, a.reference, op));
  expect(result.replayed).toBe(false);
  const after = await driver!.inspect(f);
  expect(after.committed).toEqual([{ ...op, receiptId: result.receiptId }]);
  expect(after.passwordInstalled).toBe(op.purpose !== 'remove-password');
  expect(after.candidatePasswordMatches).toBe(op.purpose === 'set-password');
  expect(after.keyIds.includes(f.existingKid)).toBe(op.purpose !== 'remove-key');
  expect(after.keyIds.includes(f.newKey.kid)).toBe(op.purpose === 'add-key');
  if (op.purpose === 'add-key') {
    expect(after.floor).toBe(f.floor);
  } else {
    expect(BigInt(after.floor)).toBeGreaterThan(BigInt(f.floor));
    expect(after.sessions).toEqual([]);
  }
  return result;
}

test('precise native credential effect reference outcomes are executable red cases', async () => {
  const native = await d();
  for (const mode of modes)
    for (const purpose of purposes) {
      const f = await native.seed(mode, 64);
      const op = await staged(f, purpose);
      expect(op.subjectId).toBe(f.subjectId);
      expect(op.purpose).toBe(purpose);
      expect(op.digest).toMatch(/^[a-f0-9]{64}$/);
      expect(op.effectRef.length).toBeGreaterThan(0);
      await applied(f, op, await approved(f, op));
    }
});

test('own human and operator management bind exact purpose and target', async () => {
  const native = await d();
  for (const mode of modes)
    for (const purpose of purposes) {
      const f = await native.seed(mode);
      const op = await staged(f, purpose);
      const a = await approved(f, op);
      const b = await native.binding(a.reference);
      expect(b).toEqual({
        ...op,
        humanId: f.humanId,
        clientId: f.clientId,
        scopes: f.scopes,
        operatorId: f.operatorId,
        nativePurpose: mode === 'own-human' ? null : 'credential-management',
        openingId: b.openingId,
        createdAt: b.createdAt,
        expiresAt: a.expiresAt,
      });
      expect(mode === 'own-human' ? b.openingId === null : typeof b.openingId === 'string').toBe(true);
      const lifetime = Date.parse(b.expiresAt) - Date.parse(b.createdAt);
      expect(lifetime).toBeGreaterThan(0);
      expect(lifetime).toBeLessThanOrEqual(60_000);
      await native.restart();
      await applied(f, op, a);
    }
});

test('all four credential purposes reject every cross-purpose substitution before effects', async () => {
  const native = await d();
  for (const mode of modes)
    for (const purpose of purposes) {
      const f = await native.seed(mode);
      const op = await staged(f, purpose);
      const a = await approved(f, op);
      for (const other of purposes.filter((p) => p !== purpose)) await rejects(f, a, { ...op, purpose: other });
      await applied(f, op, a);
    }
});

test('changed effect target operation key and untrusted digest cannot consume an exact opening', async () => {
  const native = await d();
  for (const mode of modes)
    for (const purpose of purposes) {
      const f = await native.seed(mode);
      const op = await staged(f, purpose);
      const alternate = await ok(
        await native.stage(f.caller, {
          key: randomUUID(),
          subjectId: f.subjectId,
          credential:
            purpose === 'set-password'
              ? { kind: 'password', password: f.otherPassword }
              : purpose === 'remove-key'
                ? { kind: 'key', kid: f.otherExistingKid, remove: true }
                : purpose === 'add-key'
                  ? {
                      ...f.newKey,
                      kid: `${f.newKey.kid}-other`,
                      publicJwk: { ...f.newKey.publicJwk, kid: `${f.newKey.kid}-other` },
                    }
                  : { kind: 'password', password: null },
        }),
      );
      const a = await approved(f, op);
      for (const changed of [
        { ...op, key: randomUUID() },
        { ...op, subjectId: f.otherSubjectId },
        { ...op, effectRef: alternate.effectRef },
        { ...op, digest: alternate.digest },
        { ...op, effectRef: alternate.effectRef, digest: alternate.digest },
        { ...op, digest: '0'.repeat(64) },
      ])
        await rejects(f, a, changed);
      await applied(f, op, a);
    }
});

test('current native human proof and exact client cannot be replaced by human bot or JSON claims', async () => {
  const native = await d();
  for (const mode of modes) {
    const f = await native.seed(mode);
    const op = await staged(f);
    const a = await approved(f, op);
    for (const caller of [f.otherHuman, f.otherClient, f.automatedCaller, f.unauthenticated]) {
      await rejects(f, a, op, caller);
      const before = await native.inspect(f);
      await denied(await native.approve(caller, op));
      expect(await native.inspect(f)).toEqual(before);
    }
    for (const reference of [
      { ...a, humanId: f.humanId, epoch: 999999, approved: true },
      JSON.stringify(a),
      f.rawAccessToken,
      f.rawRefreshToken,
    ])
      await rejects(f, a, op, f.caller, reference);
    await applied(f, op, a);
  }
});

test('broad native opening and device or session purposes never authorize credentials', async () => {
  const native = await d();
  for (const purpose of purposes) {
    const f = await native.seed('human-operator');
    const op = await staged(f, purpose);
    const a = await approved(f, op);
    for (const nativePurpose of ['credential-management', 'session'] as const) {
      const reference = await native.broadOpening(f, nativePurpose);
      await rejects(f, a, op, f.caller, reference);
    }
    for (const substitute of ['session', 'device', 'credential-management']) {
      // Deliberately outside the typed transport contract: native validation owns refusal.
      await rejects(f, a, { ...op, purpose: substitute } as Operation);
    }
    for (const other of ['session', 'device'] as const) {
      const before = await native.inspect(f);
      await denied(await native.otherPurpose(f.caller, a.reference, f.subjectId, other), false);
      expect(await native.inspect(f)).toEqual(before);
    }
    await applied(f, op, a);
  }
});

test('organizations cannot hold credentials and automated subjects cannot become operators', async () => {
  const native = await d();
  for (const mode of ['human-operator', 'organization-operator'] as const)
    for (const purpose of purposes) {
      const f = await native.seed(mode);
      const op = await staged(f, purpose);
      const a = await approved(f, op);
      const before = await native.inspect(f);
      await denied(
        await native.stage(f.caller, {
          key: randomUUID(),
          subjectId: f.organizationId,
          credential: credential(f, purpose),
        }),
      );
      await denied(await native.approve(f.caller, { ...op, subjectId: f.organizationId }));
      expect(await native.inspect(f)).toEqual(before);
      await rejects(f, a, { ...op, subjectId: f.organizationId });
      await denied(await native.automateOperator(f));
      expect(await native.inspect(f)).toEqual(before);
      await applied(f, op, a);
    }
});

test('every consume rechecks the same native formula state floor and current operator relation', async () => {
  const native = await d();
  const common: Revocation[] = [
    'consent',
    'scope',
    'missing-evidence',
    'human-floor',
    'subject-floor',
    'human-suspended',
    'subject-deleted',
    'subject-fenced',
  ];
  for (const mode of modes) {
    const facts: Revocation[] =
      mode === 'own-human'
        ? common
        : [
            ...common,
            'operator-floor',
            'operator-relation',
            ...(mode === 'organization-operator' ? (['actor-grant', 'organization-membership'] as const) : []),
          ];
    for (const fact of facts) {
      const f = await native.seed(mode);
      const op = await staged(f, 'add-key');
      const a = await approved(f, op);
      let checkpoint = false;
      let afterRevocation: Awaited<ReturnType<typeof native.inspect>> | undefined;
      await denied(
        await native.apply(f.caller, a.reference, op, {
          at: 'before-native-consume',
          async run() {
            checkpoint = true;
            await native.revoke(f, fact);
            afterRevocation = await native.inspect(f);
          },
        }),
      );
      expect(checkpoint).toBe(true);
      expect(afterRevocation).toBeDefined();
      expect(await native.inspect(f)).toEqual(afterRevocation!);
    }
  }
});

test('authority lost after native consumption cannot reach the Auth credential commit', async () => {
  const native = await d();
  for (const mode of modes)
    for (const fact of ['consent', 'subject-floor', 'subject-fenced'] as const) {
      const f = await native.seed(mode);
      const op = await staged(f);
      const a = await approved(f, op);
      let reached = false;
      await denied(
        await native.apply(f.caller, a.reference, op, {
          at: 'after-native-consume-before-auth-commit',
          async run() {
            reached = true;
            await native.revoke(f, fact);
          },
        }),
      );
      expect(reached).toBe(true);
      expect((await native.inspect(f)).committed).toEqual([]);
      expect((await native.inspect(f)).candidatePasswordMatches).toBe(false);
      await rejects(f, a, op);
    }
});

test('native expiry denies retained openings without extending or reopening them', async () => {
  const native = await d();
  for (const mode of modes) {
    const f = await native.seed(mode);
    const op = await staged(f);
    const a = await approved(f, op);
    const before = await native.binding(a.reference);
    await native.awaitExpiry(a.reference);
    await native.restart();
    expect(await native.binding(a.reference)).toEqual(before);
    await rejects(f, a, op);
  }
});

test('lost acknowledgement cannot repeat a credential effect', async () => {
  const native = await d();
  for (const mode of modes)
    for (const at of ['opening-consumed', 'effect-committed'] as const) {
      const f = await native.seed(mode);
      const op = await staged(f, 'add-key');
      const a = await approved(f, op);
      await native.loseAcknowledgement(f, a, op, at);
      await native.restart();
      const before = await native.inspect(f);
      expect(before.committed.length).toBe(at === 'effect-committed' ? 1 : 0);
      for (let retry = 0; retry < 2; retry++) {
        const response = await native.apply(f.caller, a.reference, op);
        if (at === 'effect-committed' && response.response.status === 200) {
          expect(await ok(response)).toEqual({ receiptId: before.committed[0]!.receiptId, replayed: true });
        } else await denied(response);
        expect(await native.inspect(f)).toEqual(before);
      }
      await native.revoke(f, mode === 'organization-operator' ? 'actor-grant' : 'human-suspended');
      await rejects(f, a, op);
    }
});

test('fresh authenticated approval resumes only the same immutable credential operation', async () => {
  const native = await d();
  for (const mode of modes)
    for (const purpose of ['set-password', 'add-key'] as const) {
      const f = await native.seed(mode);
      const op = await staged(f, purpose);
      const a = await approved(f, op);
      await native.loseAcknowledgement(f, a, op, 'opening-consumed');
      await native.restart();
      await rejects(f, a, op);
      const before = await native.inspect(f);
      await denied(
        await native.stage(f.caller, {
          key: op.key,
          subjectId: op.subjectId,
          credential: { kind: 'password', password: f.otherPassword },
        }),
      );
      expect(await native.inspect(f)).toEqual(before);
      const freshCaller = await native.authenticateAgain(f);
      const next = await ok(await native.approve(freshCaller, op));
      expect(next.reference).not.toBe(a.reference);
      const alternate = await staged(f, 'remove-key');
      await rejects(f, next, { ...op, effectRef: alternate.effectRef, digest: alternate.digest }, freshCaller);
      expect((await ok(await native.apply(freshCaller, next.reference, op))).replayed).toBe(false);
      expect((await native.inspect(f)).committed).toHaveLength(1);
      await rejects(f, a, op);
    }
});

test('committed Auth effect receipt disclosure still requires current management authority', async () => {
  const native = await d();
  for (const mode of modes)
    for (const fact of ['consent', 'human-floor', 'subject-floor', 'subject-fenced'] as const) {
      const f = await native.seed(mode);
      const op = await staged(f, 'add-key');
      const a = await approved(f, op);
      await native.loseAcknowledgement(f, a, op, 'effect-committed');
      await native.restart();
      expect((await native.inspect(f)).committed).toHaveLength(1);
      await native.revoke(f, fact);
      await rejects(f, a, op);
    }
});

test('concurrent consumption commits at most one credential effect and exact success receipt', async () => {
  const native = await d();
  const f = await native.seed('human-operator');
  const op = await staged(f, 'add-key');
  const a = await approved(f, op);
  const replies = await Promise.all([native.apply(f.caller, a.reference, op), native.apply(f.caller, a.reference, op)]);
  const successes = replies.filter((r) => r.response.status === 200);
  expect(successes.length).toBeGreaterThan(0);
  const effects = (await native.inspect(f)).committed;
  expect(effects).toHaveLength(1);
  const results = await Promise.all(successes.map((r) => ok(r)));
  expect(results.filter((r) => !r.replayed)).toHaveLength(1);
  for (const result of results) expect(result.receiptId).toBe(effects[0]!.receiptId);
  for (const reply of replies.filter((r) => r.response.status !== 200)) await denied(reply);
});

test('own credential automated sign-in remains independent of operator management authority', async () => {
  const native = await d();
  const f = await native.seed('organization-operator');
  const op = await staged(f, 'add-key');
  const a = await approved(f, op);
  await native.revoke(f, 'actor-grant');
  await rejects(f, a, op);
  const proof = await ok(await native.signInAutomated(f, 'own'));
  expect(proof.account_id).toBe(f.subjectId);
  expect(proof.amr).not.toContain('operator');
  await denied(await native.signInAutomated(f, 'wrong'), false);
  await denied(await native.signInAutomated(f, 'none'), false);
});

test('Access and DBOS persist only nonsecret exact locators without permission contexts', async () => {
  const native = await d();
  for (const mode of modes)
    for (const purpose of ['set-password', 'add-key'] as const) {
      const f = await native.seed(mode);
      const op = await staged(f, purpose);
      const a = await approved(f, op);
      await applied(f, op, a);
      await native.restart();
      const stored = await native.persisted(f);
      expect(stored.accessRows).toBeGreaterThan(0);
      expect(stored.durableRows).toBeGreaterThan(0);
      expect(stored.nonsecretReferences).toBeGreaterThan(0);
      expect(stored.plaintextPasswords).toBe(0);
      expect(stored.privateKeys).toBe(0);
      expect(stored.tokens).toBe(0);
      expect(stored.permissionContexts).toBe(0);
      expect(stored.credentialPayloads).toBe(0);
    }
});

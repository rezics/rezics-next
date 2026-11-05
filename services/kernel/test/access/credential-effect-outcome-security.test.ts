import { afterAll, beforeAll, expect, setDefaultTimeout, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { parsePasskeyEnrollmentOptions, securityResponseByteBudgets, securityScopeLimit } from '@rezics/auth-contract';
import { createNativeCredentialEffectDriver } from './credential-effect-outcome-driver';
import { authenticator } from '../../../auth/test/support/passkey-authenticator';
import {
  classifyPasswordChangeReply,
  createPasswordChangeAttempt,
} from '../../../../apps/auth/src/password-change-attempt';

setDefaultTimeout(300_000);
let driver: Awaited<ReturnType<typeof createNativeCredentialEffectDriver>>;
beforeAll(async () => {
  driver = await createNativeCredentialEffectDriver({ retainHumanPasskey: false });
});
afterAll(async () => {
  await driver?.close();
});
async function json(response: Response, status = 200) {
  const body = await response.json();
  expect(response.status).toBe(status);
  return body;
}
async function enroll(caller: string, name = 'Resident key') {
  const native = driver.security;
  const key = authenticator();
  const options = await json(await native.request(caller, '/passkeys/register/options', {}));
  expect(parsePasskeyEnrollmentOptions(options)).not.toBeNull();
  expect(options.rp).toEqual({ id: 'rezics.com', name: 'REZICS' });
  const response = await native.request(caller, '/passkeys/register', {
    name,
    response: key.registration(options, true, native.issuer),
  });
  const created = await json(response, 201);
  expect(Object.keys(created).sort()).toEqual(['created_at', 'id', 'name']);
  return { key, created };
}
async function passwordOperation(caller: string, subjectId: string, password: string | null) {
  const operation = (
    await driver.stage(caller, { key: randomUUID(), subjectId, credential: { kind: 'password', password } })
  ).value!;
  expect(operation).toBeDefined();
  const approval = (await driver.approve(caller, operation)).value!;
  expect(approval).toBeDefined();
  return { operation, approval };
}

test('password replacement retains exact unknown command identity through deliberate current-session recovery', async () => {
  const f = await driver.seed('own-human');
  const native = driver.security;
  let attempt = createPasswordChangeAttempt(f.humanId, f.password);
  const stage = await json(await native.request(f.caller, '/credential-effects/stage', attempt.stagePayload));
  const staged = classifyPasswordChangeReply(attempt, { ok: true, body: stage });
  expect(staged.kind).toBe('next');
  if (staged.kind !== 'next') throw new Error('Native stage was not admitted');
  attempt = staged.attempt;
  const operation = {
    key: attempt.key,
    subjectId: attempt.subjectId,
    effectRef: stage.effectRef,
    purpose: stage.purpose,
    digest: stage.digest,
  };
  const approved = await json(await native.request(f.caller, '/credential-effects/approve', operation));
  const approval = classifyPasswordChangeReply(attempt, { ok: true, body: approved });
  expect(approval.kind).toBe('next');
  if (approval.kind !== 'next') throw new Error('Native approval was not admitted');
  attempt = approval.attempt;
  const applied = await native.request(f.caller, '/credential-effects/apply', {
    ...operation,
    reference: approved.reference,
  });
  expect(applied.status).toBe(200);
  // The client loses the body after the native commit. It retains its exact command.
  const lost = classifyPasswordChangeReply(attempt, { ok: false, status: 503, code: '' });
  expect(lost.kind).toBe('unknown');
  expect((await native.kernel(f.rawAccessToken, `/v1/accounts/${f.humanId}/profile`)).status).toBe(401);
  expect(
    (await native.request(f.otherHuman, '/credential-effects/apply', { ...operation, reference: approved.reference }))
      .status,
  ).toBe(401);
  expect((await native.snapshot(f.humanId)).sessions).toHaveLength(0);
  const resumed = await native.reauthenticate(f.caller, f.password);
  const current = await json(await native.request(resumed, '/security-page'));
  expect(current.viewer.account_id).toBe(f.humanId);
  // Reauthentication observes current authority; it cannot renew the original opening's epoch.
  const retry = await native.request(resumed, '/credential-effects/apply', {
    ...operation,
    reference: approved.reference,
  });
  const refusal = await json(retry, 401);
  const recovered = classifyPasswordChangeReply(
    { ...attempt, uncertain: true },
    {
      ok: false,
      status: retry.status,
      code: refusal.error,
      effectStatus: refusal.effect_status,
    },
  );
  expect(recovered).toEqual({ kind: 'unknown', attempt: { ...attempt, uncertain: true } });
  expect(attempt.key).toBe(operation.key);
  expect(attempt.approval?.reference).toBe(approved.reference);
  const persisted = await native.snapshot(f.humanId);
  expect(
    persisted.effects.filter((effect) => effect.operation_key === attempt.key && effect.committed_at),
  ).toHaveLength(1);
  expect(persisted.floor).toBe(String(Number(f.floor) + 1));
});

test('native passkey enrollment, exact label rename and retirement preserve ownership and real bearer revocation', async () => {
  const native = driver.security;
  const human = await native.person();
  const unrelated = await native.person();
  const second = await native.login(human.email);
  const before = await native.snapshot(human.accountId);
  const { key, created } = await enroll(human.caller);
  const page = await json(await native.request(human.caller, '/security-page'));
  expect(page.sessions.rows.filter((row: { current: boolean }) => row.current)).toHaveLength(1);
  expect(page.sessions.rows.some((row: { current: boolean }) => !row.current)).toBe(true);
  expect(page.passkeys.rows[0]).toMatchObject({ id: created.id, name: created.name, remove: 'allowed' });
  expect(JSON.stringify(page)).not.toContain('publicKey');
  expect(
    (
      await native.request(unrelated.caller, '/passkeys/rename', {
        id: created.id,
        name: 'Wrong owner',
        reviewed_account_id: unrelated.accountId,
      })
    ).status,
  ).toBe(404);
  expect(
    (
      await native.request(human.caller, '/passkeys/rename', {
        id: created.id,
        name: 'Wrong review',
        reviewed_account_id: unrelated.accountId,
      })
    ).status,
  ).toBe(409);
  const named = await json(
    await native.request(human.caller, '/passkeys/rename', {
      id: created.id,
      name: ' Travel key ',
      reviewed_account_id: human.accountId,
    }),
  );
  expect(named).toEqual({ id: created.id, name: 'Travel key' });
  const renamed = await native.snapshot(human.accountId);
  expect(renamed.floor).toBe(before.floor);
  expect(renamed.passkeys[0]?.name).toBe('Travel key');
  expect(renamed.sessions).toHaveLength(before.sessions.length);
  const bearer = await native.bearer(second);
  expect((await native.kernel(bearer, `/v1/accounts/${human.accountId}/profile`)).status).toBe(200);
  expect(await json(await native.request(human.caller, '/passkeys/remove', { id: created.id }))).toEqual({
    success: true,
  });
  expect((await native.snapshot(human.accountId)).passkeys).toHaveLength(0);
  expect((await native.kernel(bearer, `/v1/accounts/${human.accountId}/profile`)).status).toBe(401);
  const options = await json(await native.request(second, '/signin/passkey/options', {}));
  expect(
    (
      await native.request(second, '/signin/passkey', {
        response: key.assertion(options, true, native.issuer),
        client_id: 'credential-login',
        scope: [],
      })
    ).status,
  ).toBe(401);
});

test('account keys cannot retire a human last interactive credential; remaining passkey can sign in', async () => {
  const f = await driver.seed('own-human');
  const native = driver.security;
  const denied = await passwordOperation(f.caller, f.humanId, null);
  expect((await driver.apply(f.caller, denied.approval.reference, denied.operation)).response.status).toBe(409);
  expect((await native.snapshot(f.humanId)).floor).toBe(f.floor);
  const { key, created } = await enroll(f.caller);
  const allowed = await passwordOperation(f.caller, f.humanId, null);
  expect((await driver.apply(f.caller, allowed.approval.reference, allowed.operation)).response.status).toBe(200);
  const options = await json(await native.request(f.caller, '/signin/passkey/options', {}));
  await json(
    await native.request(f.caller, '/signin/passkey', {
      response: key.assertion(options, true, native.issuer),
      client_id: f.clientId,
      scope: f.scopes,
    }),
  );
  const page = await json(await native.request(f.caller, '/security-page'));
  expect(page.passkeys.rows[0].remove).toBe('last-credential');
  const floor = (await native.snapshot(f.humanId)).floor;
  expect((await native.request(f.caller, '/passkeys/remove', { id: created.id })).status).toBe(409);
  const persisted = await native.snapshot(f.humanId);
  expect(persisted.floor).toBe(floor);
  expect(persisted.passkeys).toHaveLength(1);
});

test('reviewed Allow acknowledges the submitted union and reduction retires real bearer authority', async () => {
  const native = driver.security;
  const human = await native.person();
  const clientId = `review-${randomUUID()}`;
  await native.register(clientId, ['account:read', 'account:update']);
  await json(await native.request(human.caller, '/consent', { client_id: clientId, scope: ['account:read'] }));
  const review = await json(
    await native.request(human.caller, `/consent/${clientId}?scope=account:update%20unregistered`),
  );
  const command = {
    client_id: clientId,
    scope: ['account:read', 'account:update'],
    reviewed_account_id: human.accountId,
    reviewed_scopes: review.granted,
    reviewed_requested: review.requested,
  };
  const allowed = await json(await native.request(human.caller, '/consent', command));
  expect(allowed).toEqual({
    account_id: human.accountId,
    client_id: clientId,
    requested: ['account:update', 'unregistered'],
    scope: command.scope,
  });
  expect((await native.request(human.caller, '/consent', { ...command, reviewed_scopes: [] })).status).toBe(409);
  const caller = await native.login(human.email, undefined, clientId, command.scope);
  const token = await native.bearer(caller);
  expect((await native.kernel(token, `/v1/accounts/${human.accountId}`, { bio: 'Consented update' })).status).toBe(200);
  const limited = await native.login(human.email, undefined, clientId, ['account:read']);
  expect(
    (await native.kernel(await native.bearer(limited), `/v1/accounts/${human.accountId}`, { bio: 'Outside scope' }))
      .status,
  ).toBe(403);
  const session = await json(await native.request(caller, '/session'));
  const budgets = securityResponseByteBudgets(securityScopeLimit(command.scope));
  expect(Buffer.byteLength(JSON.stringify(session))).toBeLessThanOrEqual(budgets.session);
  expect(
    (
      await native.request(human.caller, '/consent', {
        client_id: clientId,
        scope: ['account:read'],
        reviewed_scopes: ['account:read'],
      })
    ).status,
  ).toBe(409);
  expect(
    await json(
      await native.request(human.caller, '/consent', {
        client_id: clientId,
        scope: ['account:read'],
        reviewed_scopes: command.scope,
      }),
    ),
  ).toEqual({ client_id: clientId, scope: ['account:read'] });
  const persisted = await native.snapshot(human.accountId);
  expect(persisted.consents.find((row) => row.client_id === clientId)?.scopes).toEqual(['account:read']);
  expect(persisted.sessions).toHaveLength(0);
  expect((await native.kernel(token, `/v1/accounts/${human.accountId}`, { bio: 'Revoked update' })).status).toBe(401);
  const fresh = await native.login(human.email, undefined, clientId, ['account:read']);
  await native.expire(fresh);
  expect((await native.request(fresh, '/token', {})).status).toBe(401);
});

test('a consent changed after review cannot acknowledge an uncommitted Allow and a fresh decision can recover', async () => {
  const native = driver.security;
  const human = await native.person();
  const clientId = `racing-review-${randomUUID()}`;
  await native.register(clientId, ['account:read', 'account:update']);
  const stale = await native.afterConsentReview(
    clientId,
    async () => {
      await json(await native.request(human.caller, '/consent', { client_id: clientId, scope: ['account:read'] }));
    },
    () =>
      native.request(human.caller, '/consent', {
        client_id: clientId,
        scope: ['account:read', 'account:update'],
        reviewed_account_id: human.accountId,
        reviewed_scopes: [],
        reviewed_requested: ['account:read', 'account:update'],
      }),
  );
  expect(stale.status).toBe(409);
  expect((await native.snapshot(human.accountId)).consents.find((row) => row.client_id === clientId)?.scopes).toEqual([
    'account:read',
  ]);
  const recovered = await json(
    await native.request(human.caller, '/consent', {
      client_id: clientId,
      scope: ['account:read', 'account:update'],
      reviewed_account_id: human.accountId,
      reviewed_scopes: ['account:read'],
      reviewed_requested: ['account:update'],
    }),
  );
  expect(recovered.scope).toEqual(['account:read', 'account:update']);
  expect((await native.snapshot(human.accountId)).consents.find((row) => row.client_id === clientId)?.scopes).toEqual(
    recovered.scope,
  );
});

test('session revocation targets the owned opaque session and stops issuance while another session stays usable', async () => {
  const native = driver.security;
  const human = await native.person();
  const unrelated = await native.person();
  const second = await native.login(human.email);
  const bearer = await native.bearer(second);
  const currentBearer = await native.bearer(human.caller);
  const page = await json(await native.request(human.caller, '/security-page'));
  const secondPage = await json(await native.request(second, '/security-page'));
  const other = page.sessions.rows.find((row: { id: string }) => row.id === secondPage.viewer.session_id);
  expect(other).toBeDefined();
  expect((await native.request(unrelated.caller, '/sessions/revoke', { session_id: other.id })).status).toBe(404);
  expect(await json(await native.request(human.caller, '/sessions/revoke', { session_id: other.id }))).toEqual({});
  expect((await native.snapshot(human.accountId)).sessions.some((row) => row.id === other.id)).toBe(false);
  // Session revocation ends issuance. Already issued five-minute JWTs retain their bounded lifetime.
  expect((await native.kernel(bearer, `/v1/accounts/${human.accountId}/profile`)).status).toBe(200);
  expect((await native.request(second, '/token', {})).status).toBe(401);
  expect((await native.kernel(currentBearer, `/v1/accounts/${human.accountId}/profile`)).status).toBe(200);
  expect((await native.request(second, '/session')).status).toBe(401);
});

import { expect, test } from 'bun:test';
import { AUTH_MANAGEMENT_SCOPES, isManagementOperation, managementOperationProfile } from '@rezics/auth-contract';
import type { OpeningInput } from '../src/operator-session-opening';
import { installManagementServerFixture, runManagementTestsInChild } from './management-server-fixture';

if (!runManagementTestsInChild(import.meta.path)) {
  const { respond, storage } = installManagementServerFixture();
  const { isOpeningInput, openedSession, parseOpeningMetadata, readOpenedSession, submitOperatorOpening } =
    await import('../src/operator-session-opening');
  const { executeManagementOperation, loadManagementSession } = await import('../src/management-operations');
  const {
    managementOperationStepUpUrl,
    markManagementOperationReturned,
    pendingManagementOperationStepUpState,
    readPendingManagementOperationStepUp,
    selectManagementOperationStepUp,
    storePendingManagementOperationStepUp,
  } = await import('../src/management-operation-step-up');
  const { confirmStepUp } = await import('../src/step-up');

  const human = '11111111-1111-4111-8111-111111111111';
  const operator = '22222222-2222-4222-8222-222222222222';
  const subject = '33333333-3333-4333-8333-333333333333';
  const foreign = '44444444-4444-4444-8444-444444444444';
  const authTime = Math.floor(Date.now() / 1000);
  function input(): OpeningInput {
    return {
      accountId: human,
      operationKey: 'original-opening-key',
      operation: {
        kind: 'opening',
        operatorAccountId: operator,
        subjectAccountId: subject,
      },
    };
  }
  function proof(accountId = human, amr = 'pwd') {
    return {
      account_id: accountId,
      ...managementOperationProfile('opening'),
      authn_epoch: 3,
      auth_time: authTime,
      amr: [amr],
    };
  }
  const approval = (reference = 'ephemeral-native-approval.' + 'a'.repeat(43)) => ({
    reference,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
  });
  function metadata() {
    return {
      account: { id: subject, kind: 'actor', handle: 'native_actor', displayName: 'Actual actor' },
      operator: { id: operator, kind: 'organization', handle: 'native_operator', displayName: 'Actual operator' },
      relation: { operatorAccountId: operator, reservationId: foreign, version: '7' },
      self: false,
      role: null,
      members: { state: 'denied', items: [], next: null },
      responsibilities: null,
    };
  }

  test('opening is a closed additive profile with the unchanged three-scope registration ceiling', () => {
    expect(managementOperationProfile('opening')).toEqual({
      client_id: 'rezics-auth-account-management',
      scope: ['account:manage'],
    });
    expect([...new Set(Object.values(AUTH_MANAGEMENT_SCOPES).flat())].sort()).toEqual([
      'account:manage',
      'account:update',
      'organization:membership',
    ]);
    expect(isManagementOperation(input().operation)).toBe(true);
    for (const extra of [
      { authorization: 'invented' },
      { operationKey: 'other' },
      { scope: ['access:grant'] },
      { actor: {} },
    ])
      expect(isManagementOperation({ ...input().operation, ...extra })).toBe(false);
    expect(isOpeningInput({ ...input(), reference: 'never-pending' })).toBe(false);
  });

  test('confirmation uses actual selected native actor/operator metadata and refuses missing, foreign, human or organization sources', () => {
    expect(parseOpeningMetadata(metadata(), input())).toEqual({
      kind: 'ready',
      metadata: {
        subject: metadata().account,
        operator: metadata().operator,
      },
    });
    for (const value of [
      null,
      {},
      { ...metadata(), relation: null },
      { ...metadata(), operator: null },
      { ...metadata(), account: { ...metadata().account, kind: 'organization' } },
      { ...metadata(), account: { ...metadata().account, id: human } },
      { ...metadata(), operator: { ...metadata().operator, id: foreign } },
      { ...metadata(), relation: { ...metadata().relation, operatorAccountId: foreign } },
    ])
      expect(parseOpeningMetadata(value, input())).toEqual({ kind: 'unavailable' });
  });

  test('explicit opening submit approves once and uses only dedicated transport, storing no approval, proof or private metadata', async () => {
    const values = storage();
    const calls = respond(({ path }) => {
      if (path === '/session') return Response.json(proof());
      if (path === '/account-operations/approve') return Response.json(approval());
      if (path === '/operator-sessions/open') return Response.json(proof(subject, 'operator'));
      throw new Error('Unexpected endpoint');
    });
    expect(await submitOperatorOpening(input())).toEqual({ kind: 'opened', session: proof(subject, 'operator') });
    expect(calls.map((call) => call.path)).toEqual([
      '/session',
      '/account-operations/approve',
      '/operator-sessions/open',
    ]);
    expect(calls[1]!.body).toEqual(input());
    expect(calls[2]!.body).toEqual({ ...input(), reference: approval().reference });
    const approved = calls[1]!;
    expect(approved.init).toMatchObject({
      method: 'POST',
      cache: 'no-store',
      credentials: 'same-origin',
      redirect: 'error',
    });
    expect(new Headers(approved.init.headers).has('authorization')).toBe(false);
    expect(pendingManagementOperationStepUpState()).toMatchObject({ kind: 'pending', value: { phase: 'submitted' } });
    const pending = [...values.values()].join();
    for (const secret of ['ephemeral-native-approval', 'authn_epoch', 'scope', 'displayName', 'cookie', 'password'])
      expect(pending).not.toContain(secret);
    const count = calls.length;
    expect(await submitOperatorOpening(input())).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(count);
  });

  test('navigation and same-human step-up return never open a session; second confirmation keeps exact human/operator/subject/key', async () => {
    storage();
    const calls = respond(({ path }) => {
      if (path === '/signin' || path === '/session') return Response.json(proof());
      if (path === '/account-operations/approve') return Response.json(approval());
      if (path === '/operator-sessions/open') return Response.json(proof(subject, 'operator'));
      throw new Error('Unexpected endpoint');
    });
    expect(storePendingManagementOperationStepUp(input())).toBe(true);
    const url = managementOperationStepUpUrl('opening');
    expect(url).toBe('/step-up?management_operation=opening&return_to=%2Fautomated%2Fopen');
    expect(selectManagementOperationStepUp(url.split('?')[1]!)).toMatchObject({ kind: 'management' });
    expect(calls).toHaveLength(0);
    expect(await submitOperatorOpening(input())).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(0);
    expect(
      await confirmStepUp('human@example.test', 'private-password', url.split('?')[1]!, 'https://auth.test'),
    ).toEqual({ ok: true, target: 'https://auth.test/automated/open' });
    expect(calls.map((call) => call.path)).toEqual(['/signin', '/session']);
    expect(calls[0]?.body).toEqual({
      email: 'human@example.test',
      password: 'private-password',
      ...managementOperationProfile('opening'),
    });
    const count = calls.length;
    for (const changed of [
      { ...input(), accountId: foreign },
      { ...input(), operationKey: 'foreign-key' },
      { ...input(), operation: { ...input().operation, operatorAccountId: foreign } },
      { ...input(), operation: { ...input().operation, subjectAccountId: foreign } },
    ])
      expect(await submitOperatorOpening(changed)).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(count);
    expect(selectManagementOperationStepUp('management_operation=opening&return_to=%2Fsecurity')).toEqual({
      kind: 'invalid',
    });
    expect(await submitOperatorOpening(input())).toEqual({ kind: 'opened', session: proof(subject, 'operator') });
    expect(calls.slice(count).map(({ path, body }) => ({ path, body }))).toEqual([
      { path: '/session', body: {} },
      { path: '/account-operations/approve', body: input() },
      { path: '/operator-sessions/open', body: { ...input(), reference: approval().reference } },
    ]);
  });

  test('foreign or automated proofs cannot become a human management credential and generic mutation execution rejects opening', async () => {
    storage();
    const calls = respond(() => Response.json(proof(foreign)));
    expect(await executeManagementOperation(input())).toEqual({ kind: 'refused' });
    expect(calls).toHaveLength(0);
    expect(await submitOperatorOpening(input())).toEqual({ kind: 'refused' });
    expect(calls.map(({ path }) => path)).toEqual(['/session']);
    const automated = respond(() => Response.json(proof(subject, 'operator')));
    expect(await loadManagementSession()).toEqual({ kind: 'unavailable' });
    expect(automated.map(({ path }) => path)).toEqual(['/session']);
    expect(openedSession(proof(subject, 'pwd'), input())).toBeNull();
    expect(openedSession({ ...proof(subject, 'operator'), token: 'secret' }, input())).toBeNull();
    expect(openedSession(proof(foreign, 'operator'), input())).toBeNull();
  });

  test('ambiguous or lost issuance is UNKNOWN with no replay; readback observes only the actual subject/operator session', async () => {
    for (const broken of ['lost', 'timeout', 'malformed', 'foreign'] as const) {
      storage();
      const deadline = new AbortController();
      const calls = respond(({ path }) => {
        if (path === '/session') return Response.json(proof());
        if (path.endsWith('/approve')) return Response.json(approval());
        if (path !== '/operator-sessions/open') throw new Error('Unexpected endpoint');
        if (broken === 'lost') throw new Error('lost response');
        if (broken === 'timeout') {
          queueMicrotask(() => deadline.abort(new DOMException('Issuance timed out', 'TimeoutError')));
          return new Promise<Response>(() => {});
        }
        return Response.json(broken === 'malformed' ? {} : proof(foreign, 'operator'));
      });
      expect(await submitOperatorOpening(input(), undefined, undefined, deadline.signal)).toEqual({ kind: 'unknown' });
      expect(calls.map(({ path }) => path)).toEqual([
        '/session',
        '/account-operations/approve',
        '/operator-sessions/open',
      ]);
      if (broken === 'timeout') expect(calls[2]!.init.signal?.aborted).toBe(true);
      expect(await submitOperatorOpening(input())).toEqual({ kind: 'refused' });
      expect(calls).toHaveLength(3);
      expect(await readOpenedSession(input())).toEqual({ kind: 'unknown' });
      expect(calls.at(-1)!.path).toBe('/session');
      // Receipt scopes are shown as actually observed, never reconstructed from
      // the human profile or augmented with requested target/delegation scopes.
      const actual = { ...proof(subject, 'operator'), scope: ['native:bound'] };
      const reads = respond(() => Response.json(actual));
      expect(await readOpenedSession(input())).toEqual({ kind: 'opened', session: actual });
      expect(reads.map((call) => call.path)).toEqual(['/session']);
    }
  });

  test('new opening after unknown requires deliberate fresh reauthentication and never reuses the consumed key or approval', async () => {
    storage();
    const firstApproval = approval();
    const freshApproval = approval('fresh-native-approval.' + 'b'.repeat(43));
    const calls = respond(({ path, body }) => {
      if (path === '/operator-sessions/open') throw new Error('lost response');
      if (path === '/session' || path === '/signin') return Response.json(proof());
      if (path === '/account-operations/approve')
        return Response.json(body.operationKey === input().operationKey ? firstApproval : freshApproval);
      throw new Error('Unexpected endpoint');
    });
    expect(storePendingManagementOperationStepUp(input())).toBe(true);
    expect(markManagementOperationReturned(readPendingManagementOperationStepUp()!)).toBe(true);
    expect((await submitOperatorOpening(input())).kind).toBe('unknown');
    const next = { ...input(), operationKey: 'deliberate-new-key' };
    expect(storePendingManagementOperationStepUp(next)).toBe(true);
    const selection = selectManagementOperationStepUp(managementOperationStepUpUrl('opening').split('?')[1]!);
    expect(selection).toMatchObject({ kind: 'management', pending: { ...next, phase: 'awaiting' } });
    expect(await submitOperatorOpening(next)).toEqual({ kind: 'refused' });
    expect(calls.filter((call) => call.path === '/operator-sessions/open')).toHaveLength(1);
    expect(
      await confirmStepUp(
        'human@example.test',
        'fresh-password',
        managementOperationStepUpUrl('opening').split('?')[1]!,
        'https://auth.test',
      ),
    ).toEqual({ ok: true, target: 'https://auth.test/automated/open' });
    expect(calls.filter((call) => call.path === '/operator-sessions/open')).toHaveLength(1);
    expect(await submitOperatorOpening(next)).toEqual({ kind: 'unknown' });
    expect(calls.filter(({ path }) => path === '/account-operations/approve').map(({ body }) => body)).toEqual([
      input(),
      next,
    ]);
    expect(calls.filter(({ path }) => path === '/operator-sessions/open').map(({ body }) => body)).toEqual([
      { ...input(), reference: firstApproval.reference },
      { ...next, reference: freshApproval.reference },
    ]);
  });
}

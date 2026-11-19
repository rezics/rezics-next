import { expect, test } from 'bun:test';
import type { RenameRead, RenameTarget } from '../src/account-rename';
import { installManagementServerFixture, runManagementTestsInChild } from './management-server-fixture';

if (!runManagementTestsInChild(import.meta.path)) {
  const { respond, storage } = installManagementServerFixture();
  const {
    createRenameAttempt,
    loadRenameTarget,
    parseRenameContinuation,
    parseRenameProfile,
    RENAME_PROFILE,
    runRenameAttempt,
  } = await import('../src/account-rename');

  const target: RenameTarget = {
    accountId: '00000000-0000-4000-8000-000000000001',
    handle: 'old-handle',
    clientId: RENAME_PROFILE.client_id,
    scopes: [...RENAME_PROFILE.scope],
  };
  const ready = (): Promise<RenameRead> => Promise.resolve({ kind: 'ready', target: { ...target } });
  const nativeReference = 'AQ.' + 'a'.repeat(43);
  const approval = () =>
    Response.json({ reference: nativeReference, expiresAt: new Date(Date.now() + 60_000).toISOString() });

  test('Rename an account through native approved handle workflow preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
    storage();
    let handle = target.handle;
    const requests = respond(({ path }) => {
      if (path === '/session') return Response.json({ account_id: target.accountId, ...RENAME_PROFILE });
      if (path === '/account-management/rename-page') return Response.json({ state: 'unavailable' });
      if (path === '/account-operations/approve') return approval();
      if (path === '/account-operations/execute') {
        handle = 'new-handle';
        return Response.json({ accountId: target.accountId });
      }
      throw new Error('Unexpected endpoint');
    });
    const read = () =>
      loadRenameTarget(async (id) => {
        expect(id).toBe(target.accountId);
        return {
          state: 'ready',
          viewer: {
            accountId: id,
            kind: 'actor',
            clientId: target.clientId,
            scopes: target.scopes,
            authnEpoch: 1,
            authTime: 1,
            amr: ['pwd'],
          },
          profile: { id, kind: 'actor', handle },
          authActions: {
            state: 'ready',
            operations: [
              {
                operationId: 'auth.account.rename',
                action: 'account:update',
                resource: { route: 1, id },
              },
            ],
          },
        };
      });
    const loaded = await read();
    expect(loaded.kind).toBe('ready');
    expect(
      parseRenameProfile({ profile: { id: 'other', kind: 'actor', handle: 'old-handle' } }, target.accountId),
    ).toBeNull();
    const attempt = createRenameAttempt(target, 'New-Handle')!;
    expect(requests.filter((r) => r.path.startsWith('/account-operations'))).toHaveLength(0);
    // Constructing/reloading the form has no effect. Only explicit submission calls the adapter.
    expect(await runRenameAttempt(attempt, read)).toMatchObject({
      kind: 'renamed',
      target: { accountId: target.accountId, handle: 'new-handle' },
    });
    const writes = requests.filter((r) => r.path.startsWith('/account-operations'));
    expect(writes.map((r) => r.path)).toEqual(['/account-operations/approve', '/account-operations/execute']);
    expect(writes[0]!.body).toEqual({
      operationKey: attempt.operationKey,
      operation: { kind: 'rename', accountId: target.accountId, handle: 'new-handle', expectedHandle: 'old-handle' },
    });
    expect(writes[1]!.body).toEqual({ ...writes[0]!.body, reference: nativeReference });
    expect(writes.every((r) => r.init?.credentials === 'same-origin' && r.init.redirect === 'error')).toBe(true);
    expect(requests.map(({ path }) => path)).toEqual([
      '/session',
      '/session',
      '/account-operations/approve',
      '/account-operations/execute',
      '/session',
    ]);
    expect(await loadRenameTarget()).toEqual({ kind: 'unavailable' });
  });

  test('Ambiguous rename keeps the exact operation and reference while acknowledgement and readback remain distinct', async () => {
    storage();
    let executions = 0;
    const attempt = createRenameAttempt(target, 'new-handle')!;
    const calls = respond(({ path }) => {
      if (path === '/account-operations/approve') return approval();
      if (path !== '/account-operations/execute') throw new Error('Unexpected endpoint');
      if (++executions === 1) throw new TypeError('Lost response');
      return Response.json({ accountId: target.accountId });
    });
    expect(await runRenameAttempt(attempt, ready)).toEqual({ kind: 'unknown' });
    expect(attempt.submitted).toBe(true);
    // Native acknowledgement settles the command, while stale readback cannot confirm the current desired handle.
    expect(await runRenameAttempt(attempt, ready)).toEqual({
      kind: 'acknowledged',
      current: { kind: 'ready', target },
    });
    expect(calls.map(({ path }) => path)).toEqual([
      '/account-operations/approve',
      '/account-operations/execute',
      '/account-operations/execute',
    ]);
    expect(calls[2]!.init.body).toBe(calls[1]!.init.body);
    const observed = async (): Promise<RenameRead> => ({ kind: 'ready', target: { ...target, handle: 'new-handle' } });
    expect((await runRenameAttempt(attempt, observed)).kind).toBe('renamed');
    expect(calls).toHaveLength(4);
    expect(calls[3]!.path).toBe('/account-operations/execute');
    expect(calls[3]!.init.body).toBe(calls[1]!.init.body);
    expect(
      (await runRenameAttempt(attempt, async () => ({ kind: 'ready', target: { ...target, accountId: 'different' } })))
        .kind,
    ).toBe('denied');
    expect(calls).toHaveLength(4);
  });

  test('Rename step-up binds the exact account key and both handles without storing approval material', async () => {
    storage();
    const calls = respond(approval);
    const attempt = createRenameAttempt(target, 'new-handle')!;
    const continuation = parseRenameContinuation(attempt)!;
    expect(continuation.operation.expectedHandle).toBe('old-handle');
    expect(Object.isFrozen(continuation.operation)).toBe(true);
    expect(parseRenameContinuation({ ...attempt, reference: 'never-store' })).toBeNull();
    expect(parseRenameContinuation({ ...attempt, accountId: 'different' })).toBeNull();
    expect(
      parseRenameContinuation({ ...attempt, operation: { ...attempt.operation, authorization: 'caller-proof' } }),
    ).toBeNull();
    expect(
      (
        await runRenameAttempt(attempt, async () => ({
          kind: 'ready',
          target: { ...target, clientId: 'login', scopes: [] },
        }))
      ).kind,
    ).toBe('step-up');
    expect(calls).toHaveLength(0);
    expect(createRenameAttempt(target, 'changed-handle')!.operationKey).not.toBe(attempt.operationKey);
    expect(createRenameAttempt(target, ' new-handle')).toBeNull();
  });

  test('Native conflict reloads the current handle and unavailable reads cannot approve or execute', async () => {
    storage();
    let reads = 0;
    const attempt = createRenameAttempt(target, 'new-handle')!;
    const calls = respond(() =>
      Response.json({ error: 'account_operation_denied', effect_status: 'not_applied' }, { status: 409 }),
    );
    const read = async (): Promise<RenameRead> => ({
      kind: 'ready',
      target: { ...target, handle: ++reads > 1 ? 'changed-handle' : target.handle },
    });
    expect(await runRenameAttempt(attempt, read)).toMatchObject({
      kind: 'conflict',
      current: { target: { handle: 'changed-handle' } },
    });
    expect(reads).toBe(2);
    expect(calls.map(({ path }) => path)).toEqual(['/account-operations/approve']);
    expect(await runRenameAttempt(attempt, async () => ({ kind: 'unavailable' }))).toEqual({
      kind: 'unavailable',
      current: { kind: 'unavailable' },
    });
    expect(calls).toHaveLength(1);
    expect(parseRenameProfile({ profile: { id: target.accountId, kind: 'actor' } }, target.accountId)).toBeNull();
    expect(
      parseRenameProfile({ profile: { id: target.accountId, kind: 'actor', handle: null } }, target.accountId),
    ).toEqual({ handle: null });
  });
}

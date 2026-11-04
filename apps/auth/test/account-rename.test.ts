import { afterEach, expect, test } from 'bun:test';
import {
  createRenameAttempt,
  loadRenameTarget,
  parseRenameContinuation,
  parseRenameProfile,
  RENAME_PROFILE,
  runRenameAttempt,
  type RenameRead,
  type RenameTarget,
} from '../src/account-rename';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const target: RenameTarget = {
  accountId: 'native-current',
  handle: 'old-handle',
  clientId: RENAME_PROFILE.client_id,
  scopes: [...RENAME_PROFILE.scope],
};
const ready = (): Promise<RenameRead> => Promise.resolve({ kind: 'ready', target: { ...target } });
const approval = () =>
  Response.json({ reference: 'native-reference', expiresAt: new Date(Date.now() + 60_000).toISOString() });

test('Rename an account through native approved handle workflow preserves exact native authority current-account binding explicit confirmation and unavailable states', async () => {
  const requests: { path: string; init?: RequestInit; body: Record<string, unknown> }[] = [];
  let handle = target.handle;
  globalThis.fetch = (async (url, init) => {
    requests.push({
      path: String(url),
      ...(init ? { init } : {}),
      body: init?.body ? JSON.parse(String(init.body)) : {},
    });
    if (String(url) === '/session')
      return Response.json({ account_id: target.accountId, client_id: target.clientId, scope: target.scopes });
    if (String(url) === '/account-operations/approve') return approval();
    if (String(url) === '/account-operations/execute') {
      handle = 'new-handle';
      return Response.json({ accountId: target.accountId });
    }
    throw new Error('Unexpected endpoint');
  }) as typeof fetch;
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
  expect(writes[1]!.body).toEqual({ ...writes[0]!.body, reference: 'native-reference' });
  expect(writes.every((r) => r.init?.credentials === 'same-origin' && r.init.redirect === 'error')).toBe(true);
  expect(requests.filter((r) => r.path === '/session').every((r) => r.init?.cache === 'no-store')).toBe(true);
  expect(await loadRenameTarget()).toEqual({ kind: 'unavailable' });
});

test('Ambiguous rename keeps the same closed operation and reference and needs current readback', async () => {
  const writes: string[] = [];
  let executions = 0;
  const attempt = createRenameAttempt(target, 'new-handle')!;
  globalThis.fetch = (async (url, init) => {
    if (String(url).endsWith('/approve')) return approval();
    writes.push(String(init?.body));
    if (++executions === 1) throw new TypeError('Lost response');
    return Response.json({ accountId: target.accountId });
  }) as typeof fetch;
  expect(await runRenameAttempt(attempt, ready)).toEqual({ kind: 'unknown' });
  expect(attempt.submitted).toBe(true);
  // An acknowledgement with a stale current profile is still unknown.
  expect(await runRenameAttempt(attempt, ready)).toEqual({ kind: 'unknown' });
  expect(writes[0]).toBe(writes[1]);
  const observed = async (): Promise<RenameRead> => ({ kind: 'ready', target: { ...target, handle: 'new-handle' } });
  expect((await runRenameAttempt(attempt, observed)).kind).toBe('renamed');
  expect(writes).toHaveLength(2);
  expect(
    (await runRenameAttempt(attempt, async () => ({ kind: 'ready', target: { ...target, accountId: 'different' } })))
      .kind,
  ).toBe('denied');
});

test('Rename step-up binds the exact account key and both handles without storing approval material', async () => {
  let calls = 0;
  globalThis.fetch = (async () => {
    calls++;
    return approval();
  }) as typeof fetch;
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
  expect(calls).toBe(0);
  expect(createRenameAttempt(target, 'changed-handle')!.operationKey).not.toBe(attempt.operationKey);
  expect(createRenameAttempt(target, ' new-handle')).toBeNull();
});

test('Native conflict reloads the current handle and unavailable reads cannot approve or execute', async () => {
  let reads = 0;
  const attempt = createRenameAttempt(target, 'new-handle')!;
  globalThis.fetch = (async () =>
    Response.json({ error: 'account_operation_denied' }, { status: 409 })) as typeof fetch;
  const read = async (): Promise<RenameRead> => ({
    kind: 'ready',
    target: { ...target, handle: ++reads > 1 ? 'changed-handle' : target.handle },
  });
  expect(await runRenameAttempt(attempt, read)).toMatchObject({
    kind: 'conflict',
    current: { target: { handle: 'changed-handle' } },
  });
  expect(reads).toBe(2);
  globalThis.fetch = (async () => {
    throw new Error('Must not write without a current profile');
  }) as typeof fetch;
  expect(await runRenameAttempt(attempt, async () => ({ kind: 'unavailable' }))).toEqual({ kind: 'unavailable' });
  expect(parseRenameProfile({ profile: { id: target.accountId, kind: 'actor' } }, target.accountId)).toBeNull();
  expect(
    parseRenameProfile({ profile: { id: target.accountId, kind: 'actor', handle: null } }, target.accountId),
  ).toEqual({ handle: null });
});

import { afterEach, expect, test } from 'bun:test';
import { forgetOperationKey, operationKeyFor, runAccountOperation } from '../src/account-operations';
import { parseInventoryPage, removeConsent, type GrantedConsent } from '../src/security-inventory';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});

type Call = { path: string; init: RequestInit; body: Record<string, unknown> };
function respond(reply: (call: Call, index: number) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const call = { path: String(input), init, body: JSON.parse(String(init.body)) as Record<string, unknown> };
    calls.push(call);
    return reply(call, calls.length - 1);
  }) as typeof fetch;
  return calls;
}
const approval = () =>
  Response.json({ reference: 'fresh-native-reference', expiresAt: new Date(Date.now() + 60_000).toISOString() });
const consent: GrantedConsent = {
  client_id: 'third-party',
  display_name: 'Reading companion',
  granted: ['subject:read'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
};

test('inventory keeps ownership and consent separate, strips private metadata and preserves the signed cursor', () => {
  expect(
    parseInventoryPage('clients', {
      clients: [
        {
          client_id: 'owned',
          display_name: null,
          disabled: true,
          scopes: [],
          contact: 'private@example.test',
          secret: 'private',
        },
      ],
      next: 'opaque.signed+cursor/==',
      private_metadata: 'private',
    }),
  ).toEqual({
    kind: 'ready',
    rows: [{ client_id: 'owned', display_name: null, disabled: true, scopes: [] }],
    next: 'opaque.signed+cursor/==',
  });
  expect(
    parseInventoryPage('consents', { consents: [{ ...consent, owner: true, tokens: ['private'] }], next: null }),
  ).toEqual({ kind: 'ready', rows: [consent], next: null });
  expect(parseInventoryPage('clients', { consents: [consent], next: null })).toEqual({ kind: 'unavailable' });
});

test('only a valid empty native page means empty; malformed, oversized and unknown grant states remain unavailable', () => {
  expect(parseInventoryPage('clients', { clients: [], next: null })).toEqual({ kind: 'ready', rows: [], next: null });
  for (const body of [
    null,
    {},
    { clients: [], next: '' },
    {
      clients: Array.from({ length: 21 }, (_, n) => ({
        client_id: String(n),
        display_name: null,
        disabled: false,
        scopes: [],
      })),
      next: null,
    },
  ])
    expect(parseInventoryPage('clients', body)).toEqual({ kind: 'unavailable' });
  for (const row of [
    { ...consent, status: 'unknown' },
    { ...consent, status: 'inactive' },
    { ...consent, status: 'unavailable' },
  ])
    expect(parseInventoryPage('consents', { consents: [row], next: null })).toEqual({ kind: 'unavailable' });
  expect(
    parseInventoryPage('consents', {
      consents: [{ ...consent, status: 'unavailable', granted: [], reducible: false, pending_reduction: true }],
      next: null,
    }).kind,
  ).toBe('ready');
});

test('approval and execution use the exact same account, typed operation and key with issuer cookies', async () => {
  const operation = { kind: 'delete' as const, accountId: 'own-account' };
  const calls = respond((call) =>
    call.path.endsWith('/approve') ? approval() : Response.json({ accountId: 'own-account' }),
  );
  expect(await runAccountOperation('stable-key', operation)).toEqual({ ok: true, accountId: 'own-account' });
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: '/account-operations/approve', body: { operationKey: 'stable-key', operation } },
    {
      path: '/account-operations/execute',
      body: { operationKey: 'stable-key', operation, reference: 'fresh-native-reference' },
    },
  ]);
  expect(
    calls.every(
      ({ init }) => init.method === 'POST' && init.credentials === 'same-origin' && init.redirect === 'error',
    ),
  ).toBe(true);
});

test('a lost execution response retries the same approval, body and key; authentication loss is an unknown outcome', async () => {
  const operation = { kind: 'delete' as const, accountId: 'own-account' };
  const calls = respond((call, index) => {
    if (index === 0) return approval();
    if (index === 1) throw new TypeError('Lost response');
    return Response.json({ error: 'account_operation_denied' }, { status: 401 });
  });
  expect(await runAccountOperation('stable-key', operation)).toEqual({ ok: false, reason: 'unknown' });
  expect(calls.map(({ path }) => path)).toEqual([
    '/account-operations/approve',
    '/account-operations/execute',
    '/account-operations/execute',
  ]);
  expect(calls[2]!.body).toEqual(calls[1]!.body);
});

test('native freshness, platform and responsibility refusals cannot execute an operation', async () => {
  for (const [status, error, reason] of [
    [401, 'step_up_required', 'step-up'],
    [403, 'platform_closed', 'platform-closed'],
    [409, 'account_operation_denied', 'denied'],
    [503, 'account_operation_denied', 'unavailable'],
  ] as const) {
    const calls = respond(() => Response.json({ error }, { status }));
    expect(await runAccountOperation('stable-key', { kind: 'organization', handle: 'reading-group' })).toEqual({
      ok: false,
      reason,
    });
    expect(calls.map(({ path }) => path)).toEqual(['/account-operations/approve']);
  }
});

test('malformed approval and a mismatched deletion result never claim completion', async () => {
  let calls = respond(() => Response.json({ reference: 'unbounded-reference' }));
  expect(await runAccountOperation('stable-key', { kind: 'delete', accountId: 'own-account' })).toEqual({
    ok: false,
    reason: 'unavailable',
  });
  expect(calls).toHaveLength(1);
  calls = respond((call) =>
    call.path.endsWith('/approve') ? approval() : Response.json({ accountId: 'another-account' }),
  );
  expect(await runAccountOperation('stable-key', { kind: 'delete', accountId: 'own-account' })).toEqual({
    ok: false,
    reason: 'unknown',
  });
  expect(calls).toHaveLength(2);
});

test('operation keys stay stable for a retry and are bound to the initiating account and exact organization handle', () => {
  const operation = { kind: 'organization' as const, handle: 'reading-group' };
  const first = operationKeyFor(operation, 'first-account');
  expect(operationKeyFor(operation, 'first-account')).toBe(first);
  const second = operationKeyFor(operation, 'second-account');
  expect(second).not.toBe(first);
  const differentHandle = { kind: 'organization' as const, handle: 'other-group' };
  expect(operationKeyFor(differentHandle, 'second-account')).not.toBe(second);
  forgetOperationKey(differentHandle, 'second-account');
});

test('consent reduction posts only the selected third-party grant and never treats a lost write as success', async () => {
  let calls = respond(() => Response.json({ client_id: 'third-party', scope: [] }));
  expect(await removeConsent(consent)).toEqual({ kind: 'accepted' });
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: '/consent', body: { client_id: 'third-party', scope: [] } },
  ]);
  calls = respond(() => {
    throw new TypeError('Lost response');
  });
  expect(await removeConsent(consent)).toEqual({ kind: 'unknown' });
  expect(calls).toHaveLength(1);
  calls = respond(() => Response.json({ client_id: 'another-client', scope: [] }));
  expect(await removeConsent(consent)).toEqual({ kind: 'unknown' });
  calls = respond(() => Response.json({}));
  for (const row of [
    { ...consent, reducible: false },
    { ...consent, pending_reduction: true },
    { ...consent, status: 'inactive' as const },
    { ...consent, status: 'unavailable' as const },
  ])
    expect(await removeConsent(row)).toEqual({ kind: 'denied' });
  expect(calls).toHaveLength(0);
});

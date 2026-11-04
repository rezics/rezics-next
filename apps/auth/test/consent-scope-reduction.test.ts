import { afterEach, expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { approvedScopes, type Consent } from '../src/consent';
import { permissionDescription, permissionRemovalLabel } from '../src/permission-description';
import { Permission, RemovablePermission, RequestedPermission } from '../src/permission-view';
import { getLocale, setLocale } from '../src/paraglide/runtime.js';
import {
  createConsentReduction,
  parseInventoryPage,
  reduceConsent,
  removeConsent,
  type GrantedConsent,
} from '../src/security-inventory';

const originalFetch = globalThis.fetch;
afterEach(() => {
  globalThis.fetch = originalFetch;
});
const grant = (): GrantedConsent => ({
  client_id: 'third-party',
  display_name: 'Reading companion',
  granted: ['openid', 'offline_access', 'subject:read'],
  status: 'current',
  reducible: true,
  pending_reduction: false,
});
type Call = { path: string; init: RequestInit; body: unknown };
function transport(reply: (call: Call) => Response | Promise<Response>) {
  const calls: Call[] = [];
  globalThis.fetch = (async (input, init = {}) => {
    const call = { path: String(input), init, body: init.body ? JSON.parse(String(init.body)) : null };
    calls.push(call);
    return reply(call);
  }) as typeof fetch;
  return calls;
}
function native(granted = grant().granted, scopes = grant().granted) {
  return Response.json({
    client_id: 'third-party',
    display_name: 'Reading companion',
    scopes,
    requested: [],
    granted,
    pending_reduction: false,
    acting_account: { account_id: 'account-1', email: null },
    decisions: { allow: true, decline: true, switch_account: true },
  });
}

test('Reduce selected existing app permissions through the native consent barrier preserves exact current native authority target privacy and immutable operation readback', async () => {
  const consent = grant();
  const retained = ['openid', 'subject:read'];
  const snapshot = createConsentReduction(consent, retained)!;
  expect(Object.keys(snapshot).sort()).toEqual(['clientId', 'current', 'retained']);
  expect(Object.isFrozen(snapshot)).toBe(true);
  expect(Object.isFrozen(snapshot.current)).toBe(true);
  expect(Object.isFrozen(snapshot.retained)).toBe(true);
  let finishRead!: (response: Response) => void;
  const calls = transport((call) =>
    call.path.startsWith('/consent/')
      ? new Promise<Response>((resolve) => {
          finishRead = resolve;
        })
      : Response.json({ client_id: 'third-party', scope: ['subject:read', 'openid'] }),
  );
  const result = reduceConsent(consent, retained);
  consent.client_id = 'changed-target';
  consent.granted.length = 0;
  retained.push('account:manage');
  await Promise.resolve();
  finishRead(native());
  expect(await result).toEqual({ kind: 'accepted' });
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: '/consent/third-party', body: null },
      {
        path: '/consent',
        body: {
          client_id: 'third-party',
          scope: ['openid', 'subject:read'],
          reviewed_scopes: ['openid', 'offline_access', 'subject:read'],
        },
      },
  ]);
  expect(
    calls.every(
      ({ init }) => init.credentials === 'same-origin' && init.cache === 'no-store' && init.redirect === 'error',
    ),
  ).toBe(true);
  expect(calls[1]!.init.method).toBe('POST');
  // The acknowledgement does not change the original snapshot or establish a live grant.
  expect(snapshot.current).toEqual(grant().granted);
  expect(snapshot.retained).toEqual(['openid', 'subject:read']);
});

test('Only strict subsets of the current returned grant are selectable; pending and irreducible states cannot write', async () => {
  const calls = transport(() => {
    throw new Error('No write permitted');
  });
  for (const retained of [['new:permission'], grant().granted, ['openid', 'openid'], ['']]) {
    expect(createConsentReduction(grant(), retained)).toBeNull();
    expect(await reduceConsent(grant(), retained)).toEqual({ kind: 'denied' });
  }
  for (const row of [
    { ...grant(), reducible: false },
    { ...grant(), pending_reduction: true },
    { ...grant(), status: 'inactive' as const },
    { ...grant(), status: 'unavailable' as const },
    { ...grant(), granted: [] },
    { ...grant(), granted: ['openid', 'openid'] },
  ])
    expect(await reduceConsent(row, [])).toEqual({ kind: 'denied' });
  expect(calls).toHaveLength(0);
});

test('Changed grants, current ceiling and failed native reads cannot restore scopes or write from stale authority', async () => {
  for (const response of [
    () => native(['openid']),
    () => native([...grant().granted, 'new:scope'], [...grant().granted, 'new:scope']),
    () => native(['openid'], ['openid']),
    () => native(['openid', 'openid']),
    () => Response.json({ client_id: 'different', scopes: grant().granted, granted: grant().granted }),
    () => Response.json({ error: 'authentication_denied' }, { status: 404 }),
    () => Response.json({ error: 'authentication_denied' }, { status: 401 }),
    () => Response.json({ error: 'authentication_denied' }, { status: 403 }),
    () => Response.json({ error: 'unavailable' }, { status: 503 }),
  ]) {
    const calls = transport(response);
    expect((await reduceConsent(grant(), ['openid'])).kind).not.toBe('accepted');
    expect(calls).toHaveLength(1);
    expect(calls[0]!.body).toBeNull();
  }
});

test('A native stale-review refusal stays explicit and never replays the selected reduction', async () => {
  const calls = transport((call) =>
    call.body === null ? native() : Response.json({ code: 'stale_review' }, { status: 409 }),
  );
  expect(await reduceConsent(grant(), ['openid'])).toEqual({ kind: 'stale-review' });
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: '/consent/third-party', body: null },
    {
      path: '/consent',
      body: {
        client_id: 'third-party',
        scope: ['openid'],
        reviewed_scopes: ['openid', 'offline_access', 'subject:read'],
      },
    },
  ]);
});

test('Exact closed acknowledgements only; ambiguous writes require fresh readback and never replay', async () => {
  for (const body of [
    null,
    {},
    { client_id: 'different', scope: ['openid'] },
    { client_id: 'third-party', scope: [] },
    { client_id: 'third-party', scope: ['openid', 'account:manage'] },
    { client_id: 'third-party', scope: ['openid', 'openid'] },
    { client_id: 'third-party', scope: ['openid'], access_token: 'private' },
  ]) {
    const calls = transport((call) => (call.body === null ? native() : Response.json(body)));
    expect(await reduceConsent(grant(), ['openid'])).toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(2);
  }
  for (const status of [400, 429, 500, 503]) {
    const calls = transport((call) =>
      call.body === null ? native() : Response.json({ error: 'unavailable' }, { status }),
    );
    expect(await reduceConsent(grant(), ['openid'])).toEqual({ kind: 'unknown' });
    expect(calls).toHaveLength(2);
  }
  const calls = transport((call) => {
    if (call.body === null) return native();
    throw new TypeError('Lost write response');
  });
  expect(await reduceConsent(grant(), ['openid'])).toEqual({ kind: 'unknown' });
  expect(calls).toHaveLength(2);
});

test('Remove-all remains the empty-subset alias and inventory strips metadata while keeping exact unknown tokens', async () => {
  const calls = transport(() => Response.json({ client_id: 'third-party', scope: [] }));
  expect(await removeConsent(grant())).toEqual({ kind: 'accepted' });
  expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
    { path: '/consent', body: { client_id: 'third-party', scope: [] } },
  ]);
  const row = { ...grant(), granted: ['<private:token>'], secret: 'private', redirects: ['https://private.test'] };
  const page = parseInventoryPage('consents', { consents: [row], next: null });
  expect(page).toEqual({ kind: 'ready', rows: [{ ...grant(), granted: ['<private:token>'] }], next: null });
  row.granted.push('changed');
  expect(page.kind === 'ready' && page.rows[0]!.granted).toEqual(['<private:token>']);
  expect(
    parseInventoryPage('consents', { consents: [{ ...grant(), granted: ['openid', 'openid'] }], next: null }),
  ).toEqual({ kind: 'unavailable' });
});

test('Approval and removal explain exact native capabilities without changing registered intersection or subset-only authority', async () => {
  const previousLocale = getLocale();
  setLocale('en', { reload: false });
  try {
    const unknown = `subject:read:${'unfamiliar_'.repeat(10)}`;
    const otherUnknown = '<custom:permission>';
    const nativeConsent: Consent = {
      client_id: 'third-party',
      display_name: 'Reading companion',
      scopes: ['openid', 'offline_access', 'subject:read', unknown, otherUnknown, 'account:read'],
      requested: [],
      granted: ['openid', 'offline_access'],
      pending_reduction: false,
      acting_account: { account_id: 'person-1', email: null },
      decisions: { allow: true, decline: true, switch_account: true },
    };
    const requested = [
      'subject:read',
      unknown,
      otherUnknown,
      'account:update',
      'openid',
      'offline_access',
      'account:read',
      'library:read',
    ];
    const expectedStates = [
      'New access',
      'New access',
      'New access',
      'Not available',
      'Already granted',
      'Already granted',
      'New access',
      'Not available',
    ];
    for (const [index, scope] of requested.entries()) {
      const approval = renderToStaticMarkup(
        createElement('li', null, createElement(RequestedPermission, { scope, consent: nativeConsent })),
      );
      const review = renderToStaticMarkup(createElement('li', null, createElement(Permission, { scope })));
      const { label, detail } = permissionDescription(scope);
      expect(approval).toContain(review.slice(4, -5));
      expect(approval).toContain(expectedStates[index]!);
      expect(approval).toContain(label);
      expect(approval).toContain(detail);
      expect(approval.indexOf(label)).toBeLessThan(approval.indexOf('<code'));
      expect(review).toContain(renderToStaticMarkup(createElement('code', null, scope)).replace('<code>', '>'));
      expect(approval).not.toContain('<input');
    }
    expect(permissionDescription('subject:read').label).toBe('Read catalogue entries');
    expect(permissionDescription('openid').detail).toContain('identify your REZICS account');
    expect(permissionDescription('offline_access').detail).toContain('while its current authorization remains valid');
    expect(permissionDescription(unknown).label).toBe('Unrecognized permission');
    expect(permissionDescription('library:read').label).toBe('Unrecognized permission');
    expect(permissionRemovalLabel(unknown)).toBe(`Remove: Unrecognized permission (${unknown})`);
    expect(permissionRemovalLabel(otherUnknown)).toBe(`Remove: Unrecognized permission (${otherUnknown})`);
    expect(permissionRemovalLabel('subject:read')).toBe('Remove: Read catalogue entries (subject:read)');
    const removal = renderToStaticMarkup(createElement(RemovablePermission, { scope: unknown, onRemove: () => {} }));
    expect(removal).toContain(`aria-label="Remove: Unrecognized permission (${unknown})"`);
    expect(removal).toContain('aria-describedby=');
    expect(removal).toContain(`>${unknown}</code>`);

    const approved = approvedScopes(nativeConsent, [...requested, 'subject:read']);
    expect(approved).toEqual(['openid', 'offline_access', 'subject:read', unknown, otherUnknown, 'account:read']);
    const consent = { ...grant(), granted: approved };
    const retained = approved.filter((scope) => scope !== 'offline_access' && scope !== unknown);
    expect(createConsentReduction(consent, retained)?.current).toEqual(approved);
    const calls = transport((call) =>
      call.body === null
        ? Response.json({ ...nativeConsent, granted: approved })
        : Response.json({ client_id: 'third-party', scope: retained }),
    );
    expect(await reduceConsent(consent, retained)).toEqual({ kind: 'accepted' });
    expect(calls.map(({ path, body }) => ({ path, body }))).toEqual([
      { path: '/consent/third-party', body: null },
      {
        path: '/consent',
        body: {
          client_id: 'third-party',
          scope: ['openid', 'subject:read', otherUnknown, 'account:read'],
          reviewed_scopes: approved,
        },
      },
    ]);
    expect(await reduceConsent(consent, [...retained, 'account:update'])).toEqual({ kind: 'denied' });
    expect(calls).toHaveLength(2);
    expect(consent.granted).toEqual(approved);
  } finally {
    setLocale(previousLocale, { reload: false });
  }
});

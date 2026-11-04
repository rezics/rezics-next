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

// Deferred browser coverage: use the default routes, shell, styles and native adapters.
test('Default account deletion and operator-transfer pages allow full phone-width review, truthful prerequisites and safe exit without silently approving or repeating an operation', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const { chromium } = await import('playwright');
  const { createFakeAuthState, startFakeAuth } = await import('../scripts/fake-auth');
  const { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } = await import('@rezics/auth-contract');
  const { OPERATOR_MANAGEMENT_PROFILE } = await import('../src/operator-transfer');
  const en = (await import('../messages/en.json')).default;
  const zh = (await import('../messages/zh-Hans.json')).default;
  const state = createFakeAuthState();
  const fake = startFakeAuth({ state });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  let output = '';
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, AUTH_ORIGIN: fake.url.origin, PRIVACY_CONTACT_URL: 'mailto:privacy@example.test' },
  });
  let startError: Error | undefined;
  child.on('error', (error) => {
    startError = error;
  });
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`Auth dev server exited with ${child.exitCode}:\n${output}`);
      try {
        if ((await originalFetch(`${origin}/login`, { signal: AbortSignal.timeout(10_000) })).status === 200) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Auth dev server did not serve /login:\n${output}`);
      await Bun.sleep(500);
    }
    browser = await chromium.launch();
    for (const [locale, copy] of [
      ['en', en],
      ['zh-Hans', zh],
    ] as const) {
      Object.assign(state, {
        signedOut: false,
        sessionFresh: true,
        sessionClientId: AUTH_PAGE_OPERATION_CLIENT_ID,
        sessionScopes: [...AUTH_PAGE_OPERATION_SCOPES.delete],
        denyAccountOperation: true,
      });
      const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale });
      await context.addCookies([
        { name: 'auth_session', value: 'review-session', url: origin },
        { name: 'rezics_locale', value: locale, url: origin },
      ]);
      const page = await context.newPage();
      page.setDefaultTimeout(10_000);
      const writes: { path: string; body: Record<string, unknown> }[] = [];
      page.on('request', (request) => {
        const path = new URL(request.url()).pathname;
        if (path === '/account-operations/approve' || path === '/account-operations/execute')
          writes.push({ path, body: request.postDataJSON() as Record<string, unknown> });
      });
      async function visit(path: string) {
        const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 });
        expect(response?.status()).toBe(200);
        await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      }
      async function boundedReview() {
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
        const overflow = await page.locator('.auth-card').evaluate((card) =>
          [...card.querySelectorAll<HTMLElement>('p, h1, h2, dd, label, button, a, textarea')]
            .filter((node) => {
              const rect = node.getBoundingClientRect();
              return (
                rect.width > 0 &&
                (rect.left < 0 || rect.right > innerWidth + 1 || node.scrollWidth > node.clientWidth + 1)
              );
            })
            .map((node) => node.textContent),
        );
        expect(overflow).toEqual([]);
        for (const control of await page.locator('.auth-card button:visible, .auth-operation-exit a').all()) {
          const box = await control.boundingBox();
          expect(box!.height).toBeGreaterThanOrEqual(44);
        }
      }
      try {
        await visit('/account/delete?return_to=https%3A%2F%2Funtrusted.example%2F');
        const confirmation = page.locator('#account-delete-input');
        await confirmation.waitFor();
        const deletion = page.getByRole('button', { name: copy.auth_account_delete_submit, exact: true });
        expect(await deletion.isDisabled()).toBe(true);
        expect(writes).toHaveLength(0);
        const prerequisites = page.locator('#account-delete-prerequisites');
        expect(await prerequisites.innerText()).toContain(copy.auth_account_delete_prerequisites_description);
        for (const key of [
          'auth_account_delete_no_automated_accounts',
          'auth_account_delete_not_last_owner',
          'auth_account_delete_no_pending_transfer',
        ] as const)
          expect(await prerequisites.innerText()).toContain(copy[key]);
        expect(await prerequisites.locator('a[href="/operators/transfer"]').count()).toBe(2);
        // The issuer cannot invent the website's organization-list target.
        expect(await prerequisites.locator('a[href="/security"]').count()).toBe(1);
        await boundedReview();
        await confirmation.fill(copy.auth_account_delete_confirmation_phrase);
        await deletion.click();
        const refusal = page.getByRole('alert').filter({ hasText: copy.auth_account_delete_denied });
        await refusal.waitFor();
        expect(writes.map(({ path }) => path)).toEqual(['/account-operations/approve']);
        expect(await confirmation.count()).toBe(0);
        expect(await deletion.isDisabled()).toBe(true);
        expect(await page.locator('.auth-account-identity').count()).toBe(0);
        expect(new URL(page.url()).pathname).toBe('/account/delete');
        expect(await refusal.locator('a').getAttribute('href')).toBe('#account-delete-prerequisites');
        await boundedReview();

        // An unknown execution retains the same operation key and needs fresh confirmation.
        state.denyAccountOperation = false;
        await visit('/account/delete');
        await confirmation.waitFor();
        expect(await confirmation.inputValue()).toBe('');
        await page.route('**/account-operations/execute', (route) =>
          route.fulfill({ status: 503, json: { error: 'unavailable' } }),
        );
        await confirmation.fill(copy.auth_account_delete_confirmation_phrase);
        await deletion.click();
        await page.getByRole('alert').filter({ hasText: copy.auth_account_operation_unknown }).waitFor();
        expect(writes.filter(({ path }) => path.endsWith('/execute'))).toHaveLength(2);
        expect(writes.every(({ body }) => body.operationKey === writes[0]!.body.operationKey)).toBe(true);
        const deletionKey = await page.evaluate(() => sessionStorage.getItem('rezics.account-operation.pending'));
        expect(deletionKey).not.toBeNull();
        const beforeExit = writes.length;
        const exit = page.locator('.auth-operation-exit a');
        expect(await exit.getAttribute('href')).toBe('/security');
        await exit.focus();
        expect(await exit.evaluate((link) => document.activeElement === link)).toBe(true);
        await exit.click();
        await page.getByRole('button', { name: copy.auth_organization_departure_leave, exact: true }).click();
        await page.waitForURL(`${origin}/security`);
        expect(writes).toHaveLength(beforeExit);
        expect(await page.evaluate(() => sessionStorage.getItem('rezics.account-operation.pending'))).toBe(deletionKey);
        await visit('/account/delete');
        await confirmation.waitFor();
        expect(await confirmation.inputValue()).toBe('');
        expect(await deletion.isDisabled()).toBe(true);
        expect(writes).toHaveLength(beforeExit);

        state.sessionClientId = OPERATOR_MANAGEMENT_PROFILE.client_id;
        state.sessionScopes = [...OPERATOR_MANAGEMENT_PROFILE.scope];
        const subject = `operated-${'账户'.repeat(40)}`;
        const source = `source-${'operator'.repeat(15)}`;
        const destination = `destination-${'管理'.repeat(40)}`;
        await page.route('**/account-management/operators/relation', (route) =>
          route.fulfill({
            json: {
              previous: { subjectAccountId: subject, operatorAccountId: source, reservationId: 'reservation' },
              expectedVersion: '12',
            },
          }),
        );
        await page.route('**/account-operations/approve', (route) =>
          route.fulfill({ status: 403, json: { error: 'account_operation_denied' } }),
        );
        await visit('/operators/transfer?return_to=%2F%2Funtrusted.example');
        await page.locator('#transfer-subject').fill(subject);
        await page.locator('#transfer-destination').fill(destination);
        await page.getByRole('button', { name: copy.auth_transfer_prepare, exact: true }).click();
        await page.locator('#transfer-confirm').waitFor();
        for (const value of [subject, source, destination, '12'])
          expect(await page.locator('dd').allTextContents()).toContain(value);
        expect(writes).toHaveLength(beforeExit);
        expect(await page.locator('#transfer-confirm').isChecked()).toBe(false);
        await boundedReview();
        await page.setViewportSize({ width: 1280, height: 860 });
        await boundedReview();
        await page.setViewportSize({ width: 390, height: 844 });
        await page.getByText(copy.auth_transfer_handoff_manual_acceptance, { exact: true }).click();
        await page.locator('#transfer-acceptance').fill('opaque-acceptance-reference');
        await page.locator('#transfer-confirm').check();
        await page.getByRole('button', { name: copy.auth_transfer_submit, exact: true }).click();
        await page.getByRole('alert').filter({ hasText: copy.auth_transfer_denied }).waitFor();
        expect(await page.locator('#transfer-confirm').count()).toBe(0);
        expect(writes).toHaveLength(beforeExit + 1);
        await boundedReview();
        const savedTransfer = await page.evaluate(() => sessionStorage.getItem('rezics.operator-transfer.attempt'));
        expect(savedTransfer).not.toBeNull();
        await page.locator('.auth-operation-exit a').click();
        await page.waitForURL(`${origin}/security`);
        expect(await page.evaluate(() => sessionStorage.getItem('rezics.operator-transfer.attempt'))).toBe(
          savedTransfer,
        );
        await visit('/operators/transfer');
        await page.locator('#transfer-confirm').waitFor();
        expect(await page.locator('#transfer-confirm').isChecked()).toBe(false);
        expect(writes).toHaveLength(beforeExit + 1);
        expect(writes.filter(({ path }) => path.endsWith('/execute'))).toHaveLength(2);
      } finally {
        await context.close();
      }
    }
  } finally {
    await browser?.close();
    fake.stop(true);
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
  }
}, 300_000);

// Deferred browser coverage of the default composition, without injected page sources.
test('Default Security and deletion flows show a genuine recognizable current signed-in identity and discard it on account or authority changes without granting new operation authority', async () => {
  const { spawn } = await import('node:child_process');
  const { createServer } = await import('node:net');
  const { chromium } = await import('playwright');
  const { createFakeAuthState, startFakeAuth } = await import('../scripts/fake-auth');
  const copy = (await import('../messages/en.json')).default;
  const state = createFakeAuthState({ sessionAccountId: 'first-native-account' });
  const fake = startFakeAuth({ state });
  let identityMode: 'ready' | 'unavailable' | 'mismatch' | 'late' | 'denied' = 'ready';
  const firstEmail = '读者.' + 'long-native-login.'.repeat(6) + 'reader@example.test';
  const secondEmail = 'second-native-login@example.test';
  let releaseIdentity: (() => void) | undefined;
  let identityStarted: (() => void) | undefined;
  const identityHost = Bun.serve({
    hostname: '127.0.0.1',
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      if (!['/account-identity', '/account-management/deletion-page'].includes(url.pathname))
        return originalFetch(new Request(new URL(url.pathname + url.search, fake.url), request));
      expect(request.method).toBe('POST');
      expect(await request.json()).toEqual({});
      expect(request.headers.get('cookie')).toContain('auth_session=review-session');
      const accountId = state.sessionAccountId;
      const mode = identityMode;
      if (mode === 'late') {
        const gate = new Promise<void>((resolve) => {
          releaseIdentity = resolve;
        });
        identityStarted?.();
        await gate;
      }
      if (mode === 'unavailable' || mode === 'denied')
        return Response.json(
          { error: 'authentication_denied' },
          {
            status: mode === 'denied' ? 403 : 503,
            headers: { 'cache-control': 'private, no-store' },
          },
        );
      if (url.pathname === '/account-management/deletion-page')
        return Response.json(
          mode === 'mismatch'
            ? { kind: 'changed' }
            : {
                kind: 'review',
                accountId,
                email: accountId === 'first-native-account' ? firstEmail : secondEmail,
                action: 'available',
                policy: 'personal-deletion',
              },
          { headers: { 'cache-control': 'private, no-store' } },
        );
      return Response.json(
        {
          account_id: mode === 'mismatch' ? 'first-native-account' : accountId,
          email: accountId === 'first-native-account' || mode === 'mismatch' ? firstEmail : secondEmail,
        },
        { headers: { 'cache-control': 'private, no-store' } },
      );
    },
  });
  const port = await new Promise<number>((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
  const origin = `http://127.0.0.1:${port}`;
  const child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
    cwd: new URL('..', import.meta.url),
    stdio: ['ignore', 'pipe', 'pipe'],
    detached: true,
    env: { ...process.env, AUTH_ORIGIN: identityHost.url.origin, PRIVACY_CONTACT_URL: 'mailto:privacy@example.test' },
  });
  let output = '';
  let startError: Error | undefined;
  child.on('error', (error) => {
    startError = error;
  });
  const keep = (chunk: Buffer) => {
    output = (output + chunk.toString()).slice(-8000);
  };
  child.stdout!.on('data', keep);
  child.stderr!.on('data', keep);
  let browser: Awaited<ReturnType<typeof chromium.launch>> | undefined;
  try {
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (startError) throw startError;
      if (child.exitCode !== null) throw new Error(`Auth dev server exited with ${child.exitCode}:\n${output}`);
      try {
        if ((await originalFetch(`${origin}/login`, { signal: AbortSignal.timeout(10_000) })).status === 200) break;
      } catch {}
      if (Date.now() > deadline) throw new Error(`Auth dev server did not serve /login:\n${output}`);
      await Bun.sleep(500);
    }
    browser = await chromium.launch();
    const context = await browser.newContext({ viewport: { width: 390, height: 844 }, locale: 'en' });
    await context.addCookies([{ name: 'auth_session', value: 'review-session', url: origin }]);
    const page = await context.newPage();
    page.setDefaultTimeout(10_000);
    const operations: string[] = [];
    page.on('request', (request) => {
      if (new URL(request.url()).pathname.startsWith('/account-operations/')) operations.push(request.url());
    });
    async function visit(path: string) {
      expect((await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded', timeout: 120_000 }))?.status()).toBe(
        200,
      );
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
    }
    async function assertIdentity(email: string, action: 'security' | 'delete') {
      await page.locator('.auth-account-identity-value').filter({ hasText: email }).waitFor();
      expect(await page.locator('h1').getAttribute('aria-describedby')).toBe('auth-account-identity-description');
      expect(await page.locator('#auth-account-identity-description').innerText()).toBe(
        copy[
          action === 'security' ? 'auth_account_identity_security_target' : 'auth_account_identity_delete_target'
        ].replace('{account}', email),
      );
      expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
      const summary = page.locator('.auth-account-identity summary');
      expect((await summary.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      await summary.click();
      expect(await page.locator('.auth-account-identity details').innerText()).toContain(state.sessionAccountId);
    }
    try {
      await visit('/security');
      await assertIdentity(firstEmail, 'security');
      await page.locator('#security-password-heading').waitFor();
      await visit('/account/delete');
      await assertIdentity(firstEmail, 'delete');
      const confirmation = page.locator('#account-delete-input');
      expect(await confirmation.inputValue()).toBe('');
      expect(await page.getByRole('button', { name: copy.auth_account_delete_submit, exact: true }).isDisabled()).toBe(
        true,
      );
      expect(operations).toEqual([]);

      state.sessionAccountId = 'second-native-account';
      identityMode = 'mismatch';
      await visit('/account/delete');
      await page.getByRole('alert').waitFor();
      expect(await page.locator('.auth-card').innerText()).not.toContain(firstEmail);
      expect(await confirmation.count()).toBe(0);
      identityMode = 'ready';
      await visit('/account/delete');
      await assertIdentity(secondEmail, 'delete');
      expect(await page.locator('.auth-card').innerText()).not.toContain(firstEmail);

      identityMode = 'unavailable';
      await visit('/security');
      const retry = page.getByRole('button', { name: copy.auth_account_identity_retry, exact: true });
      await retry.waitFor();
      await page.locator('#security-sessions-heading').waitFor();
      expect(await page.locator('.auth-account-identity').innerText()).toContain(state.sessionAccountId);
      expect(await page.locator('.auth-card').innerText()).not.toContain(secondEmail);
      expect((await retry.boundingBox())!.height).toBeGreaterThanOrEqual(44);
      identityMode = 'ready';
      await retry.click();
      await assertIdentity(secondEmail, 'security');

      identityMode = 'late';
      const started = new Promise<void>((resolve) => {
        identityStarted = resolve;
      });
      await visit('/security');
      await started;
      await page.locator('#security-sessions-heading').waitFor();
      page.once('dialog', (dialog) => void dialog.accept());
      await page.locator('section[aria-labelledby="security-sessions-heading"] article button').first().click();
      await page.waitForURL(`${origin}/login`);
      releaseIdentity!();
      await page.waitForLoadState('networkidle');
      expect(await page.locator('.auth-card').innerText()).not.toContain(secondEmail);
      expect(await page.locator('.auth-account-identity').count()).toBe(0);

      identityMode = 'denied';
      await visit('/account/delete');
      await page.getByRole('alert').waitFor();
      expect(await page.locator('.auth-card').innerText()).not.toContain(secondEmail);
      expect(await confirmation.count()).toBe(0);
      expect(operations).toEqual([]);
    } finally {
      await context.close();
    }
  } finally {
    releaseIdentity?.();
    await browser?.close();
    identityHost.stop(true);
    fake.stop(true);
    if (child.pid)
      try {
        process.kill(-child.pid, 'SIGTERM');
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code !== 'ESRCH') throw error;
      }
  }
}, 300_000);

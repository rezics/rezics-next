import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type BrowserContextOptions, type CDPSession, type Page } from 'playwright';
import { AUTH_PAGE_OPERATION_CLIENT_ID, AUTH_PAGE_OPERATION_SCOPES } from '@rezics/auth-contract';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const accountId = 'acct+id/秘密';
const email = 'reader+passkey@example.test';
const password = 'a secure password';
const session = 'passkey-session-token';
const exp = '1893456000';
const sig = 'opaque-signature';
const now = Date.now();
const authorizationQuery =
  'response_type=code&client_id=rezics-website' +
  '&redirect_uri=https%3A%2F%2Fweb.rezics.test%2Fauth%2Fcallback' +
  '&scope=openid+offline_access&state=opaque%2Bstate%26next%3D%2Fevil' +
  '&nonce=nonce%2Fone&code_challenge=challenge&code_challenge_method=S256' +
  '&resource=https%3A%2F%2Fapi.rezics.test&resource=urn%3Asecond&empty=' +
  '&prompt=login&prompt=select_account&max_age=600';
const resumedQuery = authorizationQuery.replace('&prompt=login&prompt=select_account', '');

type Call = { method: string; url: string; headers: Record<string, string>; body: string };
type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null };
const calls: Call[] = [];
const issued = new Map<string, string>();
let passkeys: Passkey[] = [];
// Whether the person also has a password, which decides if the last passkey may go.
let hasPassword = true;
// A session older than 10 minutes is refused for credential changes until the person confirms again.
let fresh = true;
let sessionCookieSet = false;
let sessionClientId = 'login';
let sessionScopes: string[] = [];
let sessionAccountId = accountId;

function reset(options: { passkeys?: Passkey[]; hasPassword?: boolean; fresh?: boolean; accountId?: string } = {}) {
  calls.length = 0;
  issued.clear();
  passkeys = options.passkeys ?? [];
  hasPassword = options.hasPassword ?? true;
  fresh = options.fresh ?? true;
  sessionCookieSet = false;
  sessionClientId = 'login';
  sessionScopes = [];
  sessionAccountId = accountId;
  if (options.accountId) sessionAccountId = options.accountId;
}

function base64url(bytes: Buffer): string {
  return bytes.toString('base64url');
}

// Copied from apps/auth/tests/security.test.ts's fake Auth HTTP server, extended with the passkey endpoints.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const call: Call = {
      method: request.method,
      url: url.pathname + url.search,
      headers: Object.fromEntries(request.headers.entries()),
      body: await request.text(),
    };
    calls.push(call);
    const headers = new Headers({ 'cache-control': 'no-store' });
    const json = (body: unknown, status = 200) => Response.json(body, { status, headers });
    const stepUp = () => json({ error: 'step_up_required', effect_status: 'not_applied' }, 401);
    const issueSession = (profile: { client_id?: unknown; scope?: unknown }) => {
      const scopes = profile.scope;
      const valid =
        (profile.client_id === 'login' && Array.isArray(scopes) && scopes.length === 0) ||
        (profile.client_id === AUTH_PAGE_OPERATION_CLIENT_ID &&
          Array.isArray(scopes) &&
          Object.values(AUTH_PAGE_OPERATION_SCOPES).some(
            (allowed) => allowed.length === scopes.length && allowed.every((scope, index) => scope === scopes[index]),
          ));
      if (!valid) return false;
      fresh = true;
      sessionCookieSet = true;
      sessionClientId = profile.client_id as string;
      sessionScopes = scopes as string[];
      headers.append('set-cookie', `auth_session=${session}; Path=/; HttpOnly; SameSite=Lax`);
      return true;
    };
    const parsed = () => (call.body ? (JSON.parse(call.body) as Record<string, any>) : {});
    // Accepts a WebAuthn JSON response only if it echoes a challenge this fake issued for this page's origin.
    const acceptsResponse = (response: Record<string, any> | undefined) => {
      if (!response || response.type !== 'public-key' || typeof response.id !== 'string') return false;
      const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
      return issued.get(clientData.challenge) === clientData.type && clientData.origin === call.headers.origin;
    };

    if (url.pathname === '/authorize' && request.method === 'GET') {
      if ((call.headers.cookie ?? '').split(';').some((cookie) => cookie.trim() === `auth_session=${session}`))
        return new Response('Authorization resumed with the session', { headers });
      return new Response('No session', { status: 401, headers });
    }

    if (url.pathname === '/session' && request.method === 'GET')
      return json({ account_id: sessionAccountId, client_id: sessionClientId, scope: sessionScopes });
    if (url.pathname === '/sessions' && request.method === 'GET')
      return json({
        sessions: [
          {
            id: 'current-session',
            client_id: 'login',
            created_at: new Date(now - 86_400_000).toISOString(),
            expires_at: new Date(now + 14 * 86_400_000).toISOString(),
            user_agent: null,
            current: true,
          },
        ],
      });

    if (url.pathname === '/signin' && request.method === 'POST') {
      const body = parsed();
      if (body.email !== email || body.password !== password) return json({ error: 'authentication_denied' }, 401);
      if (!issueSession(body)) return json({ error: 'invalid_scope' }, 400);
      return json({});
    }

    if (url.pathname === '/signin/passkey/options' && request.method === 'POST') {
      const challenge = base64url(randomBytes(32));
      issued.set(challenge, 'webauthn.get');
      return json({ challenge, rpId: 'localhost', timeout: 60_000, userVerification: 'required' });
    }
    if (url.pathname === '/signin/passkey' && request.method === 'POST') {
      const body = parsed();
      if (!acceptsResponse(body.response)) return json({ error: 'authentication_denied' }, 401);
      if (!issueSession(body)) return json({ error: 'invalid_scope' }, 400);
      return json({});
    }

    if (url.pathname.startsWith('/credential-effects/') && request.method === 'POST') {
      if (!fresh) return stepUp();
      if (url.pathname === '/credential-effects/stage')
        return json({
          effectRef: 'effect-ref',
          key: parsed().key,
          subjectId: accountId,
          purpose: 'password',
          digest: 'digest',
        });
      if (url.pathname === '/credential-effects/approve')
        return json({ reference: 'approval-reference', expiresAt: new Date(now + 60_000).toISOString() });
      if (url.pathname === '/credential-effects/apply') return json({ receiptId: 'receipt-id', replayed: false });
    }

    if (url.pathname === '/passkeys' && request.method === 'GET') return json({ passkeys });

    if (url.pathname === '/passkeys/register/options' && request.method === 'POST') {
      if (!fresh) return stepUp();
      const challenge = base64url(randomBytes(32));
      issued.set(challenge, 'webauthn.create');
      return json({
        challenge,
        rp: { id: 'localhost', name: 'REZICS' },
        user: { id: base64url(Buffer.from(accountId)), name: email, displayName: email },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        timeout: 60_000,
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
        excludeCredentials: passkeys.map((passkey) => ({ type: 'public-key', id: passkey.id })),
      });
    }
    if (url.pathname === '/passkeys/register' && request.method === 'POST') {
      if (!fresh) return stepUp();
      const body = parsed();
      if (!acceptsResponse(body.response)) return json({ error: 'registration_denied' }, 400);
      const created: Passkey = {
        id: body.response.id,
        name: typeof body.name === 'string' && body.name ? body.name : 'Unnamed passkey',
        created_at: new Date().toISOString(),
        last_used_at: null,
      };
      passkeys.push(created);
      return json({ id: created.id, name: created.name, created_at: created.created_at }, 201);
    }
    if (url.pathname === '/passkeys/remove' && request.method === 'POST') {
      if (!fresh) return stepUp();
      const id = parsed().id;
      if (passkeys.length === 1 && !hasPassword)
        return json({ error: 'last_interactive_credential', effect_status: 'not_applied' }, 409);
      passkeys = passkeys.filter((passkey) => passkey.id !== id);
      return json({});
    }

    return new Response('Not Found', { status: 404, headers });
  },
});

// Copied from apps/auth/tests/security.test.ts.
function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const { port } = probe.address() as { port: number };
      probe.close(() => resolve(port));
    });
  });
}

let child: ChildProcess | undefined;
let started: Promise<number> | undefined;
let browser: Browser | undefined;

// Copied from apps/auth/tests/security.test.ts's dev-server startup and readiness check.
function site(): Promise<number> {
  started ??= (async () => {
    for (let attempt = 0; attempt < 4; attempt++) {
      const port = await freePort();
      let output = '';
      const keep = (chunk: Buffer) => {
        output = (output + chunk.toString()).slice(-8000);
      };
      child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: { ...process.env, AUTH_ORIGIN: fake.url.origin },
      });
      let startError: Error | undefined;
      child.on('error', (error) => {
        startError = error;
      });
      child.stdout!.on('data', keep);
      child.stderr!.on('data', keep);
      const deadline = Date.now() + 150_000;
      for (;;) {
        if (startError) throw startError;
        if (child.exitCode !== null) {
          if (output.includes('Port ') && output.includes('already in use') && attempt < 3) break;
          throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
        }
        try {
          const response = await fetch(`http://127.0.0.1:${port}/security`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(60_000),
          });
          if (response.status === 200) return port;
        } catch {}
        if (Date.now() > deadline) throw new Error(`dev server did not serve /security in time:\n${output}`);
        await Bun.sleep(500);
      }
    }
    throw new Error('could not start the Auth dev server after retrying occupied ports');
  })();
  return started;
}

type Authenticator = { cdp: CDPSession; id: string };

async function addVirtualAuthenticator(cdp: CDPSession): Promise<Authenticator> {
  const added = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  return { cdp, id: added.authenticatorId };
}

// An IP address cannot be a relying party ID, so the pages are opened at localhost.
async function open(
  path: string,
  options: BrowserContextOptions & { webauthn?: boolean; signedIn?: boolean; pendingOperation?: unknown } = {},
): Promise<{ page: Page; origin: string; authenticator: Authenticator | null }> {
  const { webauthn = true, signedIn = true, pendingOperation, ...contextOptions } = options;
  const port = await site();
  const origin = `http://localhost:${port}`;
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width: 1280, height: 860 },
    reducedMotion: 'reduce',
    locale: 'en',
    ...contextOptions,
    javaScriptEnabled: true,
  });
  if (signedIn)
    await context.addCookies([
      { name: 'auth_session', value: session, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
    ]);
  const page = await context.newPage();
  page.setDefaultTimeout(15_000);
  let authenticator: Authenticator | null = null;
  if (webauthn) {
    const cdp = await context.newCDPSession(page);
    await cdp.send('WebAuthn.enable');
    authenticator = await addVirtualAuthenticator(cdp);
  } else {
    await page.addInitScript(() => {
      Reflect.deleteProperty(window, 'PublicKeyCredential');
    });
  }
  if (pendingOperation)
    await page.addInitScript((pending) => {
      sessionStorage.setItem('rezics.account-operation.step-up', JSON.stringify(pending));
    }, pendingOperation);
  try {
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'networkidle' });
    expect(response?.status(), 'the documented dev server serves the page').toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    return { page, origin, authenticator };
  } catch (error) {
    await context.close();
    throw error;
  }
}

// A resident credential for this relying party that the person registered earlier.
async function addResidentCredential({ cdp, id }: Authenticator) {
  const { privateKey } = generateKeyPairSync('ec', { namedCurve: 'P-256' });
  await cdp.send('WebAuthn.addCredential', {
    authenticatorId: id,
    credential: {
      credentialId: randomBytes(16).toString('base64'),
      isResidentCredential: true,
      rpId: 'localhost',
      privateKey: privateKey.export({ type: 'pkcs8', format: 'der' }).toString('base64'),
      userHandle: Buffer.from(accountId).toString('base64'),
      signCount: 0,
    },
  });
}

beforeAll(async () => {
  await site();
  browser = await chromium.launch();
}, timeout);

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

function authCalls(path: string) {
  return calls.filter((call) => new URL(call.url, fake.url).pathname === path);
}

function postBody(path: string, index = -1) {
  const call = authCalls(path).at(index);
  expect(call, `Auth receives ${path}`).toBeDefined();
  expect(call!.method).toBe('POST');
  expect(call!.headers['content-type']).toMatch(/^application\/json(?:;|$)/);
  return JSON.parse(call!.body) as Record<string, any>;
}

function expectWebAuthnResponse(response: Record<string, any>, kind: 'assertion' | 'attestation') {
  expect(response.type).toBe('public-key');
  expect(typeof response.id).toBe('string');
  expect(typeof response.response.clientDataJSON).toBe('string');
  expect(typeof (kind === 'assertion' ? response.response.signature : response.response.attestationObject)).toBe(
    'string',
  );
}

function searchEntries(search: string): [string, string][] {
  return [...new URLSearchParams(search).entries()];
}

const passkeyButton = (page: Page) => page.getByRole('button', { name: 'Sign in with a passkey', exact: true });

test(
  'a person signs in with a passkey and resumes the authorization',
  async () => {
    reset();
    const { page, authenticator } = await open(`/login?${authorizationQuery}&exp=${exp}&sig=${sig}`, {
      signedIn: false,
    });
    try {
      await addResidentCredential(authenticator!);
      await Promise.all([page.waitForURL((url) => url.pathname === '/authorize'), passkeyButton(page).click()]);
      expect(await page.locator('body').innerText()).toContain('Authorization resumed with the session');
      expect(searchEntries(new URL(page.url()).search)).toEqual(searchEntries(resumedQuery));
      expect(postBody('/signin/passkey/options')).toEqual({});
      const signedIn = postBody('/signin/passkey');
      expect(signedIn).toEqual({ response: expect.any(Object), client_id: 'login', scope: [] });
      expectWebAuthnResponse(signedIn.response, 'assertion');
      expect(sessionCookieSet).toBe(true);
      // A passkey sign-in is two Auth calls, even though autofill already asked for options.
      expect(authCalls('/signin/passkey/options')).toHaveLength(1);
      expect(authCalls('/signin/passkey')).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'the email field offers passkeys through autofill',
  async () => {
    reset();
    const { page, authenticator } = await open(`/login?${authorizationQuery}`, { signedIn: false });
    try {
      const emailField = page.getByLabel('Email', { exact: true });
      await page.waitForFunction(
        () => document.querySelector<HTMLInputElement>('input[type=email]')?.autocomplete === 'username webauthn',
      );
      expect(await emailField.getAttribute('autocomplete')).toBe('username webauthn');
      // Conditional mediation starts without a click: Auth is asked for discoverable-credential options.
      for (let waited = 0; authCalls('/signin/passkey/options').length === 0 && waited < 50; waited++)
        await Bun.sleep(100);
      expect(authCalls('/signin/passkey/options')).toHaveLength(1);
      expect(postBody('/signin/passkey/options')).toEqual({});
      expect(authCalls('/signin/passkey')).toHaveLength(0);

      // With a credential for this relying party present, autofill signs in with no click.
      await addResidentCredential(authenticator!);
      await Promise.all([page.waitForURL((url) => url.pathname === '/authorize'), page.reload()]);
      expect(await page.locator('body').innerText()).toContain('Authorization resumed with the session');
      expect(postBody('/signin/passkey')).toEqual({ response: expect.any(Object), client_id: 'login', scope: [] });
      expect(authCalls('/signin/passkey')).toHaveLength(1);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a person adds a passkey in security settings, names it and sees it listed',
  async () => {
    reset({
      passkeys: [
        {
          id: 'existing-passkey',
          name: 'Work laptop',
          created_at: new Date(now - 40 * 86_400_000).toISOString(),
          last_used_at: new Date(now - 2 * 86_400_000).toISOString(),
        },
      ],
    });
    const { page } = await open('/security', { locale: 'de', timezoneId: 'Europe/Berlin' });
    try {
      const section = page.getByRole('region', { name: 'Passkeys', exact: true });
      await section.waitFor({ state: 'visible' });
      expect(await section.getByRole('heading', { level: 2, name: 'Passkeys', exact: true }).count()).toBe(1);
      const list = section.getByRole('list', { name: 'Passkeys', exact: true });
      expect(await list.getByRole('listitem').count()).toBe(1);
      const existing = await list.getByRole('listitem').first().innerText();
      expect(existing).toContain('Work laptop');
      const formatted = (value: number) =>
        new Intl.DateTimeFormat('de', { dateStyle: 'medium', timeStyle: 'short', timeZone: 'Europe/Berlin' }).format(
          new Date(value),
        );
      expect(existing).toContain(formatted(now - 40 * 86_400_000));
      expect(existing).toContain(formatted(now - 2 * 86_400_000));
      expect(authCalls('/passkeys')).toHaveLength(1);
    } finally {
      await page.context().close();
    }

    reset({
      passkeys: [
        {
          id: 'existing-passkey',
          name: 'Work laptop',
          created_at: new Date(now - 40 * 86_400_000).toISOString(),
          last_used_at: null,
        },
      ],
    });
    const { page: english, authenticator } = await open('/security');
    try {
      const section = english.getByRole('region', { name: 'Passkeys', exact: true });
      await section.waitFor({ state: 'visible' });
      const list = section.getByRole('list', { name: 'Passkeys', exact: true });
      expect(await list.getByRole('listitem').first().innerText()).toContain('Never used');

      await section.getByLabel('Passkey name (optional)').fill('Phone');
      await Promise.all([
        english.waitForResponse((response) => new URL(response.url()).pathname === '/passkeys/register'),
        section.getByRole('button', { name: 'Add a passkey', exact: true }).click(),
      ]);
      expect(postBody('/passkeys/register/options')).toEqual({});
      const registered = postBody('/passkeys/register');
      expect(registered).toEqual({ response: expect.any(Object), name: 'Phone' });
      expectWebAuthnResponse(registered.response, 'attestation');
      const rows = list.getByRole('listitem');
      await rows.nth(1).waitFor({ state: 'visible' });
      expect(await rows.count()).toBe(2);
      expect(await rows.nth(1).innerText()).toContain('Phone');
      expect(await section.getByLabel('Passkey name (optional)').inputValue()).toBe('');
      // Registration is two Auth calls, and the new row comes from the 201 body, not a second list.
      expect(authCalls('/passkeys/register/options')).toHaveLength(1);
      expect(authCalls('/passkeys/register')).toHaveLength(1);
      expect(authCalls('/passkeys')).toHaveLength(1);

      // Left unnamed, the passkey is named for the browser and system. An authenticator that already holds a listed
      // passkey refuses another one, so the person uses a different authenticator.
      await authenticator!.cdp.send('WebAuthn.removeVirtualAuthenticator', { authenticatorId: authenticator!.id });
      await addVirtualAuthenticator(authenticator!.cdp);
      await section.getByRole('button', { name: 'Add a passkey', exact: true }).click();
      await rows.nth(2).waitFor({ state: 'visible' });
      expect(postBody('/passkeys/register').name).toMatch(/^(Google Chrome|Chromium) on \w+$/);
      expect(await rows.nth(2).innerText()).toContain(postBody('/passkeys/register').name);

      let confirmations = 0;
      english.on('dialog', async (dialog) => {
        confirmations++;
        expect(dialog.type()).toBe('confirm');
        await dialog.accept();
      });
      await Promise.all([
        english.waitForResponse((response) => new URL(response.url()).pathname === '/passkeys/remove'),
        rows.nth(1).getByRole('button', { name: 'Remove passkey Phone', exact: true }).click(),
      ]);
      expect(confirmations).toBe(1);
      expect(postBody('/passkeys/remove')).toEqual({ id: expect.any(String) });
      expect(postBody('/passkeys/remove').id).toBe(registered.response.id);
      await rows.nth(2).waitFor({ state: 'detached' });
      expect(await rows.count()).toBe(2);
      expect(await list.innerText()).not.toContain('Phone');
      expect(authCalls('/passkeys/remove')).toHaveLength(1);
    } finally {
      await english.context().close();
    }
  },
  timeout,
);

test(
  'removing the last interactive credential is refused with a localized message',
  async () => {
    reset({
      hasPassword: false,
      passkeys: [
        {
          id: 'only-passkey',
          name: 'Only key',
          created_at: new Date(now - 86_400_000).toISOString(),
          last_used_at: null,
        },
      ],
    });
    for (const [locale, message] of [
      ['en', 'You cannot remove your last way to sign in. Add a password or another passkey first.'],
      [
        'fr',
        'Vous ne pouvez pas supprimer votre dernière méthode de connexion. Ajoutez d’abord un mot de passe ou une autre clé d’accès.',
      ],
    ] as const) {
      calls.length = 0;
      const { page } = await open('/security', { locale });
      try {
        page.on('dialog', (dialog) => dialog.accept());
        const row = page
          .getByRole('region', { name: locale === 'en' ? 'Passkeys' : 'Clés d’accès' })
          .getByRole('listitem');
        await row.waitFor({ state: 'visible' });
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/passkeys/remove'),
          row.getByRole('button').click(),
        ]);
        const alert = page.getByRole('alert');
        await alert.waitFor({ state: 'visible' });
        expect(await alert.innerText()).toContain(message);
        expect(await row.count()).toBe(1);
        expect(authCalls('/passkeys/remove')).toHaveLength(1);
        expect(passkeys).toHaveLength(1);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'step-up accepts a passkey',
  async () => {
    reset({ fresh: false });
    const { page, authenticator } = await open(`/step-up?${authorizationQuery}&exp=${exp}&sig=${sig}`);
    try {
      expect(await page.getByLabel('Email', { exact: true }).count()).toBe(1);
      expect(await page.getByLabel('Password', { exact: true }).count()).toBe(1);
      await addResidentCredential(authenticator!);
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/authorize'),
        page.getByRole('button', { name: 'Verify with a passkey', exact: true }).click(),
      ]);
      expect(searchEntries(new URL(page.url()).search)).toEqual(searchEntries(resumedQuery));
      expect(postBody('/signin/passkey')).toEqual({ response: expect.any(Object), client_id: 'login', scope: [] });
      expect(authCalls('/signin/passkey/options')).toHaveLength(1);
      expect(authCalls('/signin/passkey')).toHaveLength(1);
      expect(fresh).toBe(true);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'account-operation passkey step-up issues only the fixed delete profile and resumes without executing it',
  async () => {
    reset({ fresh: false });
    const pendingOperation = {
      version: 1,
      kind: 'delete',
      accountId,
      operationKey: '0123456789abcdef0123456789abcdef',
      operation: { kind: 'delete', accountId },
      returnTo: '/account/delete',
    };
    const { page, authenticator } = await open('/step-up?account_operation=delete&return_to=%2Faccount%2Fdelete', {
      pendingOperation,
    });
    try {
      await addResidentCredential(authenticator!);
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/account/delete'),
        page.getByRole('button', { name: 'Verify with a passkey', exact: true }).click(),
      ]);
      const signedIn = postBody('/signin/passkey');
      expect(signedIn).toEqual({
        response: expect.any(Object),
        client_id: AUTH_PAGE_OPERATION_CLIENT_ID,
        scope: [...AUTH_PAGE_OPERATION_SCOPES.delete],
      });
      expectWebAuthnResponse(signedIn.response, 'assertion');
      expect(sessionClientId).toBe(AUTH_PAGE_OPERATION_CLIENT_ID);
      expect(sessionScopes).toEqual([...AUTH_PAGE_OPERATION_SCOPES.delete]);
      expect(new URL(page.url()).search).toBe('');
      expect(await page.getByRole('heading', { name: 'Delete your account', exact: true }).count()).toBe(1);
      expect(await page.getByRole('textbox').inputValue()).toBe('');
      expect(authCalls('/signin/passkey/options')).toHaveLength(1);
      expect(authCalls('/signin/passkey')).toHaveLength(1);
      expect(authCalls('/account-operations/approve')).toHaveLength(0);
      expect(authCalls('/account-operations/execute')).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a browser without WebAuthn shows no passkey controls',
  async () => {
    reset({ passkeys: [] });
    for (const path of ['/login', '/step-up', '/security']) {
      calls.length = 0;
      const { page } = await open(path, { webauthn: false });
      try {
        expect(await page.evaluate(() => 'PublicKeyCredential' in window)).toBe(false);
        if (path === '/security') await page.getByRole('region', { name: 'Password', exact: true }).waitFor();
        expect(await page.getByRole('button', { name: /passkey/i }).count(), path).toBe(0);
        expect(await page.getByRole('heading', { name: /passkeys/i }).count(), path).toBe(0);
        expect(await page.getByText(/passkey/i).count(), path).toBe(0);
        if (path !== '/security') {
          expect(await page.locator('input[type=email]').getAttribute('autocomplete')).toBe('username');
          // The password form is the whole page.
          expect(await page.getByRole('button', { name: /^(Sign in|Verify your identity)$/ }).count()).toBe(1);
        }
        expect(calls.filter((call) => call.url.includes('passkey'))).toHaveLength(0);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a step-up started from security settings returns to security settings',
  async () => {
    // A password step-up.
    reset({ fresh: false });
    const { page, origin } = await open('/security');
    try {
      await page.getByLabel('New password', { exact: true }).fill('another secure password');
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/step-up'),
        page.getByRole('button', { name: 'Update password', exact: true }).click(),
      ]);
      expect(new URL(page.url()).searchParams.get('return_to')).toBe('/security');
      await page.locator('html[data-hydrated]').waitFor({ state: 'attached' });
      await page.getByLabel('Email', { exact: true }).fill(email);
      await page.getByLabel('Password', { exact: true }).fill(password);
      await Promise.all([
        page.waitForURL((url) => url.pathname === '/security'),
        page.getByRole('button', { name: 'Verify your identity', exact: true }).click(),
      ]);
      expect(new URL(page.url()).origin).toBe(origin);
      expect(new URL(page.url()).search).toBe('');
      expect(authCalls('/authorize')).toHaveLength(0);
      await page.getByLabel('New password', { exact: true }).waitFor();
      expect(fresh).toBe(true);
    } finally {
      await page.context().close();
    }

    // Adding a passkey with a stale session goes to step-up, and a passkey step-up comes back.
    reset({ fresh: false });
    const second = await open('/security');
    try {
      const { page: settings, authenticator } = second;
      await addResidentCredential(authenticator!);
      const section = settings.getByRole('region', { name: 'Passkeys', exact: true });
      await section.waitFor({ state: 'visible' });
      await Promise.all([
        settings.waitForURL((url) => url.pathname === '/step-up'),
        section.getByRole('button', { name: 'Add a passkey', exact: true }).click(),
      ]);
      expect(new URL(settings.url()).searchParams.get('return_to')).toBe('/security');
      expect(passkeys).toHaveLength(0);
      await Promise.all([
        settings.waitForURL((url) => url.pathname === '/security'),
        settings.getByRole('button', { name: 'Verify with a passkey', exact: true }).click(),
      ]);
      expect(new URL(settings.url()).search).toBe('');
      expect(authCalls('/authorize')).toHaveLength(0);
      await settings.getByRole('region', { name: 'Passkeys', exact: true }).waitFor();
      expect(fresh).toBe(true);

      // Another origin or path in return_to never leaves the Auth pages.
      for (const returnTo of ['https://evil.test/security', '//evil.test', '/authorize', '/login']) {
        await settings.goto(`${second.origin}/step-up?return_to=${encodeURIComponent(returnTo)}`);
        await settings.locator('html[data-hydrated]').waitFor({ state: 'attached' });
        await Promise.all([
          settings.waitForURL((url) => url.pathname !== '/step-up'),
          settings.getByRole('button', { name: 'Verify with a passkey', exact: true }).click(),
        ]);
        expect(new URL(settings.url()).origin).toBe(second.origin);
        expect(new URL(settings.url()).pathname).toBe('/security');
        expect(new URL(settings.url()).search).toBe('');
      }
    } finally {
      await second.page.context().close();
    }
  },
  timeout,
);

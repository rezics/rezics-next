import { securityEnvelope, currentSecuritySession, signInPage } from './security-page-fixture';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { generateKeyPairSync, randomBytes } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const accountId = 'acct-cost';
const session = 'cost-session-token';
const scales = [1, 8, 31];

type Call = { method: string; path: string; body: string };
type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null };
const calls: Call[] = [];
const issued = new Map<string, string>();
let passkeys: Passkey[] = [];

function seed(count: number) {
  calls.length = 0;
  issued.clear();
  passkeys = Array.from({ length: count }, (_, index) => ({
    id: `passkey-${index}`,
    name: `Passkey ${index}`,
    created_at: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
    last_used_at: null,
  }));
}

// Copied from apps/auth/tests/passkeys.test.ts's fake Auth, reduced to recording the requests the pages make.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    calls.push({ method: request.method, path: url.pathname, body });
    const headers = new Headers({ 'cache-control': 'no-store' });
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    const accepts = (response: Record<string, any> | undefined) => {
      if (!response || response.type !== 'public-key') return false;
      const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
      return issued.get(clientData.challenge) === clientData.type;
    };

    if (url.pathname === '/authorize') return new Response('resumed', { headers });
    if (url.pathname === '/signin/page' && request.method === 'POST')
      return json(signInPage(JSON.parse(body).query, url.origin, { kind: 'signed-out' }));
    if (url.pathname === '/security-page')
      return json(securityEnvelope(accountId, [currentSecuritySession()], passkeys));
    if (url.pathname === '/session') return json({ account_id: accountId });
    if (url.pathname === '/sessions') return json({ sessions: [] });
    if (url.pathname === '/passkeys' && request.method === 'GET') return json({ passkeys });
    if (url.pathname === '/signin/passkey/options') {
      const challenge = randomBytes(32).toString('base64url');
      issued.set(challenge, 'webauthn.get');
      return json({ challenge, rpId: 'localhost', timeout: 60_000, userVerification: 'required' });
    }
    if (url.pathname === '/signin/passkey') {
      if (!accepts(JSON.parse(body).response)) return json({ error: 'authentication_denied' }, 401);
      headers.append('set-cookie', `auth_session=${session}; Path=/; HttpOnly; SameSite=Lax`);
      return json({});
    }
    if (url.pathname === '/passkeys/register/options') {
      const challenge = randomBytes(32).toString('base64url');
      issued.set(challenge, 'webauthn.create');
      return json({
        challenge,
        rp: { id: 'localhost', name: 'REZICS' },
        user: { id: Buffer.from(accountId).toString('base64url'), name: 'cost', displayName: 'cost' },
        pubKeyCredParams: [{ type: 'public-key', alg: -7 }],
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      });
    }
    if (url.pathname === '/passkeys/register') {
      const response = JSON.parse(body).response;
      if (!accepts(response)) return json({ error: 'registration_denied' }, 400);
      const saved = { id: response.id, name: 'Added', created_at: new Date().toISOString(), last_used_at: null };
      passkeys.push(saved);
      return json(saved, 201);
    }
    if (url.pathname === '/passkeys/remove') {
      passkeys = passkeys.filter((passkey) => passkey.id !== JSON.parse(body).id);
      return json({ success: true });
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

// A page with a virtual authenticator that then holds a resident credential, opened at localhost for the relying party.
async function open(path: string): Promise<{ page: Page }> {
  const port = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en' });
  await context.addCookies([
    { name: 'auth_session', value: session, domain: 'localhost', path: '/', httpOnly: true, sameSite: 'Lax' },
  ]);
  const page = await context.newPage();
  // Count the explicit button ceremony; autofill has its own journey in passkeys.test.ts.
  if (path.startsWith('/login'))
    await page.addInitScript(() => {
      Object.defineProperty(PublicKeyCredential, 'isConditionalMediationAvailable', { value: async () => false });
    });
  page.setDefaultTimeout(15_000);
  const cdp = await context.newCDPSession(page);
  await cdp.send('WebAuthn.enable');
  const { authenticatorId } = await cdp.send('WebAuthn.addVirtualAuthenticator', {
    options: {
      protocol: 'ctap2',
      transport: 'internal',
      hasResidentKey: true,
      hasUserVerification: true,
      isUserVerified: true,
      automaticPresenceSimulation: true,
    },
  });
  try {
    await page.goto(`http://localhost:${port}${path}`, { waitUntil: 'networkidle' });
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    // Added after load: with a credential already present, autofill would sign in before the test acts.
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: randomBytes(16).toString('base64'),
        isResidentCredential: true,
        rpId: 'localhost',
        privateKey: generateKeyPairSync('ec', { namedCurve: 'P-256' })
          .privateKey.export({ type: 'pkcs8', format: 'der' })
          .toString('base64'),
        userHandle: Buffer.from(accountId).toString('base64'),
        signCount: 0,
      },
    });
    return { page };
  } catch (error) {
    await context.close();
    throw error;
  }
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

// Auth requests the page made, leaving out the navigation to /authorize that resumes a request.
function authRequests(since = 0): string[] {
  return calls
    .slice(since)
    .filter((call) => call.path !== '/authorize')
    .map((call) => `${call.method} ${call.path}`);
}

test(
  'a passkey sign-in reads native advice and sends two commands however many passkeys the person has',
  async () => {
    for (const count of scales) {
      seed(count);
      const { page } = await open('/login?client_id=rezics-website&response_type=code');
      try {
        await Promise.all([
          page.waitForURL((url) => url.pathname === '/authorize'),
          page.getByRole('button', { name: 'Sign in with a passkey', exact: true }).click(),
        ]);
        expect(authRequests(), `${count} passkeys`).toEqual([
          'POST /signin/page',
          'POST /signin/passkey/options',
          'POST /signin/passkey',
        ]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a passkey step-up makes two Auth requests however many passkeys the person has',
  async () => {
    for (const count of scales) {
      seed(count);
      const { page } = await open('/step-up?return_to=%2Fsecurity');
      try {
        expect(authRequests(), `${count} passkeys, before the click`).toEqual([]);
        await Promise.all([
          page.waitForURL((url) => url.pathname === '/security'),
          page.getByRole('button', { name: 'Verify with a passkey', exact: true }).click(),
        ]);
        expect(authRequests().slice(0, 2), `${count} passkeys`).toEqual([
          'POST /signin/passkey/options',
          'POST /signin/passkey',
        ]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'the Security page uses four bounded reads however many passkeys the person has',
  async () => {
    for (const count of scales) {
      seed(count);
      const { page } = await open('/security');
      try {
        await page
          .getByRole('list', { name: 'Passkeys', exact: true })
          .getByRole('listitem')
          .nth(count - 1)
          .waitFor();
        expect(await page.getByRole('list', { name: 'Passkeys', exact: true }).getByRole('listitem').count()).toBe(
          count,
        );
        expect(authRequests().sort(), `${count} passkeys`).toEqual([
          'GET /clients',
          'GET /consents',
          'GET /security-page',
          'POST /account-identity',
        ]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'adding a passkey uses its two commands and refreshes native advice however many passkeys the person has',
  async () => {
    for (const count of scales) {
      seed(count);
      const { page } = await open('/security');
      try {
        await page
          .getByRole('list', { name: 'Passkeys', exact: true })
          .getByRole('listitem')
          .nth(count - 1)
          .waitFor();
        const before = calls.length;
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/passkeys/register'),
          page.getByRole('button', { name: 'Add a passkey', exact: true }).click(),
        ]);
        await page
          .getByRole('list', { name: 'Passkeys', exact: true })
          .getByRole('listitem')
          .nth(count)
          .getByRole('button')
          .and(page.locator(':enabled'))
          .waitFor();
        expect(authRequests(before), `${count} passkeys`).toEqual([
          'POST /passkeys/register/options',
          'POST /passkeys/register',
          'GET /security-page',
        ]);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'removing a passkey checks the current account and sends one command however many passkeys the person has',
  async () => {
    for (const count of scales) {
      seed(count);
      const { page } = await open('/security');
      try {
        page.on('dialog', (dialog) => dialog.accept());
        const rows = page.getByRole('list', { name: 'Passkeys', exact: true }).getByRole('listitem');
        await rows.nth(count - 1).waitFor();
        const before = calls.length;
        await rows.first().getByRole('button').click();
        await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
        expect(authRequests(before), `${count} passkeys`).toEqual(['GET /session', 'POST /passkeys/remove']);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

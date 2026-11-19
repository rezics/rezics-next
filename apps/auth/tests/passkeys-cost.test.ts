import { recoveryPage } from '../../../services/auth/src/recovery-page';
import { readRegistrationPage } from '../../../services/auth/src/registration-page';
import { startNativeAuthIssuerProxy } from '../../web/tests/native/native-auth-security-fixture';
import { securityEnvelope, currentSecuritySession, signInPage } from './security-page-fixture';
import { nativeSignInOptions, nativeSignInProof } from './sign-in-fixture';
import { managementOperationProfile } from '@rezics/auth-contract';
import { afterAll, beforeAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, generateKeyPairSync, randomBytes, X509Certificate } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const accountId = 'acct-cost';
const email = 'reader+passkey-cost@example.test';
const session = 'cost-session-token';
const scales = [1, 8, 31];
const loginProfile = { client_id: 'login', scope: [] };
const stepUpProfile = managementOperationProfile('security');

type Call = { method: string; path: string };
type Passkey = { id: string; name: string; created_at: string; last_used_at: string | null };
const calls: Call[] = [];
const issued = new Map<string, string>();
let passkeys: Passkey[] = [];
let sessionProof = nativeSignInProof(loginProfile, 'pwd', accountId);

function seed(count: number) {
  calls.length = 0;
  issued.clear();
  sessionProof = nativeSignInProof(loginProfile, 'pwd', accountId);
  passkeys = Array.from({ length: count }, (_, index) => ({
    id: `passkey-${index}`,
    name: `Passkey ${index}`,
    created_at: new Date(Date.now() - (index + 1) * 86_400_000).toISOString(),
    last_used_at: null,
  }));
}

// The issuer records native reads and commands independently of browser asset and BFF traffic.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    const body = await request.text();
    calls.push({ method: request.method, path: url.pathname });
    const headers = new Headers({ 'cache-control': 'no-store' });
    const json = (value: unknown, status = 200) => Response.json(value, { status, headers });
    const accepts = (response: Record<string, any> | undefined, type: string) => {
      if (!response || response.type !== 'public-key' || typeof response.id !== 'string') return false;
      const clientData = JSON.parse(Buffer.from(response.response.clientDataJSON, 'base64url').toString('utf8'));
      return (
        clientData.type === type &&
        clientData.origin === origin &&
        request.headers.get('origin') === origin &&
        issued.get(clientData.challenge) === type &&
        issued.delete(clientData.challenge)
      );
    };
    const signedIn = request.headers
      .get('cookie')
      ?.split(';')
      .some((cookie) => cookie.trim() === `auth_session=${session}`);

    if (url.pathname === '/authorize' && request.method === 'GET')
      return new Response(signedIn ? 'resumed' : 'No session', { status: signedIn ? 200 : 401, headers });
    if (url.pathname === '/signin/page' && request.method === 'POST')
      return json(signInPage(JSON.parse(body).query, origin, { kind: 'signed-out' }));
    if (url.pathname === '/recovery/page' && request.method === 'POST')
      return json(recoveryPage(JSON.parse(body).stage, { minPasswordLength: 8, maxPasswordLength: 128 }));
    if (url.pathname === '/registration-page' && request.method === 'GET')
      return json(
        await readRegistrationPage({
          readSession: async () => Response.json(sessionProof, { status: signedIn ? 200 : 401 }),
          passwordLimits: async () => ({ minLength: 8, maxLength: 128 }),
          verificationConfigured: true,
        }),
      );
    if (url.pathname === '/security-page' && request.method === 'GET')
      return json(
        securityEnvelope(accountId, [{ ...currentSecuritySession(), client_id: sessionProof.client_id }], passkeys),
      );
    if (url.pathname === '/session' && request.method === 'GET')
      return signedIn ? json(sessionProof) : json({ error: 'authentication_required' }, 401);
    if (url.pathname === '/account-identity' && request.method === 'POST')
      return json({ account_id: accountId, email });
    if (url.pathname === '/clients' && request.method === 'GET') return json({ clients: [], next: null });
    if (url.pathname === '/consents' && request.method === 'GET') return json({ consents: [], next: null });
    if (url.pathname === '/signin/passkey/options' && request.method === 'POST') {
      const challenge = randomBytes(32).toString('base64url');
      issued.set(challenge, 'webauthn.get');
      return json(nativeSignInOptions(challenge));
    }
    if (url.pathname === '/signin/passkey' && request.method === 'POST') {
      const requestBody = JSON.parse(body);
      if (!accepts(requestBody.response, 'webauthn.get')) return json({ error: 'authentication_denied' }, 401);
      const expected = signedIn ? stepUpProfile : loginProfile;
      if (
        requestBody.client_id !== expected.client_id ||
        !Array.isArray(requestBody.scope) ||
        requestBody.scope.length !== expected.scope.length ||
        !expected.scope.every((scope, index) => scope === requestBody.scope[index])
      )
        return json({ error: 'invalid_scope' }, 400);
      sessionProof = nativeSignInProof(expected, 'pop', accountId);
      headers.append('set-cookie', `auth_session=${session}; Path=/; Secure; HttpOnly; SameSite=Lax`);
      return json(sessionProof);
    }
    if (url.pathname === '/passkeys/register/options' && request.method === 'POST') {
      const challenge = randomBytes(32).toString('base64url');
      issued.set(challenge, 'webauthn.create');
      return json({
        challenge,
        rp: { id: 'rezics.com', name: 'REZICS' },
        user: { id: Buffer.from('a'.repeat(32)).toString('base64url'), name: 'cost', displayName: 'cost' },
        pubKeyCredParams: [-8, -7, -257].map((alg) => ({ type: 'public-key', alg })),
        extensions: { credProps: true },
        hints: [],
        timeout: 60_000,
        excludeCredentials: [],
        attestation: 'none',
        authenticatorSelection: { residentKey: 'required', requireResidentKey: true, userVerification: 'required' },
      });
    }
    if (url.pathname === '/passkeys/register' && request.method === 'POST') {
      const response = JSON.parse(body).response;
      if (!accepts(response, 'webauthn.create')) return json({ error: 'registration_denied' }, 400);
      const saved = { id: response.id, name: 'Added', created_at: new Date().toISOString(), last_used_at: null };
      passkeys.push(saved);
      return json({ id: saved.id, name: saved.name, created_at: saved.created_at }, 201);
    }
    if (url.pathname === '/passkeys/remove' && request.method === 'POST') {
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
let browser: Browser;
let issuer: Awaited<ReturnType<typeof startNativeAuthIssuerProxy>> | undefined;
let origin: string;

// Copied from apps/auth/tests/security.test.ts's dev-server startup and readiness check.
async function site(): Promise<number> {
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
      env: {
        ...process.env,
        REZICS_TEST_RUNTIME: '1',
        REZICS_AUTH_TEST_PAGE_ORIGIN: origin,
        AUTH_ORIGIN: fake.url.origin,
        AUTH_SECURITY_SCOPE_CONFIGURATION: 'native-no-catalogue',
      },
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
}

// A page with a virtual authenticator and resident credential for the native rezics.com relying party.
async function open(path: string): Promise<{ page: Page }> {
  const context = await browser.newContext({ viewport: { width: 1280, height: 860 }, locale: 'en' });
  if (!path.startsWith('/login'))
    await context.addCookies([
      { name: 'auth_session', value: session, url: origin, secure: true, httpOnly: true, sameSite: 'Lax' },
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
    const response = await page.goto(`${origin}${path}`, { waitUntil: 'domcontentloaded' });
    expect(response?.status(), `the HTTPS dev bridge serves ${path}`).toBe(200);
    await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
    // Added after load: with a credential already present, autofill would sign in before the test acts.
    await cdp.send('WebAuthn.addCredential', {
      authenticatorId,
      credential: {
        credentialId: randomBytes(16).toString('base64'),
        isResidentCredential: true,
        rpId: 'rezics.com',
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
  const proxy = await startNativeAuthIssuerProxy();
  issuer = proxy;
  origin = proxy.origin;
  const port = await site();
  proxy.setUpstream(`http://127.0.0.1:${port}`);
  const certificateKey = new X509Certificate(proxy.webTls.certificate).publicKey.export({
    type: 'spki',
    format: 'der',
  });
  const pin = createHash('sha256').update(certificateKey).digest('base64');
  browser = await chromium.launch({
    args: [
      '--no-proxy-server',
      `--host-resolver-rules=MAP ${new URL(origin).hostname} 127.0.0.1`,
      `--ignore-certificate-errors-spki-list=${pin}`,
    ],
  });
}, timeout);

afterAll(async () => {
  await browser?.close();
  await issuer?.stop();
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

async function waitForSecurityAdvice(page: Page) {
  await page.getByText(email, { exact: true }).waitFor();
  await page.getByText('No applications on this page.', { exact: true }).waitFor();
  await page.getByText('No applications appear on this page.', { exact: true }).waitFor();
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
        expect(await page.getByText('resumed', { exact: true }).isVisible()).toBe(true);
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
  'a passkey step-up reads native advice and sends two commands however many passkeys the person has',
  async () => {
    for (const count of scales) {
      seed(count);
      const { page } = await open('/step-up?return_to=%2Fsecurity');
      try {
        const verify = page.getByRole('button', { name: 'Verify with a passkey', exact: true });
        await verify.waitFor();
        expect(authRequests(), `${count} passkeys, before the click`).toEqual(['POST /recovery/page']);
        const before = calls.length;
        const atReturn = page
          .waitForRequest((request) => request.isNavigationRequest() && new URL(request.url()).pathname === '/security')
          .then(() => authRequests(before));
        const [stepUpRequests] = await Promise.all([
          atReturn,
          page.waitForURL((url) => url.pathname === '/security'),
          verify.click(),
        ]);
        expect(new URL(page.url()).origin).toBe(origin);
        expect(new URL(page.url()).search).toBe('');
        expect(stepUpRequests, `${count} passkeys`).toEqual(['POST /signin/passkey/options', 'POST /signin/passkey']);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'the Security page uses five bounded reads however many passkeys the person has',
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
        await waitForSecurityAdvice(page);
        expect(authRequests().sort(), `${count} passkeys`).toEqual([
          'GET /clients',
          'GET /consents',
          'GET /registration-page',
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
        await waitForSecurityAdvice(page);
        const before = calls.length;
        await Promise.all([
          page.waitForResponse((response) => new URL(response.url()).pathname === '/passkeys/register'),
          page.getByRole('button', { name: 'Add a passkey', exact: true }).click(),
        ]);
        await page
          .getByRole('list', { name: 'Passkeys', exact: true })
          .getByRole('listitem')
          .nth(count)
          .getByRole('button', { name: 'Remove passkey Added', exact: true })
          .and(page.locator(':enabled'))
          .waitFor();
        const requests = authRequests(before);
        expect(requests.slice(0, 2), `${count} passkeys`).toEqual([
          'POST /passkeys/register/options',
          'POST /passkeys/register',
        ]);
        expect(requests.slice(2).sort(), `${count} passkeys, after registration`).toEqual([
          'GET /registration-page',
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
        const rows = page.getByRole('list', { name: 'Passkeys', exact: true }).getByRole('listitem');
        await rows.nth(count - 1).waitFor();
        await waitForSecurityAdvice(page);
        const before = calls.length;
        await rows.first().getByRole('button', { name: 'Remove passkey Passkey 0', exact: true }).click();
        const review = page.getByRole('dialog', { name: 'Review passkey removal', exact: true });
        await review.waitFor();
        expect(authRequests(before), `${count} passkeys, before confirmation`).toEqual([]);
        await review.getByRole('button', { name: 'Confirm passkey removal', exact: true }).click();
        await page.getByRole('link', { name: 'Sign in', exact: true }).waitFor();
        expect(authRequests(before), `${count} passkeys`).toEqual(['GET /session', 'POST /passkeys/remove']);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

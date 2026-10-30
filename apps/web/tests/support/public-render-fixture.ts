import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join, resolve } from 'node:path';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import { pathToFileURL } from 'node:url';
import { createStoryRecordedKernelFetch } from '../../src/kernel/fake';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type BrowserContextOptions } from 'playwright';

const app = join(import.meta.dir, '../..');
const clientId = 'rezics-website';
const sessionCookie = '__Host-rezics_session';
// The API's RFC 8707 resource identifier in tests; production uses https://api.rezics.com.
const resource = 'https://api.rezics.test';
const scopes = ['media:create', 'media:read_reservation', 'media:read', 'media:complete', 'media:erase'];
const desktop = { width: 1280, height: 860 };
// Router timestamps and issuer claims share the server's fixed render clock.
const renderTime = Date.now();

export const publicRenderState = {
  authRequests: 0,
  sessionReads: 0,
  credentialReads: 0,
  sessionQueries: 0,
  stalled: false,
  expiresIn: 3600,
  kernelRequests: 0,
};

// The website client's key, which only the Worker holds, and the issuer's signing key.
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string };
const codes = new Map<string, Grant>();
const liveRefreshTokens = new Set<string>();
let counter = 0;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });

// Auth as it serves the website client. The person is already signed in there, so authorization answers at once.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    if (new URL(request.url).pathname === '/session-read') {
      publicRenderState.sessionReads += 1;
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/credential-read') {
      publicRenderState.credentialReads += 1;
      return new Response(null, { status: 204 });
    }
    if (new URL(request.url).pathname === '/session-query') {
      publicRenderState.sessionQueries += 1;
      return new Response(null, { status: 204 });
    }
    publicRenderState.authRequests += 1;
    // While stalled, Auth accepts connections and never answers.
    if (publicRenderState.stalled) return new Promise<Response>(() => {});
    const url = new URL(request.url);
    const issuer = `${url.origin}/auth`;
    const authenticated = async (form: URLSearchParams) => {
      try {
        await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
          currentDate: new Date(renderTime),
        });
        return true;
      } catch {
        return false;
      }
    };

    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: `${issuer}/token`,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/logout`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/authorize') {
      const params = url.searchParams;
      const code = `code-${randomUUID()}`;
      codes.set(code, {
        challenge: params.get('code_challenge')!,
        nonce: params.get('nonce')!,
        redirectUri: params.get('redirect_uri')!,
      });
      const back = new URL(params.get('redirect_uri')!);
      back.searchParams.set('code', code);
      back.searchParams.set('state', params.get('state')!);
      return new Response(null, { status: 302, headers: { location: back.href } });
    }
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await authenticated(form))) return json({ error: 'invalid_client' }, 401);
      counter += 1;
      const tokens: Record<string, unknown> = {
        access_token: `access-${counter}`,
        token_type: 'Bearer',
        expires_in: publicRenderState.expiresIn,
        refresh_token: `refresh-${counter}`,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (form.get('grant_type') === 'authorization_code') {
        const grant = codes.get(form.get('code') ?? '');
        codes.delete(form.get('code') ?? '');
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        tokens.id_token = await new SignJWT({ nonce: grant.nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject('alice')
          .setAudience(clientId)
          .setIssuedAt(Math.floor(renderTime / 1000))
          .setExpirationTime(Math.floor(renderTime / 1000) + 300)
          .sign(issuerKeys.privateKey);
        // The fixture records refresh tokens only to reject replay during the authorization flow.
      } else if (
        form.get('grant_type') !== 'refresh_token' ||
        !liveRefreshTokens.delete(form.get('refresh_token') ?? '')
      )
        return json({ error: 'invalid_grant' }, 400);
      liveRefreshTokens.add(tokens.refresh_token as string);
      return json(tokens);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await authenticated(form))) return json({ error: 'invalid_client' }, 401);
      liveRefreshTokens.delete(form.get('token') ?? '');
      return new Response(null, { status: 200 });
    }
    if (url.pathname === '/auth/logout') {
      return new Response(null, {
        status: 302,
        headers: { location: url.searchParams.get('post_logout_redirect_uri') ?? issuer },
      });
    }
    return json({ error: 'not_found' }, 404);
  },
});

const recorded = createStoryRecordedKernelFetch();
const kernel = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch: (request) => {
    publicRenderState.kernelRequests += 1;
    return recorded(request);
  },
});
let child: ChildProcess | undefined;
let browser: Browser | undefined;
let started: Promise<string> | undefined;
let directory: string | undefined;
export function publicRenderSite(): Promise<string> {
  return (started ??= (async () => {
    const root = resolve(app, '../..');
    await mkdir(join(root, '.temp'), { recursive: true });
    directory = await mkdtemp(join(root, '.temp/public-render-'));
    const config = join(directory, 'vite.config.ts');
    // Count real Durable Object RPCs without changing their answers or the application sources.
    await Bun.write(
      config,
      `
      import config from ${JSON.stringify(pathToFileURL(join(app, 'vite.config.ts')).href)};
      export default { ...config, cacheDir: ${JSON.stringify(join(directory, 'cache'))}, plugins: [...config.plugins, {
        name: 'count-session-rpcs', enforce: 'pre',
        transform(code, id) {
          // Hold time constant as well as kernel data: router hydration includes read timestamps.
          if (id.endsWith('/src/server.ts')) return \`const liveDate = Date;
            globalThis.Date = new Proxy(liveDate, {
              construct(target, args) { return Reflect.construct(target, args.length ? args : [${renderTime}]); },
              get(target, key) { return key === 'now' ? () => ${renderTime} : Reflect.get(target, key); }
            });\` + code;
          if (id.endsWith('/src/session/state.ts')) return code.replace('return readSessionIdentity(request, env);', 'await fetch(${JSON.stringify(`${fake.url.origin}/session-query`)}); return readSessionIdentity(request, env);');
          if (!id.endsWith('/src/session/store.ts')) return;
          return code
            .replace('async signedIn(): Promise<{ signedIn: boolean; subject?: string; csrfToken: string | null }> {', '$& await fetch(${JSON.stringify(`${fake.url.origin}/session-read`)});')
            .replace('credential(): Promise<Credential> {', 'credential(): Promise<Credential> { return fetch(${JSON.stringify(`${fake.url.origin}/credential-read`)}).then(() => this.countedCredential()); } private countedCredential(): Promise<Credential> {');
        }
      }] };
    `,
    );
    const port = await new Promise<number>((resolve, reject) => {
      const probe = createServer();
      probe.once('error', reject);
      probe.listen(0, '127.0.0.1', () => {
        const port = (probe.address() as { port: number }).port;
        probe.close(() => resolve(port));
      });
    });
    let output = '';
    child = spawn(
      'bun',
      [
        'run',
        'dev',
        '--configLoader',
        'bundle',
        '--config',
        config,
        '--host',
        '127.0.0.1',
        '--port',
        String(port),
        '--strictPort',
      ],
      {
        cwd: app,
        detached: true,
        stdio: ['ignore', 'pipe', 'pipe'],
        env: {
          ...process.env,
          KERNEL_ORIGIN: kernel.url.origin,
          AUTH_ISSUER: `${fake.url.origin}/auth`,
          WEBSITE_CLIENT_ID: clientId,
          WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
          API_RESOURCE: resource,
          WEBSITE_SCOPES: scopes.join(' '),
        },
      },
    );
    child.stdout!.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
    child.stderr!.on('data', (chunk) => (output = (output + chunk).slice(-12000)));
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    while (Date.now() < deadline) {
      if (child.exitCode !== null) throw new Error(output);
      try {
        if ((await fetch(`${origin}/en`)).status === 200) return origin;
      } catch {}
      await Bun.sleep(250);
    }
    throw new Error(output);
  })());
}
export async function publicRenderPage(options: BrowserContextOptions = {}) {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ viewport: desktop, ...options });
  return context.newPage();
}
export async function signedInCookie(origin: string) {
  const client = await publicRenderPage();
  await client.goto(`${origin}/auth/sign-in?return_to=/en`);
  await client.waitForLoadState('networkidle');
  const cookie = (await client.context().cookies()).find((cookie) => cookie.name === sessionCookie)!;
  if (!cookie) throw new Error('The sign-in flow did not set a session cookie');
  await client.context().close();
  return cookie;
}

let closed = false;
export async function closePublicRenderFixture() {
  if (closed) return;
  closed = true;
  await browser?.close();
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
  kernel.stop(true);
  fake.stop(true);
  if (directory) await rm(directory, { recursive: true, force: true });
}

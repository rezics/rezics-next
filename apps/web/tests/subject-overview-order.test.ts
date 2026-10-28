import { afterAll, expect, mock, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { createHash, randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair, jwtVerify, SignJWT } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import fixtures from '../src/kernel/fixtures.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';
import recordedPage from '../src/kernel/recorded/subject-page.json';
import recordedSubject from '../src/kernel/recorded/subject.json';
import { platformRegistry, planReads, type CompositionDocument } from '@rezics/composition';
import { SubjectPage, type SubjectPageData } from '../src/features/pages/subject.tsx';
import fixtures from '../src/kernel/fixtures.json';
import { createFakeKernelFetch } from '../src/kernel/fake.ts';

// The slot's server functions read the Worker environment, which a unit test has none of.
mock.module('../src/library/subject-slot-actions.ts', () => ({
  mutateSubjectLibrarySlot: async () => ({ result: 'unavailable' }),
  readSubjectLibraryCollections: async () => ({ state: 'unavailable', collections: null }),
}));
// So do the router links of the references.
mock.module('../src/library/subject-ref.tsx', () => ({ SubjectRef: () => null }));
mock.module('../src/library/account-ref.tsx', () => ({ AccountRef: () => null }));
const { SubjectLibrarySlot } = await import('../src/library/subject-slot-view.tsx');

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientId = 'rezics-website';
const session = '__Host-rezics_session';
const login = '__Host-rezics_login';
const resource = 'https://api.rezics.test';
const scopes = ['reaction:set'];
const subjectId = fixtures.subjects[0]!.id;
const subjectPath = `/en/subjects/${subjectId}`;

const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };

type Grant = { challenge: string; nonce: string; redirectUri: string; scope: string; sub: string; expiresIn: number };
type Family = { sub: string; current: string; expiresIn: number; revoked: boolean };
type Kind = 'like' | 'love' | 'laugh' | 'insightful' | 'sad';
type Call = { method: string; path: string; body: unknown; key: string | null; authorization: string | null };
const codes = new Map<string, Grant>();
const families = new Map<string, Family>();
const assertions = new Set<string>();
const accessTokens: string[] = [];
let counter = 0;
let calls: Call[] = [];
let counts: Partial<Record<Kind, number>> = {};
let own: Kind | null = null;

const json = (body: unknown, status = 200) => Response.json(body, { status, headers: { 'cache-control': 'no-store' } });
const problem = (status: number, code: string) => ({
  type: `https://rezics.com/problems/${code}`,
  title: code,
  status,
  code,
  retryable: false,
  effect_status: 'not_applicable',
  request_id: randomUUID(),
});
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reset(next: Partial<Record<Kind, number>> = { like: 6, love: 3, laugh: 2, insightful: 4, sad: 1 }) {
  calls = [];
  counts = next;
  own = null;
}

// The auth provider and the site dev-server setup follow library-subject-slot.test.ts.
const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  async fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/v1/platform/exposure')
      return json({ admitted: ['personal_library', 'reading_progress', 'collections'] });
    if (url.pathname === '/turnstile.js')
      return new Response(
        `
        window.turnstile = {
          render(container, options) {
            const verify = document.createElement('button');
            verify.type = 'button'; verify.textContent = 'Verify test challenge';
            verify.onclick = () => options.callback('token-' + crypto.randomUUID());
            container.append(verify);
            return '1';
          },
          reset() {},
          remove(id) {}
        };
      `,
        { headers: { 'content-type': 'text/javascript' } },
      );
    const issuer = `${url.origin}/auth`;
    const tokenEndpoint = `${issuer}/token`;
    const client = async (form: URLSearchParams) => {
      if (form.get('client_assertion_type') !== 'urn:ietf:params:oauth:client-assertion-type:jwt-bearer') return false;
      try {
        const { payload, protectedHeader } = await jwtVerify(form.get('client_assertion') ?? '', clientKeys.publicKey, {
          issuer: clientId,
          subject: clientId,
          audience: issuer,
          algorithms: ['ES256'],
          maxTokenAge: '120s',
        });
        if (
          protectedHeader.kid !== clientJwk.kid ||
          payload.aud !== issuer ||
          !payload.jti ||
          assertions.has(payload.jti) ||
          !payload.exp ||
          !payload.iat ||
          payload.exp - payload.iat > 120
        )
          return false;
        assertions.add(payload.jti);
        return true;
      } catch {
        return false;
      }
    };
    const issue = async (family: Family, nonce?: string) => {
      counter += 1;
      const access = `access-${counter}`;
      const refresh = `refresh-${counter}`;
      family.current = refresh;
      families.set(refresh, family);
      accessTokens.push(access);
      const body: Record<string, unknown> = {
        access_token: access,
        token_type: 'Bearer',
        expires_in: family.expiresIn,
        refresh_token: refresh,
        scope: ['openid', 'offline_access', ...scopes].join(' '),
      };
      if (nonce !== undefined) {
        body.id_token = await new SignJWT({ nonce })
          .setProtectedHeader({ alg: 'ES256', kid: 'issuer-1' })
          .setIssuer(issuer)
          .setSubject(family.sub)
          .setAudience(clientId)
          .setIssuedAt()
          .setExpirationTime('5m')
          .sign(issuerKeys.privateKey);
      }
      return json(body);
    };
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer,
        authorization_endpoint: `${issuer}/authorize`,
        token_endpoint: tokenEndpoint,
        jwks_uri: `${issuer}/jwks`,
        revocation_endpoint: `${issuer}/revoke`,
        end_session_endpoint: `${issuer}/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (url.pathname === '/auth/token' && request.method === 'POST') {
      const form = new URLSearchParams(await request.text());
      if (!(await client(form))) return json({ error: 'invalid_client' }, 401);
      if (form.get('grant_type') === 'authorization_code') {
        const code = form.get('code') ?? '';
        const grant = codes.get(code);
        codes.delete(code);
        if (
          !grant ||
          form.get('redirect_uri') !== grant.redirectUri ||
          createHash('sha256')
            .update(form.get('code_verifier') ?? '')
            .digest('base64url') !== grant.challenge
        )
          return json({ error: 'invalid_grant' }, 400);
        return issue({ sub: grant.sub, current: '', expiresIn: grant.expiresIn, revoked: false }, grant.nonce);
      }
      if (form.get('grant_type') === 'refresh_token') {
        const family = families.get(form.get('refresh_token') ?? '');
        if (!family || family.revoked || family.current !== form.get('refresh_token'))
          return json({ error: 'invalid_grant' }, 400);
        return issue(family);
      }
      return json({ error: 'unsupported_grant_type' }, 400);
    }
    if (url.pathname === '/auth/revoke' && request.method === 'POST') return new Response(null, { status: 200 });
    if (!url.pathname.startsWith('/v1/')) return new Response(null, { status: 404 });
    const body =
      request.method === 'GET' || request.method === 'DELETE'
        ? null
        : await request
            .clone()
            .json()
            .catch(() => null);
    calls.push({
      method: request.method,
      path: url.pathname,
      body,
      key: request.headers.get('idempotency-key'),
      authorization: request.headers.get('authorization'),
    });
    if (request.method === 'GET' && url.pathname === `/v1/subjects/${subjectId}`)
      return createFakeKernelFetch(fixtures as never)(request);
    if (request.method === 'POST' && url.pathname === '/v1/pages:read')
      return createFakeKernelFetch(fixtures as never)(request);
    if (url.pathname === `/v1/subjects/${subjectId}/reactions` && request.method === 'GET')
      return json({
        counts: Object.entries(counts).map(([kind, count]) => ({ kind, count })),
        watermark: null,
      });
    if (url.pathname === `/v1/subjects/${subjectId}/reaction`) {
      if (request.method === 'GET') {
        if (!request.headers.get('authorization')) return json(problem(401, 'unauthorized'), 401);
        return json({ kind: own });
      }
      if (request.method === 'PUT') {
        own = (body as { kind: Kind }).kind;
        return json({ kind: own });
      }
      if (request.method === 'DELETE') {
        own = null;
        return new Response(null, { status: 204 });
      }
    }
    if (url.pathname === '/v1/reports' && request.method === 'POST')
      return json({ reportId: '0192f3a0-6c1e-7b2a-9d4e-0000000000aa' }, 201);
    return json(problem(404, 'not_found'), 404);
  },
});

function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const probe = createServer();
    probe.once('error', reject);
    probe.listen(0, '127.0.0.1', () => {
      const port = (probe.address() as { port: number }).port;
      probe.close(() => resolve(port));
    });
  });
}
let child: ChildProcess | undefined;
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
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
        KERNEL_ORIGIN: fake.url.origin,
        TURNSTILE_SITE_KEY: 'subject-test-key',
        TURNSTILE_SCRIPT_URL: `${fake.url.origin}/turnstile.js`,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: clientId,
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: resource,
        WEBSITE_SCOPES: scopes.join(' '),
      },
    });
    child.stdout!.on('data', keep);
    child.stderr!.on('data', keep);
    const origin = `http://127.0.0.1:${port}`;
    const deadline = Date.now() + 150_000;
    for (;;) {
      if (child.exitCode !== null) throw new Error(`dev server exited with ${child.exitCode}:\n${output}`);
      try {
        const response = await fetch(`${origin}/en`, { redirect: 'manual', signal: AbortSignal.timeout(60_000) });
        if (response.status < 500) {
          const page = await fetch(`${origin}${subjectPath}`, {
            redirect: 'manual',
            signal: AbortSignal.timeout(90_000),
          });
          if (page.status >= 500) throw new Error(`subject page did not compile:\n${output}`);
          return origin;
        }
      } catch {
        /* wait for Vite */
      }
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}
const cookieValue = (response: Response, name: string) =>
  response.headers
    .getSetCookie()
    .find((line) => line.startsWith(`${name}=`))
    ?.split(';')[0]
    ?.slice(name.length + 1);
async function signIn(returnTo = subjectPath) {
  const origin = await site();
  const start = await fetch(`${origin}/auth/sign-in?return_to=${encodeURIComponent(returnTo)}`, { redirect: 'manual' });
  const params = new URL(start.headers.get('location')!).searchParams;
  const code = `code-${randomUUID()}`;
  codes.set(code, {
    challenge: params.get('code_challenge')!,
    nonce: params.get('nonce')!,
    redirectUri: params.get('redirect_uri')!,
    scope: params.get('scope')!,
    sub: 'alice',
    expiresIn: 3600,
  });
  const loginCookie = cookieValue(start, login);
  const answer = await fetch(`${params.get('redirect_uri')}?code=${code}&state=${params.get('state')}`, {
    redirect: 'manual',
    headers: loginCookie ? { cookie: `${login}=${loginCookie}` } : {},
  });
  expect([302, 303]).toContain(answer.status);
  return { origin, session: cookieValue(answer, session)!, access: accessTokens.at(-1)! };
}
let browser: Browser | undefined;
async function open(
  path: string,
  options: { signedIn?: boolean; javaScript?: boolean; width?: number } = {},
): Promise<{ page: Page; access: string | undefined; origin: string }> {
  const { signedIn = true, javaScript = true, width = 1280 } = options;
  const auth = signedIn ? await signIn(path) : undefined;
  const origin = await site();
  browser ??= await chromium.launch();
  const context = await browser.newContext({
    viewport: { width, height: 860 },
    reducedMotion: 'reduce',
    javaScriptEnabled: javaScript,
  });
  if (auth)
    await context.addCookies([
      {
        name: session,
        value: auth.session,
        domain: '127.0.0.1',
        path: '/',
        httpOnly: true,
        secure: true,
        sameSite: 'Lax',
      },
    ]);
  const page = await context.newPage();
  page.setDefaultTimeout(10_000);
  page.setDefaultNavigationTimeout(120_000);
  await page.goto(`${origin}${path}`, { waitUntil: javaScript ? 'networkidle' : 'load' });
  if (javaScript) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
  if (javaScript && signedIn) await page.locator('#account-menu-button').waitFor({ timeout: 120_000 });
  return { page, access: auth?.access, origin };
}

const cluster = (page: Page) => page.locator('main header').getByRole('group', { name: 'Reactions' });

// ---- The server-rendered overview of the recorded page ----

const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Unlabelled',
  sources: 'Sources',
  aliases: 'Also known as',
  search: 'Search',
};
type Recorded = typeof recordedPage & SubjectPageData;
const recordedBody = (data: SubjectPageData) =>
  data.reads.r0!.body as {
    subject: { descriptions: Record<string, string>; aliases: Record<string, string[]> };
  };
function loaded(change?: (data: SubjectPageData) => void): SubjectPageData {
  const data = structuredClone(recordedPage) as unknown as Recorded;
  change?.(data);
  return data;
}
function render(data: SubjectPageData, locale = 'en') {
  return renderToString(createElement(SubjectPage, { page: data, locale, messages, renderJsonLd: false }));
}
const summaryText =
  'A pilot stranded in the Sahara meets a small prince who has left his asteroid, and learns from him what matters.';
const originalName = '>Le Petit Prince<';
const count = (html: string, text: string) => html.split(text).length - 1;

// The recorded subject has no relations; one of its editions stands in as a related subject for the relations node.
function withRelation(data: SubjectPageData) {
  const plan = planReads(platformRegistry, data.document as CompositionDocument, {
    subject: data.subject,
    account: null,
  });
  const editions = data.reads[plan.nodes.editions!]!.body as { links: Record<string, unknown>[] };
  const related = data.reads[plan.nodes['side-stories']!]!.body as { links: unknown[]; count: unknown };
  related.links = [{ ...editions.links[0], property: 'rezics:sideStoryOf' }];
  related.count = { value: 1, exact: true };
}

test("the subject story renders the platform template's overview in order: header, About (summary, key facts, tags), editions, relations, ratings, reviews, discussion, lists, sources", () => {
  const html = render(loaded(withRelation));
  const slots = [
    'subject-header',
    'subject-summary',
    'subject-facts',
    'subject-tags',
    'subject-list',
    'relation-groups',
    'rating-summary',
    'review-list',
    'thread-list',
    'collection-list',
    'subject-sources',
  ];
  const at = slots.map((slot) => html.indexOf(`data-slot="${slot}"`));
  expect(at.every((index) => index >= 0)).toBe(true);
  expect(at).toEqual([...at].sort((a, b) => a - b));
  // The old template's catch-all row is gone: the summary is the About section, not a "Summary" fact.
  expect(html).not.toMatch(/<dt[^>]*>Abstract<\/dt>/);
  expect(count(html, 'data-slot="subject-summary"')).toBe(1);
  // About holds the summary, the key facts and the tags as one section, under one heading.
  const about = html.slice(html.indexOf('data-slot="subject-summary"'), html.indexOf('data-slot="subject-list"'));
  expect(count(about, '<h2')).toBe(1);
  expect(about).toContain('>About</h2>');
  for (const part of ['subject-facts', 'subject-tags']) expect(about).toContain(`data-slot="${part}"`);
  expect(about).toContain(summaryText);
});

test('the summary text appears once on the page: the header never shows the short description', () => {
  // The recorded description paraphrases the summary: only About carries the prose.
  const apart = render(loaded());
  expect(count(apart, 'A poetic novella')).toBe(0);
  expect(count(apart, summaryText)).toBe(1);

  const describe = (text: string) => (data: SubjectPageData) => {
    recordedBody(data).subject.descriptions.en = text;
  };
  for (const description of [
    summaryText,
    `  ${summaryText}  `,
    'A pilot stranded in the Sahara meets a small prince',
    'A pilot,  stranded in the Sahara -- meets a small   prince who has left his asteroid and learns from him what matters',
  ]) {
    const html = render(loaded(describe(description)));
    expect(count(html, 'Sahara')).toBe(1);
    expect(count(html, summaryText)).toBe(1);
    expect(html).not.toContain('A poetic novella');
  }
  // A description that extends the summary is also absent from the header.
  const longer = render(loaded(describe(`${summaryText} It is the most translated book in French.`)));
  expect(count(longer, 'Sahara')).toBe(1);
});

test('an alternate name equal to the original title is not repeated under Also known as', () => {
  const html = render(loaded());
  // The original title shows under the title once; the alias row would repeat it.
  expect(count(html, originalName)).toBe(1);
  const listed = (text: string) => text.slice(text.indexOf('Also known as'));
  // The other language's alias remains for a reader whose own language has none left.
  const reader = render(loaded(), 'zh-Hans');
  expect(reader).toContain('Also known as');
  expect(listed(reader)).toContain('星の王子様');
  expect(count(reader, originalName)).toBe(1);
  // With nothing left the row is dropped.
  const bare = render(
    loaded((data) => {
      recordedBody(data).subject.aliases = { en: ['Le Petit Prince', 'The Little Prince'], ja: [' le petit prince '] };
    }),
  );
  expect(bare).not.toContain('Also known as');
  expect(count(bare, originalName)).toBe(1);
});

// ---- The Library controls in the header ----

const slotData = {
  session: 'signed-in',
  csrfToken: 'token',
  entryAvailable: true,
  entry: null,
  publicCollections: null,
  publicCollectionsNext: null,
  collectionsLoaded: false,
  collections: null,
} as const;
const tokens = (html: string) =>
  html.match(/class="([^"]*)"/g)?.flatMap((value) => value.slice(7, -1).split(' ')) ?? [];

test('the library state action is the one filled primary button and Add to collection is a secondary button', () => {
  for (const entry of [null, { subjectId, state: 'completed' as const, revision: 1 }]) {
    const html = renderToString(
      createElement(SubjectLibrarySlot, {
        subject: { id: subjectId, label: 'Le Petit Prince' } as never,
        locale: 'en',
        data: { ...slotData, entry },
      }),
    );
    // Exactly one control is filled with the primary color: the state select.
    expect(tokens(html).filter((token) => token === 'bg-primary')).toHaveLength(1);
    const trigger = html.match(/<button[^>]*data-slot="select-trigger"[^>]*>/)?.[0] ?? '';
    expect(trigger.split(/\s+/)).toContain('bg-primary');
    expect(trigger).toContain('text-primary-foreground');
    // Add to collection is the outline variant: a border, no fill, and the foreground text color.
    const add = html.match(/<summary[^>]*>Add to collection<\/summary>/)?.[0] ?? '';
    expect(add).toContain('bg-background');
    expect(add.split(/\s+/)).not.toContain('bg-primary');
    expect(add).not.toContain('text-primary');
    expect(add).toContain('border-border');
  }
});

// ---- The reaction cluster on a phone ----

test(
  "at 390 wide the reaction cluster is one row: the two most used kinds and the reader's own kind show with counts, the rest are inside the React picker",
  async () => {
    reset();
    own = 'sad';
    const wide = await open(subjectPath, { width: 1280 });
    try {
      for (const name of ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'])
        expect(await cluster(wide.page).getByRole('button', { name, exact: true }).isVisible()).toBe(true);
    } finally {
      await wide.page.context().close();
    }

    const phone = await open(subjectPath, { width: 390 });
    try {
      const group = cluster(phone.page);
      const visible = async (name: string) => group.getByRole('button', { name, exact: true }).isVisible();
      // Like 6 and Insightful 4 are the most used; Sad 1 is the reader's own.
      for (const name of ['Like 6', 'Insightful 4', 'Sad 1']) expect(await visible(name)).toBe(true);
      for (const name of ['Love 3', 'Laugh 2']) expect(await visible(name)).toBe(false);
      const row = await Promise.all(
        [
          group.getByRole('button', { name: 'Like 6', exact: true }),
          group.getByRole('button', { name: 'Sad 1', exact: true }),
          group.getByRole('button', { name: 'React', exact: true }),
        ].map(async (locator) => (await locator.boundingBox())!),
      );
      for (const box of row) expect(Math.abs(box.y - row[0]!.y)).toBeLessThan(4);
      const box = (await group.boundingBox())!;
      expect(box.height).toBeLessThan(row[0]!.height * 1.6);
      const menu = (await phone.page
        .locator('main header')
        .getByRole('button', { name: 'More actions', exact: true })
        .boundingBox())!;
      expect(Math.abs(menu.y + menu.height / 2 - (box.y + box.height / 2))).toBeLessThan(box.height);
      expect(await phone.page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);

      await group.getByRole('button', { name: 'React', exact: true }).click();
      const choices = phone.page.getByRole('dialog', { name: 'Choose a reaction' });
      const offered = (await choices.getByRole('button').allInnerTexts()).map((text) =>
        text.replace(/\s+/g, ' ').trim(),
      );
      // The picker lists every kind, and the kinds that left the row carry their counts.
      expect(offered).toEqual(['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1']);
      await phone.page.keyboard.press('Escape');
    } finally {
      await phone.page.context().close();
    }

    // Without a reaction of their own the row shows only the two most used kinds.
    reset();
    const other = await open(subjectPath, { width: 390 });
    try {
      const group = cluster(other.page);
      for (const name of ['Love 3', 'Laugh 2', 'Sad 1'])
        expect(await group.getByRole('button', { name, exact: true }).isVisible()).toBe(false);
      for (const name of ['Like 6', 'Insightful 4'])
        expect(await group.getByRole('button', { name, exact: true }).isVisible()).toBe(true);
    } finally {
      await other.page.context().close();
    }
  },
  timeout,
);

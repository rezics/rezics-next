import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = id(1);
const threadId = id(2);
const recent = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const metadata = { route: 0, visibility: 'published', securityRevision: '1', createdAt: recent } as const;
const authors = { organization: id(90), person: id(91), missing: id(92), active: id(93) } as const;
// The read of a deleted account carries no name, handle or avatar. These responses still carry them, so that a
// stale field changes nothing on the page.
const accounts = new Map<string, Record<string, unknown>>([
  [
    authors.organization,
    {
      id: authors.organization,
      kind: 'organization',
      state: 'deleted',
      handle: 'stale-organization',
      displayName: 'Stale Organization',
      avatar: { url: 'https://example.com/stale.png' },
      automated: true,
      operatorId: authors.active,
    },
  ],
  [
    authors.person,
    {
      id: authors.person,
      kind: 'actor',
      state: 'deleted',
      handle: 'stale-person',
      displayName: 'Stale Person',
      automated: true,
    },
  ],
  [
    authors.active,
    { id: authors.active, kind: 'actor', state: 'active', handle: 'carol', displayName: 'Carol', automated: false },
  ],
]);
const labels: Record<string, { deleted: string; organization: string; unknown: string }> = {
  en: { deleted: 'Deleted account', organization: 'Deleted organization', unknown: 'Unknown account' },
  de: { deleted: 'Gelöschtes Konto', organization: 'Gelöschte Organisation', unknown: 'Unbekanntes Konto' },
  es: { deleted: 'Cuenta eliminada', organization: 'Organización eliminada', unknown: 'Cuenta desconocida' },
  fr: { deleted: 'Compte supprimé', organization: 'Organisation supprimée', unknown: 'Compte inconnu' },
  ja: { deleted: '削除されたアカウント', organization: '削除された組織', unknown: '不明なアカウント' },
  ko: { deleted: '삭제된 계정', organization: '삭제된 조직', unknown: '알 수 없는 계정' },
  'zh-Hans': { deleted: '已删除的账号', organization: '已删除的组织', unknown: '未知账号' },
  'zh-Hant': { deleted: '已刪除的帳號', organization: '已刪除的組織', unknown: '未知帳號' },
};

function body(n: number) {
  return {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: `post-${n}` }, content: [{ type: 'text', text: `Contribution ${n}` }] }],
    },
  };
}

function post(n: number, authorId: string, ownerThreadId = threadId) {
  return {
    ...metadata,
    id: id(10 + n),
    threadId: ownerThreadId,
    boardId,
    authorId,
    parentId: null,
    revisionId: id(110 + n),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available',
    body: body(n),
  };
}

function thread(n: number, authorId: string, title: string) {
  return {
    ...metadata,
    id: id(n),
    boardId,
    authorId,
    licence: 'CC-BY-4.0',
    subjectIds: [],
    title,
    availability: 'available',
    firstPost: post(20 + n, authorId, id(n)),
  };
}

const posts = [
  post(1, authors.organization),
  post(2, authors.person),
  post(3, authors.missing),
  post(4, authors.active),
];
const threads = [
  thread(2, authors.organization, 'Organization thread'),
  thread(3, authors.person, 'Person thread'),
  thread(4, authors.missing, 'Missing thread'),
  thread(5, authors.active, 'Active thread'),
];
const problem = {
  type: 'https://rezics.com/problems/not_found',
  title: 'Not Found',
  status: 404,
  code: 'not_found',
  retryable: false,
  effect_status: 'not_applicable',
  request_id: randomUUID(),
};
const json = (value: unknown, status = 200) => Response.json(value, { status });

const fake = Bun.serve({
  port: 0,
  hostname: '127.0.0.1',
  fetch(request) {
    const url = new URL(request.url);
    if (url.pathname === '/auth/.well-known/openid-configuration')
      return json({
        issuer: `${url.origin}/auth`,
        authorization_endpoint: `${url.origin}/auth/authorize`,
        token_endpoint: `${url.origin}/auth/token`,
        jwks_uri: `${url.origin}/auth/jwks`,
        revocation_endpoint: `${url.origin}/auth/revoke`,
        end_session_endpoint: `${url.origin}/auth/end-session`,
        response_types_supported: ['code'],
        code_challenge_methods_supported: ['S256'],
        id_token_signing_alg_values_supported: ['ES256'],
        token_endpoint_auth_methods_supported: ['private_key_jwt'],
        token_endpoint_auth_signing_alg_values_supported: ['ES256'],
      });
    if (url.pathname === '/auth/jwks') return json({ keys: [issuerJwk] });
    if (request.method !== 'GET') return json(problem, 404);
    if (url.pathname === '/v1/accounts') {
      const ids = url.searchParams.get('ids')?.split(',').filter(Boolean) ?? [];
      return json({ accounts: ids.flatMap((accountId) => (accounts.has(accountId) ? [accounts.get(accountId)] : [])) });
    }
    if (url.pathname === `/v1/boards/${boardId}`)
      return json({ board: { ...metadata, id: boardId, title: 'Reading room', availability: 'available' } });
    if (url.pathname === `/v1/boards/${boardId}/threads`) return json({ threads, next: null });
    if (url.pathname === `/v1/threads/${threadId}`) return json({ thread: threads[0] });
    if (url.pathname === `/v1/threads/${threadId}/posts`) return json({ posts, next: null });
    return json(problem, 404);
  },
});

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
let started: Promise<string> | undefined;
function site(): Promise<string> {
  started ??= (async () => {
    const port = await freePort();
    let output = '';
    const keep = (chunk: Buffer) => (output = (output + chunk.toString()).slice(-8000));
    child = spawn('bun', ['run', 'dev', '--host', '127.0.0.1', '--port', String(port), '--strictPort'], {
      cwd: app,
      detached: true,
      stdio: ['ignore', 'pipe', 'pipe'],
      env: {
        ...process.env,
        KERNEL_ORIGIN: fake.url.origin,
        AUTH_ISSUER: `${fake.url.origin}/auth`,
        WEBSITE_CLIENT_ID: 'rezics-website',
        WEBSITE_CLIENT_KEY: JSON.stringify(clientJwk),
        API_RESOURCE: 'https://api.rezics.test',
        WEBSITE_SCOPES: 'media:create media:read',
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
        if (response.status < 500) return origin;
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

let browser: Browser | undefined;
async function open(path: string): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ javaScriptEnabled: false });
  const page = await context.newPage();
  await page.goto(`${await site()}${path}`, { waitUntil: 'load' });
  return page;
}

afterAll(async () => {
  await browser?.close();
  fake.stop(true);
  if (child?.pid)
    try {
      process.kill(-child.pid, 'SIGTERM');
    } catch {}
});

const stale = ['Stale', 'stale-', '@', 'example.com/stale'];

/** The label a byline shows, with nothing of a stale name, handle or link beside it. */
async function expectByline(row: ReturnType<Page['locator']>, label: string) {
  const text = await row.innerText();
  expect(text).toContain(label);
  for (const fragment of stale) expect(text).not.toContain(fragment);
  expect(await row.locator('a[href*="/@"], img').count()).toBe(0);
  expect(await row.locator('[data-slot="avatar-fallback"]').allInnerTexts()).toEqual(['?']);
}

test(
  'in every locale, a post and a board thread row by a deleted organization show the deleted-organization label, and by a deleted person the deleted-account label',
  async () => {
    for (const [locale, text] of Object.entries(labels)) {
      const thread = await open(`/${locale}/threads/${threadId}`);
      try {
        const slots = thread.locator('main ol > li');
        expect(await slots.count()).toBe(4);
        await expectByline(slots.nth(0), text.organization);
        expect(await slots.nth(0).innerText()).not.toContain(text.deleted);
        await expectByline(slots.nth(1), text.deleted);
        expect(await slots.nth(1).innerText()).not.toContain(text.organization);
      } finally {
        await thread.context().close();
      }
      const board = await open(`/${locale}/boards/${boardId}`);
      try {
        const rows = board.locator('main ul > li');
        expect(await rows.count()).toBe(4);
        await expectByline(rows.nth(0), text.organization);
        expect(await rows.nth(0).innerText()).not.toContain(text.deleted);
        await expectByline(rows.nth(1), text.deleted);
        expect(await rows.nth(1).innerText()).not.toContain(text.organization);
      } finally {
        await board.context().close();
      }
    }
  },
  timeout,
);

test(
  "a deleted author's byline shows no display name, handle, avatar initials or profile link, whatever the public identity still carries",
  async () => {
    const page = await open(`/en/threads/${threadId}`);
    try {
      const html = await page.locator('main ol > li').first().innerHTML();
      for (const fragment of ['Stale', 'stale-', 'example.com', 'href="/en/@']) expect(html).not.toContain(fragment);
      const person = await page.locator('main ol > li').nth(1).innerHTML();
      for (const fragment of ['Stale', 'stale-', 'href="/en/@']) expect(person).not.toContain(fragment);
      const active = page.locator('main ol > li').nth(3);
      expect(await active.innerText()).toContain('Carol');
      expect(await active.locator('a[href="/en/@carol"]').count()).toBeGreaterThan(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'an author missing from the identity read keeps the unknown-account label',
  async () => {
    for (const [locale, text] of Object.entries(labels)) {
      const page = await open(`/${locale}/threads/${threadId}`);
      try {
        const slot = page.locator('main ol > li').nth(2);
        expect(await slot.innerText()).toContain(text.unknown);
        expect(await slot.innerText()).not.toContain(text.deleted);
        expect(await slot.innerText()).not.toContain(text.organization);
      } finally {
        await page.context().close();
      }
    }
    const board = await open('/en/boards/' + boardId);
    try {
      expect(await board.locator('main ul > li').nth(2).innerText()).toContain('Unknown account');
    } finally {
      await board.context().close();
    }
  },
  timeout,
);

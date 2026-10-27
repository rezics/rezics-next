import { afterAll, expect, test } from 'bun:test';
import { spawn, type ChildProcess } from 'node:child_process';
import { randomUUID } from 'node:crypto';
import { createServer } from 'node:net';
import { join } from 'node:path';
import { exportJWK, generateKeyPair } from 'jose';
import { chromium, type Browser, type Page } from 'playwright';
import { threadHref } from '../src/threads/thread-href';

const app = join(import.meta.dir, '..');
const timeout = 300_000;
const clientKeys = await generateKeyPair('ES256', { extractable: true });
const clientJwk = { ...(await exportJWK(clientKeys.privateKey)), alg: 'ES256', kid: 'website-1' };
const issuerKeys = await generateKeyPair('ES256', { extractable: true });
const issuerJwk = { ...(await exportJWK(issuerKeys.publicKey)), alg: 'ES256', kid: 'issuer-1', use: 'sig' };
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;
const boardId = id(1);
const threadId = id(2);
const threadPath = (locale = 'en') => `/${locale}${threadHref({ id: threadId, title: 'A first discussion' })}`;
const coveredSubject = id(70);
const bareSubject = id(71);
const coverMedia = id(72);
const recent = new Date(Date.now() - 3 * 60 * 60 * 1000).toISOString();
const active = new Date(Date.now() - 2 * 60 * 60 * 1000).toISOString();
const old = '2025-01-02T03:04:05.000Z';
const metadata = { route: 0, visibility: 'published', securityRevision: '1', createdAt: recent } as const;
const authors = { mira: id(90), bob: id(91), deleted: id(92), unknown: id(93) } as const;
const accounts = new Map([
  [authors.mira, { id: authors.mira, handle: 'mira', displayName: 'Mira Okabe', state: 'active' }],
  [authors.bob, { id: authors.bob, handle: 'bob', displayName: null, state: 'active' }],
  [authors.deleted, { id: authors.deleted, handle: null, displayName: null, state: 'deleted' }],
] as const);

function body(n: number, heading = false) {
  return {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [
        ...(heading
          ? [
              {
                type: 'heading',
                attrs: { id: `heading-${n}`, level: 2 },
                content: [{ type: 'text', text: `Section ${n}` }],
              },
            ]
          : []),
        { type: 'paragraph', attrs: { id: `post-${n}` }, content: [{ type: 'text', text: `Contribution ${n}` }] },
      ],
    },
  };
}

function post(n: number, authorId: string, createdAt = recent, reactions: Record<string, number> = {}) {
  return {
    ...metadata,
    createdAt,
    id: id(10 + n),
    threadId,
    boardId,
    authorId,
    parentId: null,
    revisionId: id(110 + n),
    sha256: 'a'.repeat(64),
    licence: 'CC-BY-4.0',
    subjectIds: [],
    mediaIds: [],
    availability: 'available',
    body: body(n, n === 1),
    reactions,
  };
}

const posts = [
  post(1, authors.mira, recent, { like: 3 }),
  post(2, authors.bob, old, { love: 1 }),
  post(3, authors.deleted),
  post(4, authors.unknown),
];
const rows = [
  { id: threadId, title: 'A first discussion', authorId: authors.mira, replyCount: 3, lastActivityAt: active },
  { id: id(3), title: 'A second discussion', authorId: authors.bob, replyCount: 0, lastActivityAt: old },
  { id: id(4), title: 'An unknown starter', authorId: authors.unknown, replyCount: 12, lastActivityAt: recent },
];
const threads = rows.map((row, index) => ({
  ...metadata,
  ...row,
  boardId,
  licence: 'CC-BY-4.0',
  subjectIds: row.id === threadId ? [coveredSubject, bareSubject] : [],
  availability: 'available',
  reactions: row.id === threadId ? { like: 3 } : {},
  firstPost: index === 0 ? posts[0] : { ...post(20 + index, row.authorId), threadId: row.id },
}));
const subjects: Record<string, unknown> = {
  [coveredSubject]: subjectRead(coveredSubject, 'The Little Prince', {
    media: coverMedia,
    width: 600,
    height: 900,
    placeholder: { thumbhash: 'YJqGPQw7sFlslqhFafSE+Q6oJ1h2iHB2Rg==', color: '#6b4a33' },
    variants: [
      { format: 'avif', width: 320 },
      { format: 'webp', width: 320 },
      { format: 'webp', width: 640 },
    ],
    focalPoint: null,
    credit: {
      rightsHolder: 'Test Press',
      via: { name: 'Fixture', url: 'https://example.test' },
      license: 'CC0',
      obligations: [],
    },
  }),
  [bareSubject]: subjectRead(bareSubject, 'Night Flight', null),
};
function subjectRead(subjectId: string, title: string, cover: unknown) {
  return {
    subject: {
      id: subjectId,
      type: 'schema:Book',
      revision: 1,
      release: 'sha256:' + 'b'.repeat(64),
      context: id(80),
      resolution: {},
      labels: { en: title },
      descriptions: {},
      aliases: {},
      statements: {},
    },
    related: {},
    summary: {
      id: subjectId,
      type: 'schema:Book',
      types: ['schema:Book'],
      label: { value: title, language: 'en' },
      creativeWork: true,
      cover,
    },
  };
}
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
      return json({
        accounts: ids.flatMap((accountId) => {
          const account = accounts.get(accountId as never);
          return account ? [{ ...account, kind: 'actor', automated: false, operatorId: null }] : [];
        }),
      });
    }
    const subject = /^\/v1\/subjects\/([^/]+)$/.exec(url.pathname)?.[1];
    if (subject && subjects[subject]) return json(subjects[subject]);
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
        if (response.status < 500) {
          // The first visit to a route makes the dev server optimize its dependencies and reload; do that before any test.
          for (const path of [threadPath(), `/en/boards/${boardId}`])
            await fetch(`${origin}${path}`, { signal: AbortSignal.timeout(120_000) }).then((page) => page.text());
          return origin;
        }
      } catch {}
      if (Date.now() > deadline) throw new Error(`dev server did not serve /en in time:\n${output}`);
      await Bun.sleep(500);
    }
  })();
  return started;
}

let browser: Browser | undefined;
async function open(path: string, scripts = false): Promise<Page> {
  browser ??= await chromium.launch();
  const context = await browser.newContext({ javaScriptEnabled: scripts, viewport: { width: 1280, height: 900 } });
  const page = await context.newPage();
  await page.goto(`${await site()}${path}`, { waitUntil: scripts ? 'networkidle' : 'load' });
  if (scripts) await page.locator('html[data-hydrated]').waitFor({ state: 'attached', timeout: 120_000 });
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

test(
  "every post shows its author's avatar and display name, and a deleted account as Deleted account",
  async () => {
    for (const [locale, deleted] of [
      ['en', 'Deleted account'],
      ['ja', '削除されたアカウント'],
    ] as const) {
      const page = await open(threadPath(locale));
      try {
        const slots = page.locator('main ol > li');
        expect(await slots.count()).toBe(4);
        for (let index = 0; index < 4; index++)
          expect(await slots.nth(index).locator('[data-slot="avatar"]').count()).toBe(1);
        const person = slots.nth(0).getByRole('link', { name: 'Mira Okabe' });
        expect(await person.getAttribute('href')).toBe(`/${locale}/@mira`);
        expect(await slots.nth(0).locator('[data-slot="avatar-fallback"]').innerText()).toBe('MO');
        expect(await slots.nth(1).locator('[data-slot="avatar-fallback"]').innerText()).toBe('B');
        expect(await slots.nth(1).innerText()).toContain('@bob');
        expect(await slots.nth(2).innerText()).toContain(deleted);
        expect(await slots.nth(2).locator(`a[href^="/${locale}/@"]`).count()).toBe(0);
        expect(await slots.nth(2).innerText()).not.toContain('@');
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'thread titles and post bodies use the interface face; only Work titles use the serif face',
  async () => {
    const first = (stack: string | null) => (stack ?? '').split(',')[0]!.replaceAll(/["']/g, '').trim();
    const read = (page: Page) =>
      page.evaluate(() => {
        const stack = (selector: string) => {
          const element = document.querySelector(selector);
          return element ? getComputedStyle(element).fontFamily : null;
        };
        return {
          serif: getComputedStyle(document.documentElement).getPropertyValue('--font-work-serif'),
          interface: getComputedStyle(document.documentElement).getPropertyValue('--font-interface'),
          heading: stack('main h1'),
          paragraph: stack('main ol > li .rezics-document p'),
          documentHeading: stack('main ol > li .rezics-document h2'),
          listTitle: stack('main ul > li a'),
          coverTitle: stack('main [data-slot="cover"][data-state="placeholder"] [class*="font-work-title"]'),
        };
      });
    for (const locale of ['en', 'zh-Hans']) {
      const thread = await open(threadPath(locale), true);
      try {
        const faces = await read(thread);
        const serif = first(faces.serif);
        const text = first(faces.interface);
        expect(serif).not.toBe(text);
        expect(first(faces.heading)).toBe(text);
        expect(first(faces.paragraph)).toBe(text);
        expect(first(faces.documentHeading)).toBe(text);
        expect(first(faces.coverTitle)).toBe(serif);
      } finally {
        await thread.context().close();
      }
      const board = await open(`/${locale}/boards/${boardId}`, true);
      try {
        const faces = await read(board);
        expect(first(faces.heading)).toBe(first(faces.interface));
        expect(first(faces.listTitle)).toBe(first(faces.interface));
      } finally {
        await board.context().close();
      }
    }
  },
  timeout,
);

test(
  "each post's reactions sit at its top right and reporting lives in its overflow menu, with no visible report button",
  async () => {
    const page = await open(threadPath(), true);
    try {
      const slots = page.locator('main ol > li');
      for (let index = 0; index < 2; index++) {
        const slot = slots.nth(index);
        const frame = (await slot.boundingBox())!;
        const reactions = (await slot.locator('[data-slot="reactions"]').first().boundingBox())!;
        const menu = (await slot.getByRole('button', { name: 'More actions' }).boundingBox())!;
        const text = (await slot.locator('.rezics-document').boundingBox())!;
        expect(reactions.y + reactions.height).toBeLessThanOrEqual(text.y);
        expect(reactions.y - frame.y).toBeLessThan(80);
        expect(reactions.x).toBeGreaterThan(frame.x + frame.width / 2);
        expect(reactions.x + reactions.width).toBeLessThanOrEqual(menu.x + 1);
        expect(Math.abs(reactions.y + reactions.height / 2 - (menu.y + menu.height / 2))).toBeLessThan(24);
        expect(menu.x + menu.width).toBeGreaterThan(frame.x + frame.width - 24);
        expect(await slot.getByRole('button', { name: /report/i }).count()).toBe(0);
        expect(await slot.getByRole('link', { name: /report/i }).count()).toBe(0);
      }
      await slots.nth(1).getByRole('button', { name: 'More actions' }).click();
      await page.getByRole('menuitem', { name: 'Report', exact: true }).waitFor();
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'a subject attached to a thread shows its cover frame and title',
  async () => {
    const page = await open(threadPath());
    try {
      const covers = page.locator('main [data-slot="cover"]');
      expect(await covers.count()).toBe(2);
      expect(await covers.nth(0).getAttribute('data-ratio')).toBe(await covers.nth(1).getAttribute('data-ratio'));
      expect(await covers.nth(0).getAttribute('data-state')).not.toBe('placeholder');
      expect(await covers.nth(0).locator('img').getAttribute('src')).toMatch(
        new RegExp(`^/media/${coverMedia}/webp-\\d+$`),
      );
      expect(await covers.nth(0).locator('source[type="image/avif"]').getAttribute('srcset')).toContain(
        `/media/${coverMedia}/avif-320 320w`,
      );
      expect(await covers.nth(1).getAttribute('data-state')).toBe('placeholder');
      for (const [subject, title] of [
        [coveredSubject, 'The Little Prince'],
        [bareSubject, 'Night Flight'],
      ] as const) {
        const link = page.locator(`main a[href="/en/subjects/${subject}"]`).first();
        expect(await link.innerText()).toContain(title);
      }
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'board thread lists show author, reply count and last activity in compact rows',
  async () => {
    const page = await open(`/en/boards/${boardId}`);
    try {
      const items = page.locator('main ul > li');
      expect(await items.count()).toBe(3);
      for (let index = 0; index < 3; index++) {
        expect(await items.nth(index).locator('[data-slot="avatar"]').count()).toBe(1);
        expect((await items.nth(index).boundingBox())!.height).toBeLessThanOrEqual(96);
      }
      const first = items.nth(0);
      expect(await first.getByRole('link', { name: 'A first discussion' }).count()).toBe(1);
      expect(await first.innerText()).toContain('Mira Okabe');
      expect(await first.innerText()).toContain('Replies: 3');
      expect(await first.innerText()).toContain('Last activity 2 hours ago');
      expect(await first.locator(`time[datetime="${active}"]`).count()).toBe(1);
      expect(await items.nth(1).innerText()).toContain('Replies: 0');
      expect(await items.nth(1).innerText()).toContain('@bob');
      expect(await items.nth(2).innerText()).toContain('Replies: 12');
      expect(await items.nth(2).innerText()).toContain('Unknown account');
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

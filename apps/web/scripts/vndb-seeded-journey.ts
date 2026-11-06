/** Actual Subject → supplied Board → thread → author contribution walk, inside dev-stack.ts walk. */
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { resolve } from 'node:path';
import type { Browser, Page } from 'playwright';
import type { CrossMediaSeedResult } from '../../../services/importer/src/cross-media-seed.ts';
import type { DevelopmentShowcaseReport } from '../../../scripts/datasets/cross-media-seed.ts';
import { releaseWalkFileCache, walkIssuerForward } from '../../../scripts/walk-stack.ts';

const root = resolve(import.meta.dir, '../../..');
const evidence = resolve(root, '.temp/vndb-journey');
const globalContext = '00000000-0000-8000-8000-000000000000';
const locales = ['en', 'zh-Hant', 'zh-Hans', 'ja', 'ko', 'fr', 'de', 'es'] as const;
const stack = {
  web: requiredOrigin('REZICS_LOCAL_STACK_WEB_ORIGIN'),
  issuer: requiredOrigin('REZICS_LOCAL_STACK_ISSUER_ORIGIN'),
  native: requiredOrigin('REZICS_LOCAL_STACK_NATIVE_ORIGIN'),
  kernel: requiredOrigin('REZICS_LOCAL_STACK_KERNEL_ORIGIN'),
};
const bun = process.env.REZICS_WALK_SMOL === '1' ? [process.execPath, '--smol'] : ['bun'];
let chromium!: (typeof import('playwright'))['chromium'];
let expect!: (typeof import('playwright/test'))['expect'];
const report: {
  revision: string;
  browser: string;
  phases: string[];
  visits: { url: string; locale: string; width: number; theme: string }[];
  identities?: { subjectId: string; boardId: string; threadId: string; postId: string };
  profileReturn?: string;
  error?: string;
} = {
  revision: (await Bun.$`git rev-parse HEAD`.cwd(root).text()).trim(),
  browser: 'Browser plugin not available; Playwright on the supported attempt-owned walk stack',
  phases: [],
  visits: [],
};

function requiredOrigin(name: string): string {
  const value = process.env[name];
  assert(value, `${name} must be supplied by dev-stack.ts walk`);
  const url = new URL(value);
  assert.equal(url.protocol, 'http:');
  assert.equal(url.hostname, '127.0.0.1');
  return url.origin;
}

async function envFile(path: string): Promise<Record<string, string>> {
  return Object.fromEntries(
    (await readFile(path, 'utf8')).split('\n').flatMap((line) => {
      const match = /^([A-Z0-9_]+)=(.*)$/.exec(line);
      return match ? [[match[1]!, match[2]!.replace(/^'(.*)'$/, '$1')]] : [];
    }),
  );
}

async function run(command: string[], env = process.env): Promise<void> {
  const child = Bun.spawn(command, { cwd: root, env, stdin: 'ignore', stdout: 'inherit', stderr: 'inherit' });
  assert.equal(await child.exited, 0, `${command.join(' ')} failed`);
}

async function untilOrigin(origin: string, starting?: ReturnType<typeof Bun.spawn>): Promise<void> {
  const deadline = Date.now() + 600_000;
  while (true) {
    const ready = await fetch(`${origin}/`, { signal: AbortSignal.timeout(2_000) }).then(
      (response) => response.status < 500,
      () => false,
    );
    if (ready) return;
    if (starting && (starting.exitCode !== null || starting.signalCode !== null))
      throw new Error(`walk frontend exited (${starting.exitCode ?? starting.signalCode}) before it was ready`);
    if (Date.now() > deadline) throw new Error(`walk frontend ${origin} was not ready after ten minutes`);
    await Bun.sleep(500);
  }
}

/** Kernel fetches JWKS at the public issuer origin; native Auth already serves it. */
function issuerProxy(): ReturnType<typeof Bun.serve> {
  return Bun.serve({
    hostname: '127.0.0.1',
    port: Number(new URL(stack.issuer).port),
    fetch(request) {
      return fetch(walkIssuerForward(request, stack.native));
    },
  });
}

async function withFrontends<T>(run: () => Promise<T>): Promise<T> {
  const spawn = (action: 'pages' | 'web' | 'worker') =>
    Bun.spawn([...bun, 'services/auth/scripts/dev-stack.ts', action], {
      cwd: root,
      env: process.env,
      stdin: 'ignore',
      stdout: 'inherit',
      stderr: 'inherit',
    });
  const worker = spawn('worker');
  const pages = spawn('pages');
  try {
    await untilOrigin(stack.issuer, pages);
    const web = spawn('web');
    try {
      await untilOrigin(stack.web, web);
      if (worker.exitCode !== null || worker.signalCode !== null)
        throw new Error(`walk worker exited (${worker.exitCode ?? worker.signalCode}) before browsers ran`);
      return await run();
    } finally {
      web.kill('SIGTERM');
      await web.exited;
    }
  } finally {
    pages.kill('SIGTERM');
    worker.kill('SIGTERM');
    await pages.exited;
    await worker.exited;
  }
}

function data<T>(response: { data: T | null; error: unknown; status: number }, label: string): T {
  assert(!response.error && response.data !== null, `${label}: HTTP ${response.status}`);
  return response.data;
}

async function websiteBearer(password: string): Promise<string> {
  const binding = await envFile(resolve(root, 'apps/web/.dev.vars'));
  const signed = await fetch(`${stack.issuer}/signin`, {
    method: 'POST',
    headers: { origin: stack.issuer, 'content-type': 'application/json' },
    body: JSON.stringify({
      email: 'developer@rezics.test',
      password,
      client_id: binding.WEBSITE_CLIENT_ID,
      scope: binding.WEBSITE_SCOPES,
    }),
  });
  assert(signed.ok, `Native sign-in: HTTP ${signed.status}`);
  const token = await fetch(`${stack.issuer}/token`, {
    method: 'POST',
    headers: {
      origin: stack.issuer,
      'content-type': 'application/json',
      cookie: signed.headers
        .getSetCookie()
        .map((cookie) => cookie.split(';')[0])
        .join('; '),
    },
    body: '{}',
  });
  assert(token.ok, `Native token: HTTP ${token.status}`);
  const response = (await token.json()) as { access_token: string };
  assert.equal(typeof response.access_token, 'string');
  return response.access_token;
}

async function capture(page: Page, name: string): Promise<void> {
  assert((await page.title()).trim().length > 0, 'Page has no identity');
  await expect(page.locator('main')).toBeVisible();
  await expect(page.locator('vite-error-overlay')).toHaveCount(0);
  const image = resolve(evidence, `${name}.png`);
  const text = resolve(evidence, `${name}.txt`);
  await page.screenshot({ path: image, type: 'png', animations: 'disabled', scale: 'css' });
  await writeFile(text, await page.locator('main').innerText(), { mode: 0o600 });
}

const chromiumArgs = [
  '--disable-dev-shm-usage',
  '--mute-audio',
  '--no-first-run',
  '--disable-gpu',
  '--disable-software-rasterizer',
  '--renderer-process-limit=1',
  '--disable-site-isolation-trials',
  '--disable-extensions',
  '--disable-background-networking',
  '--disable-sync',
  '--disable-default-apps',
  '--disable-hang-monitor',
  '--disable-popup-blocking',
  '--disable-prompt-on-repost',
  '--metrics-recording-only',
  '--no-default-browser-check',
  '--disable-component-update',
  '--js-flags=--max-old-space-size=192',
];

async function launchBrowser(): Promise<Browser> {
  await mkdir('/tmp/rw', { recursive: true, mode: 0o700 });
  return chromium.launch({
    headless: true,
    env: { ...process.env, TMPDIR: '/tmp/rw' },
    args: chromiumArgs,
  });
}

async function withBrowser<T>(run: (browser: Browser) => Promise<T>): Promise<T> {
  const browser = await launchBrowser();
  try {
    return await run(browser);
  } finally {
    await browser.close();
  }
}

async function withPage<T>(
  browser: Browser,
  options: { width: number; theme: 'light' | 'dark'; blockMedia?: boolean },
  run: (page: Page) => Promise<T>,
): Promise<T> {
  const context = await browser.newContext({
    viewport: { width: options.width, height: options.width <= 390 ? 844 : 900 },
    deviceScaleFactor: 1,
    reducedMotion: 'reduce',
    colorScheme: options.theme,
  });
  try {
    const page = await context.newPage();
    page.setDefaultTimeout(60_000);
    page.setDefaultNavigationTimeout(90_000);
    if (options.blockMedia)
      await page.route(/\.(?:png|jpe?g|webp|gif|avif|svg|mp4|webm)(?:\?|$)/i, (route) => route.abort());
    return await run(page);
  } finally {
    await context.close();
  }
}

assert(
  process.env.GOAL_TASK_ID && /native|browser/.test(process.env.GOAL_ACCEPTANCE_REQUIRES ?? ''),
  'Run through the controller-owned dev-stack.ts walk',
);
await mkdir(evidence, { recursive: true });
try {
  await run([...bun, 'services/auth/scripts/dev-stack.ts', 'persona']);
  const jwks = await fetch(`${stack.native}/.well-known/jwks.json`, { signal: AbortSignal.timeout(5_000) });
  assert(jwks.ok, `Native Auth JWKS must answer before seed: HTTP ${jwks.status}`);
  const proxy = issuerProxy();
  try {
    await run([...bun, 'scripts/datasets/cross-media-seed.ts', '--dev'], {
      ...process.env,
      ...(await envFile(resolve(root, '.temp/local-stack/seed.env'))),
      AUTH_ORIGIN: stack.issuer,
      KERNEL_ORIGIN: stack.kernel,
    });
  } finally {
    await proxy.stop(true);
  }
  const seed = JSON.parse(
    await readFile(resolve(root, '.temp/cross-media-seed/result.json'), 'utf8'),
  ) as CrossMediaSeedResult & { developmentShowcase: DevelopmentShowcaseReport };
  assert.equal(seed.developmentShowcase.state, 'complete', 'Actual seed publication must complete');
  const community = seed.developmentShowcase.community;
  assert.equal(community.state, 'published');
  if (community.state !== 'published') throw new Error('Seed community was not published');
  const { subjectId } = community.source;
  const boardId = community.board.id;
  const selected = seed.readings.find((row) => row.selection === 'selected' && row.subject.subject.id === subjectId);
  assert(selected, 'Publication source must be one of the actual native readings');
  const workPath = `/en${selected.route}?${new URLSearchParams({ board: boardId })}`;
  const { createKernelClient } = await import('@rezics/client');
  const client = createKernelClient(stack.kernel);
  const anonymous = data(
    await client.subjects({ id: subjectId }).threads.get({
      query: { place: globalContext, kind: 'discussion', board: boardId, limit: 20 },
    }),
    'selected Subject entry',
  );
  assert.equal(anonymous.entry.state, 'current');
  if (anonymous.entry.state === 'current') {
    assert.equal(anonymous.entry.board.id, boardId);
    assert.equal(anonymous.entry.actions.createThread, 'sign-in');
  }
  const unselected = data(
    await client.subjects({ id: subjectId }).threads.get({
      query: { place: globalContext, kind: 'discussion', limit: 20 },
    }),
    'unselected Subject entry',
  );
  assert.equal(unselected.entry.state, 'not_selected');
  report.phases.push('actual-publication-and-native-entry');
  releaseWalkFileCache();

  await withFrontends(async () => {
  ({ chromium } = await import('playwright'));
  ({ expect } = await import('playwright/test'));
  await withBrowser(async (browser) => {
    for (const locale of locales) {
      for (const [width, theme] of [
        [390, 'light'],
        [1440, 'dark'],
      ] as const) {
        await withPage(browser, { width, theme, blockMedia: true }, async (page) => {
          const response = await page.goto(`${stack.web}${workPath.replace('/en/', `/${locale}/`)}`, {
            waitUntil: 'domcontentloaded',
          });
          assert.equal(response?.status(), 200);
          await expect(page.locator('[data-slot="community-entry"][data-state="sign-in"]').first()).toBeVisible();
          await capture(page, `anonymous-${locale}-${width}-${theme}`);
          report.visits.push({ url: page.url(), locale, width, theme });
        });
      }
    }
  });

  await withBrowser(async (browser) =>
    withPage(browser, { width: 1440, theme: 'light', blockMedia: true }, async (page) => {
      const errors: string[] = [];
      page.on('pageerror', (error) => {
        if (errors.length < 20) errors.push(error.message.slice(0, 1_000));
      });
      await page.goto(`${stack.web}${workPath}`, { waitUntil: 'domcontentloaded' });
      const signin = page.locator('[data-slot="community-entry"] a[href^="/auth/sign-in"]').first();
      const signinHref = await signin.getAttribute('href');
      assert(signinHref, 'Subject entry must sign in to the supplied composer');
      const compose = new URL(new URL(signinHref, stack.web).searchParams.get('return_to') ?? '', stack.web);
      assert.equal(compose.pathname, `/en/boards/${boardId}/new`);
      assert.equal(compose.searchParams.get('subject'), subjectId);
      const regionReturn = compose.searchParams.get('returnTo');
      assert(regionReturn?.includes(`board=${boardId}`) && regionReturn.includes('#'), 'Exact regional return required');
      const keys = JSON.parse(await readFile(resolve(root, '.temp/local-stack/keys.json'), 'utf8')) as {
        password: string;
      };
      await signin.click();
      await page.waitForURL('**/login?**');
      await page.locator('input[name="email"]').fill('developer@rezics.test');
      await page.locator('input[name="password"]').fill(keys.password);
      await page.locator('button[type="submit"]').click();
      const approve = page.getByRole('button', { name: 'Approve', exact: true });
      await approve.waitFor({ state: 'visible', timeout: 10_000 }).then(
        () => approve.click(),
        () => undefined,
      );
      await page.waitForURL((url) => url.origin === stack.web && url.pathname.endsWith(`/boards/${boardId}/new`));
      assert.equal(new URL(page.url()).searchParams.get('returnTo'), regionReturn);
      assert.equal(new URL(page.url()).searchParams.get('subject'), subjectId);
      const title = `A discussion from the supplied Subject ${Date.now()}`;
      await page.locator('#thread-title').fill(title);
      await page
        .getByRole('textbox', { name: 'Thread body', exact: true })
        .fill('An original contribution from this exact Subject region.');
      await page.getByRole('button', { name: 'Send', exact: true }).click();
      await page.waitForURL(/\/threads\/[0-9a-f-]{36}\//);
      const threadId = /\/threads\/([0-9a-f-]{36})\//.exec(page.url())![1]!;
      const bearer = await websiteBearer(keys.password);
      const headers = { authorization: `Bearer ${bearer}` };
      const created = data(await client.threads({ id: threadId }).get({ headers }), 'independent created thread');
      assert.equal(created.thread.boardId, boardId);
      assert.equal(created.thread.title, title);
      const postId = created.thread.firstPost.id;
      report.identities = { subjectId, boardId, threadId, postId };
      await expect(page.locator('[data-slot="thread-subject-return"]')).toHaveAttribute('href', regionReturn);
      await capture(page, 'acknowledged-thread');
      await page.locator('[data-slot="thread-subject-return"]').click();
      await expect(page).toHaveURL(`${stack.web}${regionReturn}`);
      await expect(page.getByRole('link', { name: title, exact: true }).first()).toBeVisible();
      report.phases.push('subject-sign-in-preset-acknowledgement-exact-region');

      await page.getByRole('link', { name: title, exact: true }).first().click();
      const authorLink = page.locator('main a[href*="/@"]').first();
      const authorHref = await authorLink.getAttribute('href');
      assert(authorHref, 'Thread must expose its actual public author');
      await authorLink.click();
      const discussionsLink = page.locator('a[href$="/discussions"]').first();
      if (await discussionsLink.isVisible()) await discussionsLink.click();
      else await page.goto(`${stack.web}${authorHref.replace(/\/$/, '')}/discussions`);
      const metadata = page.locator(`[data-profile-contribution-id="${threadId}"]`).first();
      await expect(metadata).toBeVisible();
      const row = metadata.locator('xpath=ancestor::li[1]');
      const occurrence = await metadata.getAttribute('data-profile-contribution-occurrence');
      assert(occurrence, 'The surviving profile row must have its exact occurrence');
      const profileReturn = new URL(page.url());
      profileReturn.searchParams.set('journey', 'participation');
      profileReturn.hash = `profile-contribution-${threadId}`;
      await page.goto(profileReturn.href);
      report.profileReturn = `${profileReturn.pathname}${profileReturn.search}${profileReturn.hash}`;
      await expect(row.getByRole('button', { name: 'Watch', exact: true })).toBeEnabled();
      await row.getByRole('button', { name: 'Watch', exact: true }).click();
      await expect(row.getByRole('button', { name: 'Stop watching', exact: true })).toBeVisible();
      assert.equal(
        data(await client.threads({ id: threadId }).watch.get({ headers }), 'independent watch').watching,
        true,
      );
      await row.getByRole('button', { name: 'React', exact: true }).click();
      await page.getByRole('button', { name: /^Like / }).click();
      await expect
        .poll(
          async () =>
            data(await client.threads({ id: threadId }).get({ headers }), 'independent reaction').thread.viewerReaction,
        )
        .toBe('like');
      await row.getByRole('button', { name: /Like/ }).first().click();
      await expect
        .poll(
          async () =>
            data(await client.threads({ id: threadId }).get({ headers }), 'independent clear').thread.viewerReaction,
        )
        .toBeNull();
      await row.getByRole('button', { name: 'More actions', exact: true }).click();
      await page.getByRole('menuitem', { name: 'Report', exact: true }).click();
      const dialog = page.getByRole('dialog');
      await dialog.getByRole('radio', { name: /^Spam/ }).click();
      await dialog.getByLabel('Additional details', { exact: true }).fill('Private participation journey report.');
      await dialog.getByRole('button', { name: 'Submit report', exact: true }).click();
      await expect(page.getByText('Thank you for your report.', { exact: true })).toBeVisible();
      const reports = data(
        await client.threads({ id: threadId }).reports.get({ headers }),
        'independent report inventory',
      );
      assert(reports.reports.some((entry) => entry.target.id === threadId && entry.reason === 'spam'));
      await page.keyboard.press('Escape');
      const replyText = `Reply from the original profile occurrence ${Date.now()}`;
      await row.getByRole('textbox', { name: 'Reply', exact: true }).fill(replyText);
      await row.getByRole('button', { name: 'Send', exact: true }).click();
      await expect
        .poll(async () => {
          const posts = data(await client.threads({ id: threadId }).posts.get({ headers }), 'independent reply');
          return posts.posts.some((post) => post.parentId === postId);
        })
        .toBe(true);
      await expect(page).toHaveURL(profileReturn.href);
      await capture(page, 'profile-actions-acknowledged');
      const readLink = row.locator('[data-slot="list-row-link"]');
      await readLink.click();
      await page.goBack();
      await expect(page).toHaveURL(profileReturn.href);
      await expect(page.locator(`[data-profile-contribution-id="${threadId}"]`).first()).toHaveAttribute(
        'data-profile-contribution-occurrence',
        occurrence,
      );
      await capture(page, 'exact-profile-occurrence-return');
      assert.deepEqual(errors, [], 'Browser runtime errors');
      report.phases.push('profile-watch-reaction-set-clear-report-reply-durable-readbacks-and-return');
    }),
  );
  });
} catch (error) {
  report.error = error instanceof Error ? error.message : String(error);
  throw error;
} finally {
  await writeFile(resolve(evidence, 'journey.json'), JSON.stringify(report, null, 2), { mode: 0o600 });
}

import { resourceHref } from '../features/address/path.ts';
import { localizedPath } from '../i18n/locale.ts';
import { spawnSync } from 'node:child_process';
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  type Browser,
  type BrowserContext,
  expect,
  type Page,
  test,
  type TestInfo,
} from '@playwright/test';

// M4 exit evidence in a real browser against the isolated QA stack (the API halves are the integration tests it
// names): a reader's recorded dates survive status changes from a card and from the Work page; an emptied chapter
// draft is saved, reopens empty on another device and cannot be published; a draft Work's cover is not shown to a
// signed-out context; and a Concept page matching any of two additions still requires its own Concept.
// Desktop and phone are two viewports of the same journeys; the book is written in Arabic, a content language the
// interface does not offer.

interface Work {
  work: string;
  mainVersion: string;
  title: string;
}
interface Seed {
  books: { work: string; title: string }[];
  concept: { fantasy: string; magic: string; romance: string; works: Work[] };
}
let seed: Seed;

const desktop = { width: 1280, height: 860 };
const phone = { width: 390, height: 844 };
const uuid = (iri: string) => iri.slice(-36);
const SESSION_TIMEOUT = 40_000;

// Playwright's actions wait as long as the test does unless bounded; a stuck step should fail in seconds, with its error.
test.use({ actionTimeout: 15_000 });
test.beforeAll(async () => {
  test.setTimeout(240_000);
  // Playwright runs this again in the fresh worker that follows a failed test; the records are written once per stack.
  const written = resolve('.temp', `g530-seed-${process.env.REZICS_QA_RUN_ID}.json`);
  if (existsSync(written)) {
    seed = JSON.parse(readFileSync(written, 'utf8')) as Seed;
    return;
  }
  const result = spawnSync('bun', ['apps/web/tests/g-530-seed.ts'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 200_000,
  });
  if (result.status !== 0 || result.error) {
    throw new Error(
      `G-530 seed failed: ${result.stderr || result.error?.message || result.status}`,
    );
  }
  seed = JSON.parse(result.stdout.trim().split('\n').at(-1)!) as Seed;
  mkdirSync(resolve('.temp'), { recursive: true });
  writeFileSync(written, JSON.stringify(seed));
  // Main keeps processing the seed's events for a while, moving the graph under every read (409).
  const main = `http://127.0.0.1:${process.env.MAIN_PORT}/v1/works/${uuid(seed.books[0]!.work)}`;
  let last = '';
  let still = 0;
  for (const deadline = Date.now() + 90_000; Date.now() < deadline && still < 4;) {
    const response = await fetch(main).catch(() => null);
    const position = response?.ok
      ? JSON.stringify(((await response.json()) as { sourcePosition: unknown }).sourcePosition)
      : '';
    still = position && position === last ? still + 1 : 0;
    last = position;
    await new Promise((done) => setTimeout(done, 500));
  }
  if (still < 4) throw new Error('Main’s graph kept moving for 90 seconds after the seed');
});

function fixture<T>(name: string): T {
  const path = process.env[name];
  if (!path) throw new Error(`${name} must point to the isolated QA web-auth fixture`);
  return JSON.parse(readFileSync(path, 'utf8')) as T;
}
const sessionAgent = () =>
  fixture<{ actingSubject: string }>('REZICS_WEB_AUTH_PUBLIC_PATH').actingSubject;
const member = () =>
  fixture<{ member: { email: string; password: string } }>('REZICS_WEB_AUTH_PRIVATE_PATH').member;

/**
 * The sign-in journey of `account-sign-in.ts`, bounded and retried. The Accounts origin is whatever the web app
 * redirects to, so it is not compared with the environment (the QA stack may give Accounts a free port).
 */
async function signIn(page: Page, next: string): Promise<void> {
  const target = next.split(/[?#]/)[0] ?? next;
  // A canonical Work address keeps the id and appends -{title}. That is the same destination.
  const arrived = (url: URL) => url.pathname === target || url.pathname.startsWith(`${target}-`);
  for (let attempt = 1; ; attempt++) {
    try {
      await page.goto(`/auth/start?next=${encodeURIComponent(next)}`);
      await page.waitForURL((url) => url.pathname === '/sign-in' || arrived(url), { timeout: 40_000 });
      if (arrived(new URL(page.url()))) return;
      await page.locator('html[data-hydrated]').waitFor({ timeout: 40_000 });
      await page.getByRole('textbox', { name: 'Email' }).fill(member().email);
      await page.getByRole('button', { name: 'Next' }).click();
      await page.getByLabel('Enter your password').fill(member().password);
      await page.getByRole('button', { name: 'Next' }).click();
      await expect.poll(() => arrived(new URL(page.url())), { timeout: 40_000 }).toBe(true);
      return;
    } catch (error) {
      if (attempt === 2) throw error;
    }
  }
}

/** Chapter text is a contenteditable. The words are its blocks; an empty chapter leaves them blank. */
function manuscript(box: ReturnType<Page['getByRole']>): Promise<string> {
  return box.evaluate(node => Array.from(node.children).map(child => child.textContent ?? '').join('\n'));
}

/** A device: its own browser context, signed in as the QA member, at the first page it is asked for. */
async function device(
  browser: Browser,
  info: TestInfo,
  viewport: { width: number; height: number },
  first: string,
): Promise<{ page: Page; context: BrowserContext }> {
  const context = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport,
    hasTouch: viewport.width < 600,
    isMobile: viewport.width < 600,
  });
  const page = await context.newPage();
  await signIn(page, first);
  return { page, context };
}

const overflows = (page: Page) =>
  page.evaluate(() => document.documentElement.scrollWidth > innerWidth);
async function shot(page: Page, info: TestInfo, name: string) {
  expect(await overflows(page), `${name} overflows`).toBe(false);
  await page.screenshot({ path: info.outputPath(`${name}.png`), fullPage: true });
}

/** Opens a menu and picks an item; a press before the page hydrates opens nothing, so it is pressed again. */
async function choose(page: Page, trigger: RegExp | string, item: string) {
  const entry = page.getByRole('menuitemradio', { name: item, exact: true });
  await expect(async () => {
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: trigger }).first().click();
    await expect(entry).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await entry.click();
}

/** The range text; a phone's list draws the row's text twice (list and card), so the first shows it. */
const recordedRange = (page: Page) => page.getByText('Read Jan 2 – 12, 2026').first();

interface Recorded {
  status: string | null;
  startedOn: string | null;
  finishedOn: string | null;
  version: number;
}
/** The reader's status as Main answers it, read through the BFF as the browser would; the button shows a choice at once, Main a moment later. */
async function recorded(page: Page, work: string, expected: Partial<Recorded>) {
  await expect
    .poll(
      async () => {
        const response = await page.request.get(
          `/api/main/v1/works/${uuid(work)}/reader-state` +
            `?actingSubject=${encodeURIComponent(sessionAgent())}`,
        );
        return response.ok()
          ? ((await response.json()) as { status: Recorded }).status
          : response.status();
      },
      { timeout: 15_000 },
    )
    .toMatchObject(expected);
}

for (const [name, viewport, index] of [
  ['desktop', desktop, 0],
  ['phone', phone, 1],
] as const) {
  test(`${name}: recorded reading dates survive a status change from a card and from the Work page`, async ({
    browser,
  }, info) => {
    test.setTimeout(150_000);
    const book = seed.books[index]!;
    const dates = { startedOn: '2026-01-02', finishedOn: '2026-01-12' };
    const { page, context } = await device(
      browser,
      info,
      viewport,
      localizedPath(resourceHref('/w/', uuid(book.work)), 'en'),
    );
    try {
      // Shelved as Read on its page, with dates recorded in Library.
      await expect(page.getByRole('heading', { level: 1, name: book.title })).toBeVisible();
      await choose(page, /More shelves/, 'Read');
      const shelved = page.getByRole('button', { name: /^Read — Shelve/ });
      // The label appears while the save is still in flight. Leave only after it has settled.
      await expect(shelved).toBeVisible();
      await expect(shelved).not.toHaveAttribute('aria-busy', 'true', { timeout: 30_000 });
      await recorded(page, book.work, { status: 'read' });
      // The status shelf is a separate read and can list the Work a moment after reader-state does.
      const row = page.getByRole('heading', { level: 3, name: book.title });
      await expect(async () => {
        await page.goto('/en/library?shelf=read');
        await expect(row).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      const form = page.getByRole('dialog', { name: `Reading dates for “${book.title}”` });
      // A press before the page hydrates opens nothing; press again until the form is there.
      await expect(async () => {
        await page.getByRole('button', { name: `Add dates — ${book.title}` }).click();
        await expect(form).toBeVisible({ timeout: 2_000 });
      }).toPass({ timeout: 30_000 });
      await form.getByLabel('Started').fill(dates.startedOn);
      await form.getByLabel('Finished').fill(dates.finishedOn);
      await form.getByRole('button', { name: 'Save' }).click();
      await expect(recordedRange(page)).toBeVisible();
      await recorded(page, book.work, { status: 'read', ...dates });
      await shot(page, info, `library-dates-${name}`);

      // A card's status menu: Read → Currently reading. The dates were never in the request, so Main keeps them.
      await choose(page, /^Read — Shelve/, 'Currently reading');
      await expect(page.getByRole('heading', { level: 3, name: book.title })).toHaveCount(0, {
        timeout: 15_000,
      });
      await recorded(page, book.work, { status: 'reading', ...dates });

      // The Work page's status button: Currently reading → Want to read → Read.
      await page.goto(localizedPath(resourceHref('/w/', uuid(book.work)), 'en'));
      await choose(page, /^Currently reading — Shelve/, 'Want to read');
      await expect(page.getByRole('button', { name: /^Want to read — Shelve/ })).toBeVisible();
      await recorded(page, book.work, { status: 'want-to-read', ...dates });
      await choose(page, /^Want to read — Shelve/, 'Read');
      await expect(page.getByRole('button', { name: /^Read — Shelve/ })).toBeVisible();
      await recorded(page, book.work, { status: 'read', ...dates });

      // Reloaded, Library still shows the dates the reader recorded.
      await page.goto('/en/library?shelf=read');
      await expect(recordedRange(page)).toBeVisible();
      await page.reload();
      await expect(recordedRange(page)).toBeVisible();
      await shot(page, info, `library-kept-${name}`);
    } finally {
      await context.close();
    }
  });
}

test('a Concept page that matches any of two additions still requires its own Concept', async ({
  browser,
}, info) => {
  test.setTimeout(90_000);
  const { fantasy, magic, romance, works } = seed.concept;
  const [fantasyMagic, fantasyRomance, magicOnly, fantasyOnly] = works as [Work, Work, Work, Work];
  for (const [name, viewport] of [
    ['desktop', desktop],
    ['phone', phone],
  ] as const) {
    // Public: no sign-in.
    const context = await browser.newContext({ baseURL: info.project.use.baseURL, viewport });
    const page = await context.newPage();
    try {
      const path = localizedPath(
        `${resourceHref('/concepts/', uuid(fantasy))}?include=${uuid(magic)},${uuid(romance)}&match=any`,
        'en',
      );
      const list = page.getByRole('region', { name: 'Works' });
      const work = (item: Work) => list.getByRole('link', { name: item.title });
      await expect(async () => {
        await page.goto(path);
        await expect(work(fantasyMagic)).toBeVisible({ timeout: 5_000 });
      }).toPass({ timeout: 60_000 });
      // Works carrying the page's Concept and either addition; never the ones that carry only an addition.
      await expect(work(fantasyRomance)).toBeVisible();
      await expect(work(fantasyOnly)).toHaveCount(0);
      await expect(work(magicOnly)).toHaveCount(0);
      await expect(
        page.getByRole('group', { name: 'Match' }).getByRole('link', { name: /^Any/ }),
      ).toHaveAttribute('aria-current', 'true');
      await shot(page, info, `concept-any-${name}`);

      // Match all asks for the page's Concept and both additions together: no Work has all three.
      await page.getByRole('group', { name: 'Match' }).getByRole('link', { name: /^All/ }).click();
      await expect(page.getByText('No works match these Conditions')).toBeVisible();
      await expect(work(fantasyMagic)).toHaveCount(0);
    } finally {
      await context.close();
    }
  }
});

test('phone: an emptied chapter draft is saved, reopens empty on another device and cannot be published; a draft cover stays private', async ({
  browser,
}, info) => {
  test.setTimeout(240_000);
  const errors: string[] = [];
  const { page, context } = await device(
    browser,
    info,
    phone,
    `/en/studio/@agent-${uuid(sessionAgent())}`,
  );
  page.on('pageerror', (error) => errors.push(error.message));
  const key = `g530-${Date.now()}`;
  let writer = '';
  await expect(async () => {
    const response = await page.request.post('/api/main/v1/agents', {
      headers: { 'idempotency-key': key },
      data: { profile: 'agent-provision-v1', kind: 'person', displayName: 'G530 Writer' },
    });
    expect([200, 201]).toContain(response.status());
    writer = ((await response.json()) as { agent: string }).agent;
  }).toPass({ timeout: SESSION_TIMEOUT });
  const studio = `/en/studio/@agent-${uuid(writer)}`;
  await expect(async () => {
    await page.goto(studio);
    await expect(page.getByRole('region', { name: 'Writing as' })).toContainText('G530 Writer', {
      timeout: 2_000,
    });
  }).toPass({ timeout: 60_000 });

  // A book in Arabic: a language Studio offers for writing that the interface does not.
  await page.goto(`${studio}/new`);
  const title = `كتاب المسودة ${Date.now() % 1000}`;
  await page.getByRole('textbox', { name: 'Title' }).fill(title);
  await page.getByRole('radio', { name: /^Book/ }).check();
  // The language list is portalled. On a phone it sometimes takes the focus and does not open.
  const writingLanguage = page.getByRole('combobox', { name: 'Language you’ll write in' });
  const arabic = page.getByRole('option', { name: 'Arabic', exact: true });
  await expect(async () => {
    await writingLanguage.click();
    await expect(arabic).toBeVisible({ timeout: 2_000 });
  }).toPass({ timeout: 30_000 });
  await arabic.click();
  await page.getByRole('button', { name: 'Create as G530 Writer' }).click();
  await page.waitForURL(/\/works\/[0-9a-f-]{36}\?tab=chapters$/);
  const work = /\/works\/([0-9a-f-]{36})/.exec(page.url())![1]!;
  const chapterTitle = 'الفصل الأول';
  await expect(async () => {
    await page.getByRole('textbox', { name: 'New chapter' }).fill(chapterTitle);
    await page.getByRole('button', { name: 'Add chapter' }).click();
    await expect(page.getByRole('link', { name: `Write “${chapterTitle}”` })).toBeVisible({
      timeout: 30_000,
    });
  }).toPass({ timeout: 90_000 });

  // Written, then emptied on purpose: the empty text is saved as the draft, not kept as the last text.
  await page.getByRole('link', { name: `Write “${chapterTitle}”` }).click();
  await page.waitForURL(/\/chapters\/[0-9a-f-]{36}/);
  const editor = page.getByRole('textbox', { name: 'Chapter text' });
  await expect(editor).toHaveAttribute('lang', 'ar');
  await expect(editor).toHaveAttribute('dir', 'rtl');
  await page.waitForLoadState('networkidle');
  const status = page.locator('[data-slot="autosave-status"] [role="status"]');
  const revision = () => new URL(page.url()).searchParams.get('revision');
  await editor.click();
  await page.keyboard.type('مطر في ليلة ماطرة.');
  await expect(status).toHaveText(/^Saved · /, { timeout: 30_000 });
  await expect.poll(revision).not.toBeNull();
  const written = revision();
  await editor.fill('');
  await expect.poll(revision, { timeout: 30_000 }).not.toBe(written);
  await expect(status).toHaveText(/^Saved · /, { timeout: 30_000 });
  await expect.poll(() => manuscript(editor)).toBe('');
  await expect(page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
  const emptied = revision()!;
  await shot(page, info, 'chapter-emptied-phone');
  const chapterPath = new URL(page.url()).pathname;

  // The exact empty revision is in Main, and a second device that never saw the text finds the chapter empty.
  const exact = await page.request.get(
    `/api/main/v1/content-revisions/${emptied}?actingSubject=${encodeURIComponent(writer)}`,
  );
  expect(exact.status()).toBe(200);
  expect(await exact.json()).toMatchObject({ body: { body: '' } });
  const other = await device(browser, info, desktop, studio);
  try {
    await other.page.goto(chapterPath);
    // Main's head for the chapter is the emptied revision; the address pins it.
    await expect(other.page).toHaveURL(new RegExp(`revision=${emptied}`));
    const reopened = other.page.getByRole('textbox', { name: 'Chapter text' });
    await expect(reopened).toBeVisible();
    await other.page.waitForLoadState('networkidle');
    await expect.poll(() => manuscript(reopened)).toBe('');
    await expect(other.page.getByRole('button', { name: 'Publish', exact: true })).toBeDisabled();
    await shot(other.page, info, 'chapter-reopened-desktop');
  } finally {
    await other.context.close();
  }

  // A cover on the still-private book: the writer sees it, nobody signed out does.
  await page.goto(`${studio}/works/${work}?tab=details`);
  const png = await page.evaluate(async () => {
    const canvas = document.createElement('canvas');
    canvas.width = 900;
    canvas.height = 600;
    const g = canvas.getContext('2d')!;
    g.fillStyle = '#1d3557';
    g.fillRect(0, 0, 900, 600);
    g.fillStyle = '#f1faee';
    g.beginPath();
    g.arc(600, 200, 90, 0, Math.PI * 2);
    g.fill();
    const blob = await new Promise<Blob>((resolve) =>
      canvas.toBlob((value) => resolve(value!), 'image/png'),
    );
    return [...new Uint8Array(await blob.arrayBuffer())];
  });
  await page
    .locator('input[type="file"]')
    .setInputFiles({ name: 'cover.png', mimeType: 'image/png', buffer: Buffer.from(png) });
  await expect(
    page.getByRole('dialog').getByRole('heading', { name: 'Frame the cover' }),
  ).toBeVisible();
  await page.getByRole('dialog').getByRole('button', { name: 'Use this cover' }).click();
  await expect(page.getByRole('status').filter({ hasText: 'Cover updated.' })).toBeVisible({
    timeout: 60_000,
  });
  // The upload is screened before it is shown: the summary names the image once Main's screening has cleared it.
  const ownPath = `/api/main/v1/resources/${work}?actingSubject=${encodeURIComponent(writer)}`;
  await expect
    .poll(
      async () => {
        const own = await page.request.get(ownPath);
        return own.ok() ? await own.json() : own.status();
      },
      { timeout: 90_000 },
    )
    .toMatchObject({ disclosure: 'restricted', avatar: { kind: 'image' } });
  const summary = (await (await page.request.get(ownPath)).json()) as { avatar: { url: string } };
  const ownBytes = await page.request.get(
    `/api/main${summary.avatar.url}?actingSubject=${encodeURIComponent(writer)}`,
  );
  expect(ownBytes.status()).toBe(200);
  expect(ownBytes.headers()['cache-control']).toContain('no-store');

  const anonymous = await browser.newContext({
    baseURL: info.project.use.baseURL,
    viewport: phone,
  });
  try {
    const refused = [
      await anonymous.request.get(`/api/main/v1/resources/${work}`),
      await anonymous.request.get(`/api/main${summary.avatar.url}`),
      await anonymous.request.get(`/api/main/v1/public-previews/${work}`),
    ];
    expect(refused.map((response) => response.status())).toEqual([404, 404, 404]);
    const bodies = await Promise.all(refused.map((response) => response.text()));
    for (const body of bodies) {
      expect(body).not.toContain(title);
      expect(body).not.toContain(summary.avatar.url);
    }
    // The page, streamed, settles on what it will show. The draft must match a Work
    // that never existed: the same status, the same not-found text, and noindex.
    const view = await anonymous.newPage();
    const settled = async (path: string) => {
      const response = await view.goto(path);
      let last = '',
        stable = 0;
      await expect
        .poll(
          async () => {
            const text = await view.locator('main').innerText();
            stable = text && text === last ? stable + 1 : 0;
            last = text;
            return stable;
          },
          { timeout: 30_000, intervals: [500] },
        )
        .toBeGreaterThanOrEqual(3);
      const robots = await view.locator('meta[name="robots"]').first().getAttribute('content');
      return { status: response?.status(), text: last, robots };
    };
    const draftPath = localizedPath(resourceHref('/w/', work), 'en');
    const missingPath = localizedPath(resourceHref('/w/', crypto.randomUUID()), 'en');
    let draftPage = await settled(draftPath);
    await shot(view, info, 'draft-work-signed-out-phone');
    let missingPage = await settled(missingPath);
    // A cold streamed response can commit 200 before a private Work's lookup finishes.
    // Reload both pages; they still have to share one status, one text and noindex.
    for (let attempt = 0; attempt < 2 && draftPage.status !== missingPage.status; attempt += 1) {
      draftPage = await settled(draftPath);
      missingPage = await settled(missingPath);
    }
    expect(draftPage).toEqual(missingPage);
    expect(draftPage.robots).toMatch(/noindex/);
    expect(draftPage.text).not.toContain(title);
    await expect(view.locator(`img[src*="${summary.avatar.url}"]`)).toHaveCount(0);
  } finally {
    await anonymous.close();
  }
  expect(errors).toEqual([]);
  await context.close();
});

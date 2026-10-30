import { browserSessionToken } from './session-token';
import { expect, test } from 'bun:test';
import type { Page, Request as BrowserRequest } from 'playwright';
import {
  createSubjectReactionPages,
  subjectPath,
  subjectId,
  session,
  type Call,
  type SubjectKind,
} from './support/reaction-pages';

const timeout = 300_000;
type Kind = SubjectKind;
let calls: Call[] = [];
let counts: Partial<Record<Kind, number>> = {};
let own: Kind | null = null;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
function reset(
  next: Partial<Record<Kind, number>> = { like: 6, love: 3, laugh: 2, insightful: 4, sad: 1 },
  selected: Kind | null = null,
) {
  calls = [];
  counts = next;
  own = selected;
}

const { open, signIn, accessTokens } = await createSubjectReactionPages({
  get calls() {
    return calls;
  },
  set calls(value) {
    calls = value;
  },
  get counts() {
    return counts;
  },
  set counts(value) {
    counts = value;
  },
  get own() {
    return own;
  },
  set own(value) {
    own = value;
  },
});
const cluster = (page: Page) => page.locator('main header').getByRole('group', { name: 'Reactions' });
const slotCalls = () => calls.filter((call) => call.method !== 'GET' && call.path.endsWith('/reaction'));
async function eventually(check: () => boolean | Promise<boolean>) {
  const deadline = Date.now() + 15_000;
  while (!(await check()) && Date.now() < deadline) await Bun.sleep(50);
  expect(await check()).toBe(true);
}
async function pressed(page: Page, name: string) {
  return cluster(page).getByRole('button', { name, exact: true }).getAttribute('aria-pressed', { timeout: 250 });
}
async function chipState(page: Page, name: string, value: string) {
  try {
    return (await pressed(page, name)) === value;
  } catch {
    return false;
  }
}

test(
  "the subject header's reaction cluster sits top right with like, love, laugh, insightful and sad and their counts, and no upvote or downvote",
  async () => {
    reset();
    for (const width of [1280, 390]) {
      const { page } = await open(subjectPath, { width });
      try {
        const group = cluster(page);
        // On a phone the row keeps the two most used kinds; the others wait in the picker.
        const row =
          width >= 640 ? ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'] : ['Like 6', 'Insightful 4'];
        for (const name of ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'])
          expect(await group.getByRole('button', { name, exact: true }).count()).toBe(row.includes(name) ? 1 : 0);
        expect(await group.getByRole('button', { name: /^(Upvote|Downvote)/ }).count()).toBe(0);
        await group.getByRole('button', { name: 'React', exact: true }).click();
        const choices = page.getByRole('dialog', { name: 'Choose a reaction' });
        const offered = await choices.getByRole('button').allInnerTexts();
        const names = offered.map((text) => text.replace(/\s+/g, ' ').trim());
        expect(names).toEqual(
          width >= 640
            ? ['Like', 'Love', 'Laugh', 'Insightful', 'Sad']
            : ['Like 6', 'Love 3', 'Laugh 2', 'Insightful 4', 'Sad 1'],
        );
        expect(await page.getByText(/Upvote|Downvote/).count()).toBe(0);
        await page.keyboard.press('Escape');

        const box = (await group.boundingBox())!;
        const title = (await page.locator('main h1').boundingBox())!;
        const header = (await page.locator('main header').boundingBox())!;
        if (width >= 1024) {
          // Top right of the header: beside the title block, in its right half and level with its first line.
          expect(box.x).toBeGreaterThan(header.x + header.width / 2);
          expect(box.x + box.width).toBeLessThanOrEqual(header.x + header.width + 1);
          expect(box.y).toBeLessThan(title.y + title.height);
        }
        // Nothing overflows sideways on a phone.
        expect(await page.evaluate(() => document.documentElement.scrollWidth <= window.innerWidth)).toBe(true);
      } finally {
        await page.context().close();
      }
    }
  },
  timeout,
);

test(
  'a signed-in reader sets one reaction, a new kind replaces the old, and removing it clears it',
  async () => {
    reset();
    own = 'insightful';
    const { page, access, origin } = await open(subjectPath);
    const browserPosts: BrowserRequest[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).origin === origin) browserPosts.push(request);
    });
    try {
      const group = cluster(page);
      expect(await pressed(page, 'Insightful 4')).toBe('true');
      expect(await pressed(page, 'Like 6')).toBe('false');

      await group.getByRole('button', { name: 'React', exact: true }).click();
      const choices = page.getByRole('dialog', { name: 'Choose a reaction' });
      await choices.getByRole('button', { name: 'Like', exact: true }).click();
      await eventually(() => slotCalls().length === 1);
      await eventually(() => chipState(page, 'Like 7', 'true'));
      expect(await chipState(page, 'Insightful 3', 'false')).toBe(true);

      await choices.getByRole('button', { name: 'Love', exact: true }).click();
      await eventually(() => slotCalls().length === 2);
      await eventually(() => chipState(page, 'Love 4', 'true'));
      expect(await chipState(page, 'Like 6', 'false')).toBe(true);

      await group.getByRole('button', { name: 'Love 4', exact: true }).click();
      await eventually(() => slotCalls().length === 3);
      await eventually(() => chipState(page, 'Love 3', 'false'));
      expect(await group.locator('[aria-pressed="true"]').count()).toBe(0);

      const path = `/v1/subjects/${subjectId}/reaction`;
      expect(slotCalls().map((call) => `${call.method} ${call.path}`)).toEqual([
        `PUT ${path}`,
        `PUT ${path}`,
        `DELETE ${path}`,
      ]);
      expect(slotCalls().map((call) => call.body)).toEqual([{ kind: 'like' }, { kind: 'love' }, null]);
      for (const call of slotCalls()) {
        expect(call.authorization).toBe(`Bearer ${access}`);
        expect(call.key).toMatch(uuid);
      }
      expect(new Set(slotCalls().map((call) => call.key)).size).toBe(3);
      expect(own).toBeNull();

      expect(browserPosts).toHaveLength(3);
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      for (const request of browserPosts) expect(request.headers()['x-csrf-token']).toBe(csrf!);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

test(
  'signed out, the counts show and reacting offers sign-in; without JavaScript the same public controls show',
  async () => {
    reset();
    const { page, origin } = await open(subjectPath, { signedIn: false });
    try {
      const group = cluster(page);
      expect(await group.getByRole('img', { name: 'Like 6', exact: true }).count()).toBe(1);
      expect(await group.getByRole('img').count()).toBe(5);
      expect(await group.getByRole('button').count()).toBe(0);
      const link = group.getByRole('link', { name: 'React', exact: true });
      const target = new URL((await link.getAttribute('href'))!, origin);
      expect(`${target.origin}${target.pathname}`).toBe(`${origin}/auth/sign-in`);
      expect(target.searchParams.get('return_to')).toBe(subjectPath);
      expect(calls.some((call) => call.path.endsWith('/reaction'))).toBe(false);
      expect(slotCalls()).toHaveLength(0);
    } finally {
      await page.context().close();
    }

    // Until the browser reads the session, even a signed-in reader sees the public controls.
    const bare = await open(subjectPath, { javaScript: false });
    try {
      const buttons = cluster(bare.page).getByRole('button');
      expect(await buttons.count()).toBe(0);
      expect(await cluster(bare.page).getByRole('link', { name: 'React', exact: true }).count()).toBe(1);
      expect(await cluster(bare.page).getByRole('img', { name: 'Like 6', exact: true }).count()).toBe(1);
    } finally {
      await bare.page.context().close();
    }
  },
  timeout,
);

test('signed-in and anonymous subject server renders match apart from the CSP nonce', async () => {
  reset();
  const auth = await signIn();
  const anonymous = await fetch(`${auth.origin}${subjectPath}`);
  const signedIn = await fetch(`${auth.origin}${subjectPath}`, { headers: { cookie: `${session}=${auth.session}` } });
  expect(anonymous.status).toBe(200);
  expect(signedIn.status).toBe(200);
  const normalize = (html: string) => html.replace(/nonce="[^"]*"/g, 'nonce="NONCE"');
  expect(normalize(await signedIn.text())).toBe(normalize(await anonymous.text()));
  expect(calls.filter((call) => call.path.endsWith('/reaction'))).toHaveLength(0);
});

test(
  "reporting the subject lives in the header's overflow menu",
  async () => {
    reset();
    const { page } = await open(subjectPath, { signedIn: false });
    try {
      // No visible report button; the menu sits beside the cluster in the header.
      expect(await page.getByRole('button', { name: 'Report', exact: true }).count()).toBe(0);
      const menu = page.locator('main header').getByRole('button', { name: 'More actions', exact: true });
      expect(await menu.count()).toBe(1);
      const group = (await cluster(page).boundingBox())!;
      const trigger = (await menu.boundingBox())!;
      expect(Math.abs(trigger.y + trigger.height / 2 - (group.y + group.height / 2))).toBeLessThan(group.height);

      await menu.click();
      await page.getByRole('menuitem', { name: 'Copy link', exact: true }).waitFor();
      await page.getByRole('menuitem', { name: 'Report', exact: true }).click();
      await page.getByRole('dialog', { name: 'Report this content', exact: true }).waitFor();
      await page.getByRole('radio', { name: 'Spam', exact: true }).check();
      await page.getByRole('button', { name: 'Verify test challenge', exact: true }).click();
      await page.getByRole('button', { name: 'Submit report', exact: true }).click();
      await page.getByRole('status', { name: 'Thank you for your report.', exact: true }).waitFor();
      const reports = calls.filter((call) => call.method === 'POST' && call.path === '/v1/reports');
      expect(reports).toHaveLength(1);
      expect(reports[0]!.body).toEqual({
        target: { kind: 'subject', id: subjectId },
        reason: 'spam',
        botToken: expect.stringMatching(/^token-/),
      });
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// The counts are one kernel read and the reader's own reaction one more, whatever the number of reactions.
test(
  'reading a subject costs one counts read, plus one own-reaction read when signed in, at 1, 10 and 100 reactions',
  async () => {
    const reads: Record<string, number[]> = { out: [], in: [] };
    for (const total of [1, 10, 100]) {
      reset({ like: total });
      const signedOut = await fetch(`${auth.origin}${subjectPath}`);
      expect(signedOut.status).toBe(200);
      expect(await signedOut.text()).toContain(`Like ${total}`);
      const outCounts = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reactions`);
      const outOwn = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reaction`);
      expect(outCounts).toHaveLength(1);
      expect(outOwn).toHaveLength(0);
      reads.out!.push(outCounts.length + outOwn.length);

      reset({ like: total });
      own = 'like';
      const { page } = await open(subjectPath);
      await page.locator('html[data-hydrated]').waitFor();
      await eventually(async () => (await pressed(page, `Like ${total}`)) === 'true');
      const inCounts = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reactions`);
      const inOwn = calls.filter((call) => call.path === `/v1/subjects/${subjectId}/reaction`);
      expect(inCounts).toHaveLength(1);
      expect(inOwn).toHaveLength(1);
      expect(inOwn[0]!.authorization).toMatch(/^Bearer /);
      expect(
        calls.filter(
          (call) =>
            call.authorization !== null && call.method === 'GET' && call.path !== `/v1/subjects/${subjectId}/reaction`,
        ),
      ).toHaveLength(0);
      expect(calls.filter((call) => call.path.includes('/reaction') && call.method !== 'GET')).toHaveLength(0);
      reads.in!.push(inCounts.length + inOwn.length);
      await page.context().close();
    }
    expect(new Set(reads.out).size).toBe(1);
    expect(new Set(reads.in).size).toBe(1);
  },
  timeout,
);

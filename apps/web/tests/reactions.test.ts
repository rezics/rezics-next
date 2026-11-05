import { browserSessionToken } from './session-token';
import { expect as bunExpect, test } from 'bun:test';
import type { Page, Request as BrowserRequest } from 'playwright';
import {
  createThreadReactionPages,
  threadPath,
  thread,
  post,
  snapshot,
  id,
  session,
  type Call,
  type Counts,
  type Posts,
} from './support/reaction-pages';

const timeout = 300_000;
// bun:test has no locator matchers. These two forward to the same checks the assertions name.
function expect(actual: unknown) {
  const base = bunExpect(actual) as unknown as Record<PropertyKey, unknown>;
  const locator = actual as {
    getAttribute?: (name: string, options?: { timeout?: number }) => Promise<string | null>;
    waitFor?: (options?: { state?: 'visible'; timeout?: number }) => Promise<void>;
  };
  return new Proxy(base, {
    get(target, property, receiver) {
      if (property === 'toHaveAttribute' && typeof locator?.getAttribute === 'function') {
        return async (name: string, value: string) => {
          const deadline = Date.now() + 15_000;
          let current: string | null = null;
          while (Date.now() < deadline) {
            try {
              current = await locator.getAttribute!(name, { timeout: 250 });
            } catch {
              current = null;
            }
            if (current === value) return;
            await Bun.sleep(50);
          }
          bunExpect(current).toBe(value);
        };
      }
      if (property === 'toBeVisible' && typeof locator?.waitFor === 'function') {
        return async () => {
          await locator.waitFor!({ state: 'visible', timeout: 15_000 });
        };
      }
      const value = Reflect.get(target, property, target);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  });
}
const calls: Call[] = [];
let refusal: { status: 403 | 422 | 429; code: string } | undefined;
let releaseRefusal: (() => void) | undefined;
let reactionGate: Promise<void> | undefined;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i;
let current = thread(2, 'A shared reading');
let posts: Posts = { posts: [post(12)], next: null };

function reset() {
  calls.length = 0;
  refusal = undefined;
  releaseRefusal = undefined;
  reactionGate = undefined;
  current = thread(2, 'A shared reading');
  current.thread.reactions = { upvote: 4 };
  current.thread.viewerReaction = null;
  posts = {
    posts: [
      { ...post(12), reactions: { sad: 8 }, viewerReaction: null },
      { ...post(13, snapshot('A different reading')), reactions: { like: 2 }, viewerReaction: 'like' },
    ],
    next: null,
  };
}
function holdRefusal() {
  refusal = { status: 403, code: 'forbidden' };
  let settled = false;
  reactionGate = new Promise<void>((resolve) => {
    releaseRefusal = () => {
      if (settled) return;
      settled = true;
      resolve();
    };
  });
  return reactionGate;
}

const { open, signIn, accessTokens } = await createThreadReactionPages({
  calls,
  get refusal() {
    return refusal;
  },
  set refusal(value) {
    refusal = value;
  },
  get releaseRefusal() {
    return releaseRefusal;
  },
  set releaseRefusal(value) {
    releaseRefusal = value;
  },
  get reactionGate() {
    return reactionGate;
  },
  set reactionGate(value) {
    reactionGate = value;
  },
  get current() {
    return current;
  },
  set current(value) {
    current = value;
  },
  get posts() {
    return posts;
  },
  set posts(value) {
    posts = value;
  },
});
const reactionsOf = (page: Page, index: number) =>
  page.locator('main ol > li').nth(index).getByRole('group', { name: 'Reactions' });
const reactionCalls = () => calls.filter((call) => call.path.endsWith('/reaction'));
async function eventually(check: () => boolean) {
  const deadline = Date.now() + 15_000;
  while (!check() && Date.now() < deadline) await Bun.sleep(50);
  expect(check()).toBe(true);
}
function expectReaction(
  call: Call | undefined,
  method: string,
  path: string,
  access: string | undefined,
  body: unknown,
) {
  expect(call?.method).toBe(method);
  expect(call?.path).toBe(path);
  expect(call?.authorization).toBe(`Bearer ${access}`);
  expect(call?.key).toMatch(uuid);
  expect(call?.body).toEqual(body);
}

// Show the thread reaction under the opening post and each reply's own reaction, then replace and clear both.
test(
  'a signed-in member reacts to a thread and a post, replacing and clearing the reaction',
  async () => {
    reset();
    const { page, access, origin } = await open(threadPath());
    const browserPosts: BrowserRequest[] = [];
    page.on('request', (request) => {
      if (request.method() === 'POST' && new URL(request.url()).origin === origin) browserPosts.push(request);
    });
    try {
      const threadReactions = reactionsOf(page, 0);
      const replyReactions = reactionsOf(page, 1);
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');
      expect(await threadReactions.getByRole('button', { name: /Sad/ }).count()).toBe(0);
      await expect(replyReactions.getByRole('button', { name: 'Like 2' })).toHaveAttribute('aria-pressed', 'true');

      await threadReactions.getByRole('button', { name: 'React', exact: true }).click();
      const choices = page.getByRole('dialog', { name: 'Choose a reaction' });
      await choices.getByRole('button', { name: /^Like(?:\s|$)/ }).click();
      await eventually(() => reactionCalls().length === 1);
      expectReaction(reactionCalls()[0], 'PUT', `/v1/threads/${id(2)}/reaction`, access, { kind: 'like' });
      await expect(threadReactions.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'true');

      await choices.getByRole('button', { name: /^Love(?:\s|$)/ }).click();
      await eventually(() => reactionCalls().length === 2);
      expectReaction(reactionCalls()[1], 'PUT', `/v1/threads/${id(2)}/reaction`, access, { kind: 'love' });
      expect(reactionCalls()[1]!.key).not.toBe(reactionCalls()[0]!.key);
      await expect(threadReactions.getByRole('button', { name: 'Love 1' })).toHaveAttribute('aria-pressed', 'true');
      expect(await threadReactions.getByRole('button', { name: 'Like 1' }).count()).toBe(0);

      await threadReactions.getByRole('button', { name: 'Love 1' }).click();
      await eventually(() => reactionCalls().length === 3);
      expectReaction(reactionCalls()[2], 'DELETE', `/v1/threads/${id(2)}/reaction`, access, null);
      expect(reactionCalls()[2]!.key).not.toBe(reactionCalls()[1]!.key);
      expect(await threadReactions.getByRole('button', { name: 'Love 1' }).count()).toBe(0);
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');

      await replyReactions.getByRole('button', { name: 'React', exact: true }).click();
      const replyChoices = page.getByRole('dialog', { name: 'Choose a reaction' });
      await replyChoices.getByRole('button', { name: /^Insightful(?:\s|$)/ }).click();
      await eventually(() => reactionCalls().length === 4);
      expectReaction(reactionCalls()[3], 'PUT', `/v1/posts/${id(13)}/reaction`, access, { kind: 'insightful' });
      await expect(replyReactions.getByRole('button', { name: 'Insightful 1' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );
      await expect(replyReactions.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'false');

      await replyReactions.getByRole('button', { name: 'Insightful 1' }).click();
      await eventually(() => reactionCalls().length === 5);
      expectReaction(reactionCalls()[4], 'DELETE', `/v1/posts/${id(13)}/reaction`, access, null);
      expect(new Set(reactionCalls().map((call) => call.key)).size).toBe(5);
      expect(await replyReactions.getByRole('button', { name: 'Insightful 1' }).count()).toBe(0);
      await expect(replyReactions.getByRole('button', { name: 'Like 1' })).toHaveAttribute('aria-pressed', 'false');

      expect(browserPosts).toHaveLength(5);
      const csrf = await browserSessionToken(page);
      expect(csrf).toBeTruthy();
      for (const request of browserPosts) {
        expect(request.headers()['x-csrf-token']).toBe(csrf!);
        expect(request.headers()['content-type']).toContain('application/json');
      }
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// Counts stay visible. React is a sign-in link back to this thread, and nothing is sent.
test(
  'a signed-out visitor sees counts and a sign-in link instead of reacting',
  async () => {
    reset();
    calls.length = 0;
    const { page, origin } = await open(threadPath(), false);
    try {
      const threadReactions = reactionsOf(page, 0);
      const replyReactions = reactionsOf(page, 1);
      await expect(threadReactions.getByRole('img', { name: 'Upvote 4' })).toBeVisible();
      await expect(replyReactions.getByRole('img', { name: 'Like 2' })).toBeVisible();
      expect(await threadReactions.getByRole('button').count()).toBe(0);
      expect(await replyReactions.getByRole('button').count()).toBe(0);
      const links = [threadReactions, replyReactions];
      for (const group of links) {
        const link = group.getByRole('link', { name: 'React', exact: true });
        const target = new URL((await link.getAttribute('href'))!, origin);
        expect(`${target.origin}${target.pathname}`).toBe(`${origin}/auth/sign-in`);
        expect(target.searchParams.get('return_to')).toBe(threadPath());
      }
      expect(reactionCalls()).toHaveLength(0);
    } finally {
      await page.context().close();
    }
  },
  timeout,
);

// A refused change returns to the previous counts and names the kernel's reason, including a closed platform.
test(
  'a refused reaction rolls back and says why',
  async () => {
    reset();
    current.thread.reactions = { like: 2, upvote: 4 };
    current.thread.viewerReaction = 'like';
    const held = holdRefusal();
    const { page } = await open(threadPath());
    try {
      const threadReactions = reactionsOf(page, 0);
      await threadReactions.getByRole('button', { name: 'React', exact: true }).click();
      await page
        .getByRole('dialog', { name: 'Choose a reaction' })
        .getByRole('button', { name: /^Love(?:\s|$)/ })
        .click();
      await expect(threadReactions.getByRole('button', { name: 'Love 1' })).toHaveAttribute('aria-pressed', 'true');
      refusal = { status: 403, code: 'forbidden' };
      releaseRefusal?.();
      await held;
      await expect(
        threadReactions.getByRole('status', { name: 'You do not have permission to change this reaction.' }),
      ).toBeVisible();
      await expect(threadReactions.getByRole('button', { name: 'Like 2' })).toHaveAttribute('aria-pressed', 'true');
      expect(await threadReactions.getByRole('button', { name: 'Love 1' }).count()).toBe(0);
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');

      refusal = { status: 403, code: 'platform_closed' };
      await page
        .getByRole('dialog', { name: 'Choose a reaction' })
        .getByRole('button', { name: /^Upvote(?:\s|$)/ })
        .click();
      await expect(threadReactions.getByRole('status', { name: 'This part of REZICS is not open yet.' })).toBeVisible();
      expect(
        await threadReactions
          .getByRole('status', { name: 'You do not have permission to change this reaction.' })
          .count(),
      ).toBe(0);
      await expect(threadReactions.getByRole('button', { name: 'Like 2' })).toHaveAttribute('aria-pressed', 'true');
      await expect(threadReactions.getByRole('button', { name: 'Upvote 4' })).toHaveAttribute('aria-pressed', 'false');
      expect(reactionCalls().map((call) => call.path)).toEqual([
        `/v1/threads/${id(2)}/reaction`,
        `/v1/threads/${id(2)}/reaction`,
      ]);
    } finally {
      releaseRefusal?.();
      await page.context().close();
    }
  },
  timeout,
);

// Counts and the viewer's kind ride the thread read and the one post page. A long page adds no reaction read.
test(
  'a thread page reads reactions with its thread and post reads',
  async () => {
    reset();
    current.thread.reactions = { upvote: 9 };
    current.thread.viewerReaction = 'upvote';
    posts = {
      posts: [
        { ...post(12), reactions: { sad: 8 }, viewerReaction: null },
        ...Array.from({ length: 99 }, (_, index) => ({
          ...post(13 + index, snapshot(`Reply ${index}`)),
          reactions: { like: 3 } satisfies Counts,
          viewerReaction: null,
        })),
      ],
      next: null,
    };
    const auth = await signIn(threadPath());
    expect([302, 303]).toContain(auth.answer.status);
    calls.length = 0;
    const response = await fetch(`${auth.origin}${threadPath()}`, {
      headers: { cookie: `${session}=${auth.session}` },
    });
    expect(response.status).toBe(200);
    const html = await response.text();
    expect(calls.map((call) => `${call.method} ${call.path}`).sort()).toEqual(
      [`GET /v1/threads/${id(2)}`, `GET /v1/threads/${id(2)}/posts`, 'GET /v1/accounts'].sort(),
    );
    expect(
      calls
        .filter((call) => call.path !== '/v1/accounts')
        .every((call) => call.authorization === `Bearer ${accessTokens.at(-1)}`),
    ).toBe(true);
    expect(calls.find((call) => call.path === '/v1/accounts')?.authorization).toBeNull();
    expect(calls.some((call) => call.path.endsWith('/reaction'))).toBe(false);
    expect(html.match(/data-slot="reactions"/g)?.length).toBe(100);
    expect(html).toContain('Upvote');
    expect(html).toContain('aria-pressed="true"');
  },
  timeout,
);

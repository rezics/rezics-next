import { expect, test } from 'bun:test';
import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { KernelClient } from '@rezics/client';
import { loadMyRealms } from '../src/community/space';
import { ExistingReviewNotice, SignInPrompt } from '../src/threads/write-prompts';
import { loadRealmReviewBoards } from '../src/threads/review-board-choices';
import { canSubmitThread, reviewThreadHref, selectedReviewSubject } from '../src/threads/review-policy';
import { loadCurrentReviewVote, selectedVoteCitation, STANDARD_QUESTION_ID } from '../src/threads/review-vote';
import { startThreadRequest } from '../src/threads/post-writes';
import { ViewHeadingActions } from '../src/features/pages/view-heading';

const app = join(import.meta.dir, '..');
const id = (n: number) => `0192f3a0-6c1e-7b2a-9d4e-${String(n).padStart(12, '0')}`;

function snapshot(text: string) {
  return {
    version: 'rezics-document-v1',
    profile: 'blocks',
    doc: {
      type: 'doc',
      content: [{ type: 'paragraph', attrs: { id: 'paragraph' }, content: [{ type: 'text', text }] }],
    },
  } as const;
}

test('review writes include one subject and an exact vote citation while discussions keep their old payload', async () => {
  const sent: unknown[] = [];
  const fakeClient = {
    threads: Object.assign(() => ({}), {
      post: async (body: unknown) => {
        sent.push(body);
        return { data: { thread: { id: id(4) } } };
      },
    }),
  } as unknown as KernelClient;
  const request = new Request('https://rezics.test/', { headers: { authorization: 'Bearer viewer' } });
  const body = snapshot('A careful review');
  const refusal = () => ({ ok: false as const, reason: 'unavailable' as const });
  const common = {
    boardId: id(1),
    title: 'Review title',
    body,
    idempotencyKey: id(2),
  };

  await startThreadRequest(
    {
      ...common,
      kind: 'review',
      subjectId: id(3),
      voteCitation: { questionId: id(5), units: 14, revision: 8 },
    } as never,
    request,
    {},
    fakeClient,
    refusal,
  );
  await startThreadRequest(common, request, {}, fakeClient, refusal);

  expect(sent[0]).toMatchObject({
    kind: 'review',
    subjectIds: [id(3)],
    voteCitation: { questionId: id(5), units: 14, revision: 8 },
  });
  expect(sent[1]).toMatchObject({ subjectIds: [], visibility: 'published' });
  expect(sent[1]).not.toHaveProperty('kind');
  expect(sent[1]).not.toHaveProperty('voteCitation');
});

test('a reviews board requires one picked or preset subject and publishes a review thread', () => {
  const choices = [{ id: id(3) }, { id: id(4) }];

  expect(canSubmitThread('reviews', null)).toBe(false);
  expect(canSubmitThread('reviews', id(3))).toBe(true);
  expect(canSubmitThread('discussion', null)).toBe(true);
  expect(selectedReviewSubject(choices)).toBe(id(3));
  expect(selectedReviewSubject([])).toBeNull();
});

test("a review can cite the author's current vote and sends its question, units and revision", () => {
  const vote = { questionId: STANDARD_QUESTION_ID, units: 14, revision: 8 };

  expect(selectedVoteCitation(vote, true)).toEqual(vote);
  expect(selectedVoteCitation(vote, false)).toBeUndefined();
  expect(selectedVoteCitation(null, true)).toBeUndefined();
});

test('a duplicate live review links to the existing review', () => {
  const markup = renderToStaticMarkup(createElement(ExistingReviewNotice, { reviewId: id(9) }));

  expect(markup).toContain(`href="/en/threads/${id(9)}"`);
  expect(markup).toContain('You already have a live review for this subject on this board.');
  expect(markup).toContain('Open your existing review');
});

test('a review conflict uses the optional native id without reading the subject index', async () => {
  const existingReviewId = id(9);
  const calls: string[] = [];
  let problem: { code: string; existingThreadId?: string } = { code: 'conflict', existingThreadId: existingReviewId };
  const fakeClient = {
    threads: Object.assign(() => ({}), {
      post: async () => {
        calls.push('POST /v1/threads');
        return { status: 409, headers: new Headers(), error: { value: problem } };
      },
    }),
    boards: () => {
      calls.push('unexpected board lookup');
      throw new Error('Review conflicts must not look up a board');
    },
    subjects: () => {
      calls.push('unexpected subject index lookup');
      throw new Error('Review conflicts must not scan a subject index');
    },
  } as unknown as KernelClient;
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({ credential: async () => ({ status: 'active', accessToken: 'token', subject: 'reader' }) }),
    },
  } as never;
  const request = new Request('https://rezics.test/', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  const body = snapshot('A second review');
  const result = await startThreadRequest(
    { boardId: id(1), title: 'Review title', body, idempotencyKey: id(2), kind: 'review', subjectId: id(3) },
    request,
    sessionEnv,
    fakeClient,
    () => ({ ok: false, reason: 'conflict' }),
  );

  expect(result).toMatchObject({ ok: false, reason: 'conflict', existingReviewId });
  problem = { code: 'conflict' };
  const noExtension = await startThreadRequest(
    { boardId: id(1), title: 'Review title', body, idempotencyKey: id(4), kind: 'review', subjectId: id(3) },
    request,
    sessionEnv,
    fakeClient,
    () => ({ ok: false, reason: 'conflict' }),
  );
  expect(noExtension).toEqual({ ok: false, reason: 'conflict' });
  expect(calls).toEqual(['POST /v1/threads', 'POST /v1/threads']);
});

test('members can choose a review board while visitors get a return-to sign-in link', async () => {
  const realmId = id(6);
  const pageCursor = 'next review boards';
  const requests: { realmId: string; query?: Record<string, string | number>; authorization?: string }[] = [];
  const pages = [
    {
      items: [
        {
          id: id(7),
          realmId,
          title: 'Member reviews',
          purpose: 'reviews',
          availability: 'available',
          visibility: 'protected',
        },
        {
          id: id(8),
          realmId,
          title: 'Discussion room',
          purpose: 'discussion',
          availability: 'available',
          visibility: 'published',
        },
      ],
      next: pageCursor,
    },
    {
      items: [
        {
          id: id(9),
          realmId,
          title: 'Unavailable reviews',
          purpose: 'reviews',
          availability: 'unavailable',
          visibility: 'published',
        },
      ],
      next: null,
    },
  ];
  let page = 0;
  const client = {
    realms: ({ realmId: requestedRealm }: { realmId: string }) => ({
      boards: {
        get: async (options?: { query?: Record<string, string | number>; headers?: { authorization?: string } }) => {
          requests.push({
            realmId: requestedRealm,
            ...(options?.query ? { query: options.query } : {}),
            ...(options?.headers?.authorization ? { authorization: options.headers.authorization } : {}),
          });
          return { data: pages[page++] };
        },
      },
    }),
  } as unknown as KernelClient;
  const choices = await loadRealmReviewBoards(client, [{ realmId, name: 'Reading realm' }], 'Bearer member');
  const returnTo = `/en/subjects/${id(3)}/reviews?view=reviews`;
  const signIn = renderToStaticMarkup(
    createElement(SignInPrompt, { returnTo, label: 'Sign in to write a review', compact: true }),
  );

  expect(choices).toEqual([{ id: id(7), title: 'Member reviews', realmId, realmName: 'Reading realm' }]);
  expect(requests).toEqual([
    { realmId, query: { limit: 100 }, authorization: 'Bearer member' },
    { realmId, query: { limit: 100, cursor: pageCursor }, authorization: 'Bearer member' },
  ]);
  expect(reviewThreadHref('en', id(7), id(3), 'A & B')).toBe(
    `/en/boards/${id(7)}/new?subject=${id(3)}&subjectTitle=A%20%26%20B`,
  );
  expect(signIn).toContain(`href="/auth/sign-in?return_to=${encodeURIComponent(returnTo)}"`);
  expect(signIn).toContain('Sign in to write a review');
});

test('the subject Reviews view renders its write action beside the view heading', () => {
  const markup = renderToStaticMarkup(
    createElement(ViewHeadingActions, {
      label: 'Reviews',
      actions: createElement('button', { type: 'button' }, 'Write a review'),
    }),
  );
  const heading = markup.indexOf('Reviews');
  const action = markup.indexOf('Write a review');
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(action).toBeGreaterThan(heading);
});

test('review writing adds one current vote read and one paged My Realms read', async () => {
  const calls: string[] = [];
  const subjectId = id(3);
  const client = {
    subjects: ({ id: requestedSubject }: { id: string }) => ({
      ratings: ({ questionId }: { questionId: string }) => ({
        vote: {
          get: async (options?: { headers?: { authorization?: string } }) => {
            calls.push(
              `GET /v1/subjects/${requestedSubject}/ratings/${questionId}/vote ${options?.headers?.authorization}`,
            );
            return { data: { units: 14, revision: 8 } };
          },
        },
      }),
    }),
    me: {
      realms: {
        get: async (options?: { query?: { cursor?: string } }) => {
          calls.push(`GET /v1/me/realms${options?.query?.cursor ? `?cursor=${options.query.cursor}` : ''}`);
          return { status: 200, data: { items: [{ realmId: id(6), name: 'Reading realm' }], next: null } };
        },
      },
    },
  } as unknown as KernelClient;
  const vote = await loadCurrentReviewVote(client, subjectId, 'Bearer reader');
  const request = new Request(`https://rezics.test/en/subjects/${subjectId}/reviews`, {
    headers: { authorization: 'Bearer reader' },
  });
  const realms = await loadMyRealms(client, request, {}, {});

  expect(vote).toEqual({ questionId: STANDARD_QUESTION_ID, units: 14, revision: 8 });
  expect(realms).toEqual({
    signedIn: true,
    realms: [{ realmId: id(6), name: 'Reading realm', description: null }],
    next: null,
  });
  expect(calls).toEqual([
    `GET /v1/subjects/${subjectId}/ratings/${STANDARD_QUESTION_ID}/vote Bearer reader`,
    'GET /v1/me/realms',
  ]);
});

test('review interface copy is present in all eight locales', () => {
  const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
  const files = new Set(readdirSync(join(app, 'messages')));
  for (const locale of locales) {
    expect(files.has(`${locale}.json`)).toBe(true);
    const messages = JSON.parse(readFileSync(join(app, 'messages', `${locale}.json`), 'utf8')) as Record<
      string,
      string
    >;
    expect(messages.thread_review_subject, locale).toBeTruthy();
    expect(messages.thread_review_cite_vote, locale).toBeTruthy();
    expect(messages.thread_review_write, locale).toBeTruthy();
    expect(messages.thread_review_duplicate, locale).toBeTruthy();
  }
});

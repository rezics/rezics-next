import { expect, test } from 'bun:test';
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient, type KernelClient } from '@rezics/client';
import { loadMyRealms } from '../src/community/space';
import { subjectPageMessages } from '../src/features/pages/route-support';
import { SubjectViewPage } from '../src/features/pages/subject-frame';
import { createFakeKernelFetch } from '../src/kernel/fake';
import fixtures from '../src/kernel/fixtures.json';
import boardRecording from '../src/kernel/recorded/board.json';
import realmBoardsRecording from '../src/kernel/recorded/realm-boards.json';
import subjectPageRecording from '../src/kernel/recorded/subject-page.json';
import { startThreadRequest } from '../src/threads/post-writes';

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

function source(path: string): string {
  const fullPath = join(app, path);
  return existsSync(fullPath) ? readFileSync(fullPath, 'utf8') : '';
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
  const route = source('src/routes/boards/$id_.new.tsx');
  const fields = source('src/threads/review-fields.tsx');
  const actions = source('src/threads/actions.ts');
  const writes = source('src/threads/post-writes.ts');

  expect(route).toMatch(/board\.purpose\s*===\s*['"]reviews['"]/);
  expect(route).toMatch(/\{review\s*\?\s*\(/);
  expect(route).toContain('<ReviewFields');
  expect(route).toContain('canSubmit={!review || Boolean(subjectId)}');
  expect(route).toMatch(/subject\??:/);
  expect(fields).toContain('EntityPicker');
  expect(fields).toMatch(/value=\{[^}]*subject/);
  expect(fields).not.toMatch(/multiple\s*=\s*\{?true/);
  expect(actions).toContain('subjectId');
  expect(writes).toMatch(/kind:\s*['"]review['"]/);
  expect(writes).toMatch(/subjectIds:\s*\[input\.subjectId\]/);
});

test("a review can cite the author's current vote and sends its question, units and revision", () => {
  const route = source('src/routes/boards/$id_.new.tsx');
  const fields = source('src/threads/review-fields.tsx');
  const writes = source('src/threads/post-writes.ts');

  expect(fields).toContain('readCurrentReviewVote');
  expect(fields).toContain('useEffect');
  expect(route).toContain('onVoteCitationChange={setVoteCitation}');
  expect(fields).toMatch(/vote\s*\?\s*\(/);
  expect(fields).toMatch(/questionId:\s*vote\.questionId/);
  expect(fields).toMatch(/units:\s*vote\.units/);
  expect(fields).toMatch(/revision:\s*vote\.revision/);
  expect(writes).toContain('voteCitation');
  expect(writes).toContain('input.voteCitation');
});

test('a duplicate live review links to the existing review', () => {
  const writes = source('src/threads/post-writes.ts');
  const actions = source('src/threads/actions.ts');
  const composer = source('src/threads/composer.tsx');

  expect(writes).toContain('findExistingReview');
  expect(actions).toContain('existingReviewId');
  expect(composer).toContain('href={`/${locale}/threads/${failure.existingReviewId}`}');
  expect(composer).toContain('thread_review_duplicate');
});

test('a second live review returns the matching review id from the subject index', async () => {
  const existingReviewId = id(9);
  const calls: string[] = [];
  const fakeClient = {
    threads: Object.assign(() => ({}), {
      post: async () => ({ status: 409, headers: new Headers(), error: { value: { code: 'review_exists' } } }),
    }),
    boards: (input: { id: string }) => ({
      get: async () => {
        calls.push(`board:${input.id}`);
        return { data: { board: { realmId: id(8) } } };
      },
    }),
    subjects: (input: { id: string }) => ({
      threads: {
        get: async (request: { query: { place: string; kind: string } }) => {
          calls.push(`subject:${input.id}:${request.query.place}:${request.query.kind}`);
          return {
            data: {
              threads: [
                {
                  id: existingReviewId,
                  authorId: 'reader',
                  boardId: id(1),
                  kind: 'review',
                  subjectIds: [id(3)],
                },
              ],
              next: null,
            },
          };
        },
      },
    }),
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
  expect(calls).toEqual([`board:${id(1)}`, `subject:${id(3)}:${id(8)}:review`]);
});

test('the subject Reviews view offers board selection to members and a sign-in prompt to visitors', () => {
  const action = source('src/subject/write-review.tsx');
  const route = source('src/routes/subjects/$id_.$view.tsx');

  expect(route).toContain('WriteReviewAction');
  expect(route).toMatch(/view\s*===\s*['"]reviews['"]/);
  expect(action).toContain('readMyRealmsPage');
  expect(action).toContain('useEffect');
  expect(action).toContain('readRealmReviewBoards');
  expect(action).toContain('SignInPrompt');
  expect(action).toContain('thread_review_write');
  expect(action).toMatch(/\?subject=/);
  expect(action).toContain('thread_review_no_realms');
  expect(action).toContain('thread_review_no_board');
});

test('the subject Reviews view renders its write action beside the view heading', () => {
  const markup = renderToStaticMarkup(
    createElement(SubjectViewPage, {
      page: {
        subject: id(3),
        profile: 'test',
        template: { scope: 'generic', key: 'generic' },
        document: { root: { props: {} }, content: [] },
        reads: {},
      },
      locale: 'en',
      messages: subjectPageMessages(),
      frame: createElement('div', null, 'Kokoro'),
      label: 'Reviews',
      actions: createElement('button', { type: 'button' }, 'Write a review'),
      view: 'reviews',
      renderJsonLd: false,
    }),
  );
  const heading = markup.indexOf('Reviews');
  const action = markup.indexOf('Write a review');
  expect(heading).toBeGreaterThanOrEqual(0);
  expect(action).toBeGreaterThan(heading);
});

test('review writing uses one current vote and bounded Realm and board pages', () => {
  const fields = source('src/threads/review-fields.tsx');
  const action = source('src/subject/write-review.tsx');

  expect(fields).toContain('STANDARD_QUESTION_ID');
  expect(fields.match(/\.vote\.get\s*\(/g)).toHaveLength(1);
  expect(action).toContain('readMyRealmsPage');
  expect(action.match(/readMyRealmsPage\(\{ data: \{\} \}\)/g)).toHaveLength(1);
  expect(action).toMatch(/expanded\s*&&\s*realmState\s*===\s*['"]ready['"]/);
  expect(action).toContain('REALM_PAGE_LIMIT = 20');
  expect(action).toContain('limit: 100');
});

test('review writing adds exactly one vote read and one My Realms read', async () => {
  const requests: string[] = [];
  const fake = createFakeKernelFetch(fixtures as never);
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(`${request.method} ${new URL(request.url).pathname}`);
      return fake(request);
    }) as typeof fetch,
  });
  const reviewBoard = realmBoardsRecording.items.find((board) => board.purpose === 'reviews');
  expect(reviewBoard).toBeDefined();
  const subjectId = subjectPageRecording.subject;
  const standardQuestion = '00000000-0000-7000-8000-000000000001';

  await client.boards({ id: boardRecording.board.id }).get();
  const discussionReads = requests.length;
  expect(discussionReads).toBe(1);
  requests.length = 0;
  await client.boards({ id: reviewBoard!.id }).get();
  await client
    .subjects({ id: subjectId })
    .ratings({ questionId: standardQuestion })
    .vote.get({ headers: { authorization: 'Bearer reader' } });
  expect(requests).toHaveLength(discussionReads + 1);
  expect(requests.at(-1)).toBe(`GET /v1/subjects/${subjectId}/ratings/${standardQuestion}/vote`);

  requests.length = 0;
  const realms = await loadMyRealms(
    client,
    new Request(`https://rezics.test/en/subjects/${subjectId}/reviews`, {
      headers: { authorization: 'Bearer reader' },
    }),
    {},
    {},
  );
  expect(realms.signedIn).toBe(true);
  expect(requests).toEqual(['GET /v1/me/realms']);
});

test('review interface copy is present in all eight locales', () => {
  const locales = ['de', 'en', 'es', 'fr', 'ja', 'ko', 'zh-Hans', 'zh-Hant'];
  const files = new Set(readdirSync(join(app, 'messages')));
  for (const locale of locales) {
    expect(files.has(`${locale}.json`)).toBe(true);
    const messages = JSON.parse(source(`messages/${locale}.json`)) as Record<string, string>;
    expect(messages.thread_review_subject, locale).toBeTruthy();
    expect(messages.thread_review_cite_vote, locale).toBeTruthy();
    expect(messages.thread_review_write, locale).toBeTruthy();
    expect(messages.thread_review_duplicate, locale).toBeTruthy();
  }
});

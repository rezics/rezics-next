import { expect, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { fromPlainText } from '@rezics/document';
import { readSubjectCommunity, withSubjectCommunity } from '../src/features/pages/subject-community';
import { SubjectCommunityRegion } from '../src/features/pages/subject-community-view';
import { loadSubjectPage, SubjectPage, type SubjectPageData } from '../src/features/pages/subject';
import { subjectTabs } from '../src/features/pages/views';
import { subjectPageMessages } from '../src/features/pages/route-support';
import { GLOBAL } from '../src/features/pages/subject-ratings';
import { createStoryRecordedKernelFetch } from '../src/kernel/fake';
import { communityAuthor, communitySubject, communityThread } from '../src/kernel/fake/subject-community';
import { threadLocation } from '../src/threads/thread-href';
import { startThreadRequest } from '../src/threads/post-writes';
import { ExistingReviewNotice } from '../src/threads/write-prompts';
import type { SessionEnv } from '../src/session/client';

function fixture(answer?: (request: Request) => Response | undefined) {
  const requests: Request[] = [];
  const fallback = createStoryRecordedKernelFetch();
  const client = createKernelClient('https://kernel.invalid', {
    fetch: (async (input: RequestInfo | URL, init?: RequestInit) => {
      const request = new Request(input, init);
      requests.push(request.clone());
      return answer?.(request) ?? fallback(request);
    }) as typeof fetch,
  });
  return { client, requests };
}
const threadReads = (requests: Request[]) =>
  requests.filter((request) => new URL(request.url).pathname.endsWith('/threads'));
const isCommunity = (request: Request) =>
  new URL(request.url).pathname === `/v1/subjects/${communitySubject.id}/threads`;
function pageHtml(page: SubjectPageData) {
  return renderToStaticMarkup(
    createElement(SubjectPage, { page, locale: 'en', messages: subjectPageMessages(), renderJsonLd: false }),
  );
}

test('Subject lists expose readable native cards and keep writes unavailable without native advice', async () => {
  const { client, requests } = fixture();
  const loaded = await withSubjectCommunity(client, await loadSubjectPage(client, communitySubject.id));
  if (loaded.kind !== 'page') throw new Error('Expected subject page');
  const html = pageHtml(loaded.page);
  expect(html).toContain('A small book with lasting questions');
  expect(html).toContain('What does the fox teach the prince?');
  expect(html).toContain('The desert journey leaves room for tenderness and responsibility.');
  expect(html).toContain('Mira Okabe');
  expect(html).toContain(threadLocation('en', communityThread('review')));
  expect(html).toContain(`subject=${communitySubject.id}`);
  expect(html).not.toContain('data-slot="create-thread"');
  expect(subjectTabs(loaded.page).map((tab) => tab.view)).toEqual(expect.arrayContaining(['reviews', 'discussion']));
  const reads = threadReads(requests);
  expect(reads).toHaveLength(2);
  for (const request of reads) {
    const query = new URL(request.url).searchParams;
    expect(query.get('place')).toBe(GLOBAL);
    expect(query.get('limit')).toBe('5');
    expect(request.headers.has('authorization')).toBe(false);
    expect(request.headers.has('cookie')).toBe(false);
  }
  expect(requests.filter((request) => new URL(request.url).pathname === '/v1/accounts')).toHaveLength(1);
  expect(
    requests.filter((request) => /\/v1\/(accounts|subjects)\/[^/]+$/.test(new URL(request.url).pathname)),
  ).toHaveLength(0);
  expect(JSON.stringify(loaded.page.community)).not.toMatch(
    /firstPost|revisionId|sha256|voteCitation|viewerReaction|decisionId|report|appeal/,
  );

  requests.length = 0;
  const view = await withSubjectCommunity(
    client,
    await loadSubjectPage(client, communitySubject.id, 'reviews'),
    'reviews',
  );
  if (view.kind !== 'page') throw new Error('Expected review view');
  expect(pageHtml(view.page)).toContain('?cursor=community-next');
  expect(new URL(threadReads(requests)[0]!.url).searchParams.get('limit')).toBe('20');
  requests.length = 0;
  const later = await withSubjectCommunity(
    client,
    await loadSubjectPage(client, communitySubject.id, 'reviews'),
    'reviews',
    'community-next',
  );
  if (later.kind !== 'page') throw new Error('Expected review continuation');
  const laterHtml = pageHtml(later.page);
  expect(laterHtml).toContain('Reading it again');
  expect(laterHtml).not.toContain('data-slot="community-next"');
  expect(threadReads(requests)).toHaveLength(1);
  expect(new URL(threadReads(requests)[0]!.url).searchParams.get('cursor')).toBe('community-next');
});

test('current hidden, unavailable and closed reads are distinct from empty, and empty pages retain their native continuation', async () => {
  for (const status of [404, 503, 403]) {
    const { client, requests } = fixture((request) =>
      isCommunity(request)
        ? Response.json(
            { code: status === 403 ? 'platform_closed' : 'not_found', privateCount: 88, detail: 'private reason' },
            { status },
          )
        : undefined,
    );
    const data = await readSubjectCommunity(client, communitySubject.id, ['review']);
    const region = data.regions.review!;
    expect(region.state).toBe(status === 403 ? 'closed' : 'unavailable');
    const html = renderToStaticMarkup(
      createElement(SubjectCommunityRegion, {
        id: 'reviews',
        kind: 'review',
        region,
        authors: data.authors,
        now: data.now,
        subject: communitySubject,
        locale: 'en',
        href: '/en/subjects/subject/reviews',
      }),
    );
    expect(html).not.toContain('No reviews');
    expect(html).not.toContain('private reason');
    expect(html).not.toContain('88');
    expect(requests).toHaveLength(1);
  }
  for (const next of ['opaque-native-cursor', 'x'.repeat(4096), null]) {
    const { client } = fixture((request) => (isCommunity(request) ? Response.json({ threads: [], next }) : undefined));
    const data = await readSubjectCommunity(client, communitySubject.id, ['discussion'], true);
    const html = renderToStaticMarkup(
      createElement(SubjectCommunityRegion, {
        id: 'discussion',
        kind: 'discussion',
        region: data.regions.discussion!,
        authors: data.authors,
        now: data.now,
        subject: communitySubject,
        locale: 'en',
        href: '/en/subjects/subject/discussion',
        paged: true,
      }),
    );
    expect(html).toContain(`data-state="${next ? 'continuation' : 'empty'}"`);
    expect(html.includes('data-slot="community-next"')).toBe(next !== null);
    if (next) expect(html).not.toContain('No discussions');
  }
});

test('only public available summaries and one author batch leave the reader; cursor input remains bounded', async () => {
  const hidden = communityThread('review');
  const { client, requests } = fixture((request) =>
    isCommunity(request) && new URL(request.url).searchParams.get('kind') === 'review'
      ? Response.json({
          threads: [
            communityThread('review'),
            {
              ...hidden,
              id: 'hidden-review',
              availability: 'withheld',
              firstPost: { ...hidden.firstPost, body: fromPlainText('withheld body'), decisionId: 'private-decision' },
            },
          ],
          next: 'native-next',
          privateCount: 1000,
        })
      : undefined,
  );
  const data = await readSubjectCommunity(client, communitySubject.id, ['review', 'review', 'discussion']);
  expect(data.regions.review).toMatchObject({ state: 'unavailable' });
  expect(JSON.stringify(data)).not.toMatch(/withheld body|hidden-review|private-decision|privateCount/);
  const identities = requests.filter((request) => new URL(request.url).pathname === '/v1/accounts');
  expect(identities).toHaveLength(1);
  expect(new URL(identities[0]!.url).searchParams.get('ids')).toBe(communityAuthor.id);
  requests.length = 0;
  for (const cursor of ['', 'x'.repeat(4097)])
    expect(
      (await readSubjectCommunity(client, communitySubject.id, ['review'], true, cursor)).regions.review?.state,
    ).toBe('unavailable');
  expect(requests).toHaveLength(0);
  for (const next of ['', 'x'.repeat(4097)]) {
    const invalid = fixture((request) => (isCommunity(request) ? Response.json({ threads: [], next }) : undefined));
    expect((await readSubjectCommunity(invalid.client, communitySubject.id, ['review'])).regions.review?.state).toBe(
      'unavailable',
    );
  }
  const cursor = 'x'.repeat(4096);
  const observed = fixture();
  const first = await readSubjectCommunity(observed.client, communitySubject.id, ['review'], true, cursor);
  const second = await readSubjectCommunity(observed.client, communitySubject.id, ['review'], true, cursor);
  expect(
    observed.requests.filter(isCommunity).map((request) => new URL(request.url).searchParams.get('cursor')),
  ).toEqual([cursor, cursor]);
  expect(first.sourceKey).toBeString();
  expect(first.sourceKey).not.toBe(second.sourceKey);
});

test('ordinary discussion creation keeps the chosen subject and review conflicts retain the author-owned native target', async () => {
  const bodies: object[] = [];
  const { client } = fixture((request) =>
    request.method === 'POST' && new URL(request.url).pathname === '/v1/threads'
      ? Response.json({ code: 'conflict', existingThreadId: communityThread('review').id }, { status: 409 })
      : undefined,
  );
  const sessionEnv = {
    AUTH_ISSUER: 'https://auth.example.test',
    API_RESOURCE: 'https://api.example.test',
    WEBSITE_SCOPES: 'openid',
    WEBSITE_CLIENT_ID: 'website',
    WEBSITE_CLIENT_KEY: '{}',
    SESSIONS: {
      idFromName: (name: string) => name,
      get: () => ({
        credential: async () => ({
          status: 'active',
          accessToken: 'viewer',
          subject: communityAuthor.id,
          csrfToken: 'csrf',
        }),
      }),
    } as SessionEnv['SESSIONS'],
  };
  const request = new Request('https://rezics.test/', {
    headers: { cookie: `__Host-rezics_session=${'a'.repeat(43)}` },
  });
  const input = {
    boardId: communityThread('review').boardId,
    subjectId: communitySubject.id,
    title: 'A second review',
    body: fromPlainText('Another reading', 'blocks'),
    idempotencyKey: crypto.randomUUID(),
  };
  const result = await startThreadRequest({ ...input, kind: 'review' }, request, sessionEnv, client, () => ({
    ok: false,
    reason: 'conflict',
  }));
  expect(result).toMatchObject({ ok: false, existingReviewId: communityThread('review').id });
  if (result.ok || !result.existingReviewId) throw new Error('Expected native review conflict');
  expect(renderToStaticMarkup(createElement(ExistingReviewNotice, { reviewId: result.existingReviewId }))).toContain(
    `/en/threads/${communityThread('review').id}`,
  );
  const discussion = fixture((sent) => {
    if (sent.method !== 'POST' || !new URL(sent.url).pathname.endsWith('/threads')) return;
    return Response.json({ thread: communityThread('discussion') }, { status: 201 });
  });
  await startThreadRequest(
    { ...input, boardId: communityThread('discussion').boardId },
    request,
    sessionEnv,
    discussion.client,
    () => ({ ok: false, reason: 'unavailable' }),
  );
  bodies.push(await discussion.requests[0]!.json());
  expect(bodies[0]).toMatchObject({ subjectIds: [communitySubject.id] });
});

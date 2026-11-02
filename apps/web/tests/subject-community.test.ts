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
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import { withComposedCommunity } from '../src/features/pages/subject-community';
import { pageContext } from '../src/features/pages/subject';
import {
  boardContribution,
  boardDirectoryPrevious,
  boardDirectoryRequest,
  createNativeBoardDirectoryAdapter,
  loadBoardDirectory,
} from '../src/threads/board-directory';
import { BoardDirectory } from '../src/threads/board-directory-view';
import { Route as directoryRoute } from '../src/routes/boards/index';
import { communityBoard } from '../src/kernel/fake/subject-community';
import { setLocale } from '../src/paraglide/runtime.js';
import { m } from '../src/paraglide/messages.js';
import { QueryClient } from '@tanstack/react-query';
import { requireSignedIn } from '../src/session/guard';
import { sessionQuery } from '../src/session/query';

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

test('the complete assigned visible journey uses actual current native data and preserves its privacy failure and request bounds', async () => {
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
  expect(html).toContain('data-slot="create-thread"');
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
  for (const next of ['opaque-native-cursor', null]) {
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
  expect(
    (await readSubjectCommunity(client, communitySubject.id, ['review'], true, 'x'.repeat(2049))).regions.review?.state,
  ).toBe('unavailable');
  expect(requests).toHaveLength(0);
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

test('An empty Global Subject community region leads through the current native purpose-filtered board directory to the existing composer with the exact Subject preserved while sparse and unavailable states remain honest', async () => {
  setLocale('en', { reload: false });
  const { client, requests } = fixture();
  const loaded = await loadSubjectPage(client, communitySubject.id);
  if (loaded.kind !== 'page') throw new Error('Expected Subject page');
  const plan = planReads(platformRegistry, loaded.page.document as CompositionDocument, pageContext(loaded.page));
  const reads = { ...loaded.page.reads };
  for (const [key, descriptor] of Object.entries(plan.reads)) {
    if (descriptor.kind === 'subjectThreads') reads[key] = { status: 200, body: { threads: [], next: null } };
  }
  const emptyPage = { ...loaded.page, reads };
  const composed = await withComposedCommunity(client, { kind: 'page', page: emptyPage });
  if (composed.kind !== 'page') throw new Error('Expected composed page');
  const html = pageHtml(composed.page);
  const explicitGlobal = await withComposedCommunity(client, {
    kind: 'page',
    page: {
      ...emptyPage,
      context: { id: communitySubject.id, population: { kind: 'global' } },
    },
  });
  if (explicitGlobal.kind !== 'page') throw new Error('Expected Global page');
  expect(pageHtml(explicitGlobal.page)).toContain('data-slot="choose-board"');
  const choices = [...html.matchAll(/<a data-slot="choose-board"[^>]*href="([^"]+)"/gu)];
  expect(choices).toHaveLength(2);
  expect(requests.filter((request) => new URL(request.url).pathname.startsWith('/v1/boards'))).toHaveLength(0);

  for (const choice of choices) {
    const entry = new URL(choice[1]!.replaceAll('&amp;', '&'), 'https://site.test');
    expect(entry.pathname).toBe('/en/boards');
    const search = directoryRoute.options.validateSearch!(Object.fromEntries(entry.searchParams));
    const contribution = boardContribution(search)!;
    expect(contribution).toEqual({ subject: communitySubject.id, subjectTitle: communitySubject.label });
    const request = boardDirectoryRequest(search);
    const current = communityBoard(request.purpose === 'reviews' ? 'review' : 'discussion');
    const cursor = 'signed:native/+exact=';
    const calls: Request[] = [];
    let phase: 'unavailable' | 'sparse' | 'visible' = 'unavailable';
    const directoryClient = createKernelClient('https://kernel.test', {
      fetch: async (input, init) => {
        calls.push(new Request(input, init));
        return phase === 'unavailable'
          ? Response.json({ code: 'dependency_unavailable' }, { status: 503 })
          : Response.json({
              boards:
                phase === 'visible'
                  ? [current, { ...current, id: 'hidden-realm', realmId: current.id, title: 'Hidden Realm board' }]
                  : [],
              next: phase === 'sparse' ? cursor : null,
            });
      },
    });
    const adapter = createNativeBoardDirectoryAdapter(directoryClient);
    const unavailable = await loadBoardDirectory(request, adapter);
    const failure = renderToStaticMarkup(
      createElement(BoardDirectory, { request, contribution, result: unavailable, onRetry: () => {} }),
    );
    expect(failure).toContain(m.board_directory_retry());
    expect(failure).not.toContain(m.board_directory_empty());
    expect(failure).not.toContain('/new?');
    // Explicit retry uses the same native query and keeps the URL's separate contribution context.
    phase = 'sparse';
    const sparse = await loadBoardDirectory(request, adapter);
    const sparseHtml = renderToStaticMarkup(
      createElement(BoardDirectory, { request, contribution, result: sparse, onRetry: () => {} }),
    );
    expect(sparseHtml).toContain(m.board_directory_sparse());
    expect(sparseHtml).not.toContain(m.board_directory_empty());
    expect(sparseHtml).not.toContain('/new?');
    const links = [...sparseHtml.matchAll(/href="([^"]+)"/gu)].map(
      (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'),
    );
    for (const link of links) {
      expect(link.searchParams.get('subject')).toBe(communitySubject.id);
      expect(link.searchParams.get('subjectTitle')).toBe(communitySubject.label);
    }
    const purposeChoice = links.find((link) => link.searchParams.get('purpose') !== request.purpose)!;
    expect(purposeChoice.searchParams.has('cursor')).toBe(false);
    const next = links.find((link) => link.searchParams.has('cursor'))!;
    expect(next.searchParams.get('cursor')).toBe(cursor);
    const destinationSearch = directoryRoute.options.validateSearch!(Object.fromEntries(next.searchParams));
    const destination = boardDirectoryRequest(destinationSearch);
    const previous = boardDirectoryPrevious(request, sparse, destination, contribution)!;
    phase = 'visible';
    const result = await loadBoardDirectory(destination, adapter);
    const visible = renderToStaticMarkup(
      createElement(BoardDirectory, {
        request: destination,
        contribution: boardContribution(destinationSearch)!,
        result,
        previous,
        onRetry: () => {},
      }),
    );
    expect(visible).not.toContain('Hidden Realm board');
    const visibleLinks = [...visible.matchAll(/href="([^"]+)"/gu)].map(
      (match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'),
    );
    const composer = visibleLinks.find((link) => link.pathname.endsWith('/new'))!;
    expect(composer.pathname).toBe(`/en/boards/${current.id}/new`);
    expect(Object.fromEntries(composer.searchParams)).toEqual(contribution);
    const signedOut = new QueryClient();
    signedOut.setQueryData(sessionQuery.queryKey, { state: 'signed-out', csrfToken: null, subject: null });
    await expect(
      requireSignedIn({ context: { queryClient: signedOut }, location: { publicHref: composer.href } }),
    ).rejects.toMatchObject({
      options: { href: `/auth/sign-in?return_to=${encodeURIComponent(composer.pathname + composer.search)}` },
    });
    signedOut.clear();
    expect(visible).toContain(
      request.purpose === 'reviews' ? m.subject_community_review() : m.subject_community_discuss(),
    );
    const back = visibleLinks.find(
      (link) =>
        link.pathname === '/en/boards' &&
        link.searchParams.get('purpose') === request.purpose &&
        !link.searchParams.has('cursor'),
    )!;
    expect(boardContribution(Object.fromEntries(back.searchParams))).toEqual(contribution);
    expect(visible).toContain(m.board_directory_previous());
    for (const changed of [
      undefined,
      { ...contribution, subject: current.id },
      { ...contribution, subjectTitle: 'Another title' },
    ]) {
      const isolated = renderToStaticMarkup(
        createElement(BoardDirectory, {
          request: destination,
          ...(changed ? { contribution: changed } : {}),
          result,
          previous,
          onRetry: () => {},
        }),
      );
      expect(isolated).not.toContain(m.board_directory_previous());
    }
    expect(
      boardDirectoryPrevious(
        request,
        sparse,
        boardDirectoryRequest({ purpose: request.purpose === 'reviews' ? 'discussion' : 'reviews', cursor }),
        contribution,
      ),
    ).toBeUndefined();
    expect(calls).toHaveLength(3);
    for (const [index, call] of calls.entries()) {
      const url = new URL(call.url);
      expect(call.method).toBe('GET');
      expect(url.pathname).toBe('/v1/boards');
      expect(Object.fromEntries(url.searchParams)).toEqual({
        purpose: request.purpose,
        limit: '20',
        ...(index === 2 ? { cursor } : {}),
      });
    }
    for (const invalid of [
      { subject: 'raw-uuid-entry', subjectTitle: 'Invalid' },
      { ...contribution, subjectTitle: 'x'.repeat(513) },
      { subject: contribution.subject },
    ]) {
      const rejected = directoryRoute.options.validateSearch!({
        ...search,
        ...invalid,
        subjectTitle: invalid.subjectTitle,
      });
      expect(boardContribution(rejected)).toBeUndefined();
      const ordinary = renderToStaticMarkup(createElement(BoardDirectory, { request, result, onRetry: () => {} }));
      expect(ordinary).not.toContain('/new?');
      expect(ordinary).toContain(m.board_directory_open());
    }
    const title = '<img src=x onerror="bad()"> & "Subject"';
    const escaped = renderToStaticMarkup(
      createElement(BoardDirectory, {
        request,
        contribution: { ...contribution, subjectTitle: title },
        result,
        onRetry: () => {},
      }),
    );
    expect(escaped).not.toContain('<img');
    const escapedComposer = [...escaped.matchAll(/href="([^"]+)"/gu)]
      .map((match) => new URL(match[1]!.replaceAll('&amp;', '&'), 'https://site.test'))
      .find((link) => link.pathname.endsWith('/new'))!;
    expect(escapedComposer.searchParams.get('subjectTitle')).toBe(title);
  }

  // Actual population and request semantics govern scope, never a Context UUID or empty rows.
  for (const page of [
    {
      ...emptyPage,
      context: { id: GLOBAL, population: { kind: 'realm' as const, id: communitySubject.id, title: 'A Realm' } },
    },
    {
      ...emptyPage,
      requestedRealm: communitySubject.id,
      context: { id: GLOBAL, population: { kind: 'global' as const } },
    },
  ]) {
    const scoped = await withComposedCommunity(client, { kind: 'page', page });
    if (scoped.kind !== 'page') throw new Error('Expected scoped page');
    expect(pageHtml(scoped.page)).not.toContain('data-slot="choose-board"');
  }
  for (const response of [
    { status: 200, body: { threads: [], next: 'native-continuation' } },
    { status: 503, body: {} },
    { status: 204, body: {} },
    { status: 403, body: { code: 'platform_closed' } },
  ]) {
    const reads = { ...emptyPage.reads };
    for (const [key, descriptor] of Object.entries(plan.reads))
      if (descriptor.kind === 'subjectThreads') reads[key] = response;
    const honest = await withComposedCommunity(client, { kind: 'page', page: { ...emptyPage, reads } });
    if (honest.kind !== 'page') throw new Error('Expected page');
    expect(pageHtml(honest.page)).not.toContain('data-slot="choose-board"');
  }
  const unknown = renderToStaticMarkup(
    createElement(SubjectCommunityRegion, {
      id: 'unknown',
      kind: 'review',
      region: { state: 'ready', threads: [], next: null },
      authors: {},
      now: composed.page.community!.now,
      subject: communitySubject,
      locale: 'en',
      href: '/en/subjects/subject/reviews',
    }),
  );
  expect(unknown).not.toContain('data-slot="choose-board"');
  expect(unknown).toContain(m.subject_community_board_unavailable());
});

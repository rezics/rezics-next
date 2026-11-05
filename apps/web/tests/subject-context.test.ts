import { describe, expect, mock, test } from 'bun:test';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToString } from 'react-dom/server';
import { createKernelClient } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectPageData } from '../src/features/pages/subject';
import { canonicalRedirect } from '../src/subject/subject-href';
import { GLOBAL, QUESTION } from '../src/features/pages/subject-ratings';
import recording from '../src/kernel/recorded/subject-page.json';
import realmRecording from '../src/kernel/recorded/realm.json';
import { m } from '../src/paraglide/messages.js';
import { setLocale } from '../src/paraglide/runtime.js';
import { subjectHref } from '../src/subject/subject-href';

// Render and cache-key cases supply only the unused Worker environment boundary; SDK transport remains explicit.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { subjectPageTitle, pageContext } = await import('../src/features/pages/subject');
const { loadSubjectPage, SubjectPage, subjectBody, subjectPageJsonLd } = await import('../src/features/pages/subject');
const { loadViewPages } = await import('../src/features/pages/subject-frame');
const { assertSamePageContext, contextSubjectAddress, loadContextSubject } =
  await import('../src/features/pages/context-subject');
const { contextHref } = await import('../src/features/pages/context-navigation');
const { subjectReaderPartition } = await import('../src/features/pages/context-reader');
const { subjectCanonicalQuery, subjectPageQuery, subjectViewPagesQuery } =
  await import('../src/features/pages/subject-queries');
const { readRelationGroup, relationGroupKey } = await import('../src/features/pages/relation-stream-query');

const realm = realmRecording.realm.realmId;
const selected = {
  id: realmRecording.realm.contextId,
  population: { kind: 'realm' as const, id: realm, title: realmRecording.realm.title },
};
const messages = {
  unknown: 'Unknown',
  none: 'None',
  unlabelled: 'Untitled',
  sources: 'Sources',
  aliases: 'Aliases',
  search: 'Search',
};

function recordedPage(context = selected): SubjectPageData {
  const page = structuredClone(recording) as unknown as SubjectPageData;
  page.context = context;
  for (const read of Object.values(page.reads)) {
    const body = read.body as { subject?: { context: string; labels: Record<string, string> } };
    if (body.subject) {
      body.subject.context = context.id;
      body.subject.labels.en = 'Current selected title';
    }
  }
  return page;
}

// Deliberately unexecuted in the typing-only delivery; render the actual default Subject composition.
test('Make selected Realm and Global fallback recovery usable on phones', () => {
  const longTitle = `${realmRecording.realm.title} — Literature, translations and long-running reading discussions / 読書と翻訳について語り合うコミュニティ`;
  const cases = [
    { name: 'SelectedRealm', title: realmRecording.realm.title },
    { name: 'LongRealmTitle', title: longTitle },
    { name: 'GlobalFallback', fallback: true },
    { name: 'NormalGlobal', global: true },
    { name: 'IndependentContinuation', title: realmRecording.realm.title, view: 'editions' },
    { name: 'FallbackContinuation', fallback: true, view: 'editions' },
  ] as const;
  try {
    for (const locale of ['en', 'zh-Hans', 'zh-Hant', 'ja', 'ko', 'de', 'fr', 'es'] as const) {
      setLocale(locale, { reload: false });
      const o = { locale };
      for (const state of cases) {
        const page = structuredClone(recording) as unknown as SubjectPageData;
        page.context =
          'title' in state
            ? { ...selected, population: { ...selected.population, title: state.title } }
            : { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
        if (!('global' in state)) page.requestedRealm = realm;
        for (const read of Object.values(page.reads)) {
          const body = read.body as { subject?: { context: string } };
          if (body.subject) body.subject.context = page.context.id;
        }
        const label = subjectPageTitle(page, locale);
        const address = subjectHref({ id: recording.subject, label }, locale).href;
        if ('view' in state) {
          page.document = {
            root: { props: {} },
            content: [
              { type: 'SubjectList', props: { id: 'editions', property: 'schema:exampleOfWork', paged: true } },
            ],
          };
          page.continuation = { node: 'editions', cursor: 'native+opaque-cursor' };
          const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
          page.reads = { [plan.nodes.editions!]: { status: 200, body: { links: [], next: 'next-native-cursor' } } };
        }
        const client = new QueryClient();
        let html: string;
        try {
          html = renderToString(
            createElement(
              QueryClientProvider,
              { client },
              createElement(SubjectPage, {
                page,
                locale,
                messages,
                subjectLabel: label,
                ...('view' in state ? { view: state.view } : {}),
              }),
            ),
          );
        } finally {
          client.clear();
        }
        const nav = html.match(/<nav\b[^>]*data-slot="page-context"[\s\S]*?<\/nav>/)?.[0];
        if ('global' in state) {
          expect(html).toContain(label);
          expect(nav).toBeUndefined();
          continue;
        }
        expect(nav).toContain(`aria-label="${m.subject_context_navigation({}, o)}"`);
        const href = `${address}${'view' in state ? `/${state.view}` : ''}`;
        const links = Array.from(nav!.matchAll(/<a\b[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/g), (match) => ({
          href: match[1]!.replaceAll('&amp;', '&'),
          text: match[2],
        }));
        if ('title' in state) {
          expect(nav).toContain(m.subject_context_selected({ title: state.title }, o));
          expect(links).toEqual([
            { href: `/${locale}/realms/${realm}`, text: m.subject_context_return({ title: state.title }, o) },
            { href, text: m.subject_context_switch_global({}, o) },
          ]);
        } else {
          expect(nav).toContain(m.subject_context_global({}, o));
          expect(nav).toContain(m.subject_context_fallback({}, o));
          expect(nav).not.toContain(realmRecording.realm.title);
          expect(nav).not.toContain(`/realms/${realm}`);
          expect(links).toEqual([
            { href, text: m.subject_context_switch_global({}, o) },
            { href: `${href}?realm=${realm}`, text: m.subject_context_retry({}, o) },
          ]);
        }
        for (const link of links) {
          const url = new URL(link.href, 'https://rezics.invalid');
          expect([...url.searchParams.keys()]).toEqual(link.href.includes('?realm=') ? ['realm'] : []);
          expect(url.hash).toBe('');
        }
      }
    }
  } finally {
    setLocale('en', { reload: false });
  }
});

describe('Close current Context and Realm Subject navigation cache and continuation', () => {
  test('selected structured metadata uses current facts without substituting the Global rating population', () => {
    const ratings = {
      figure: {
        questionId: QUESTION,
        populationId: GLOBAL,
        scale: { min: 0, max: 20, displayStep: 1 },
        state: 'ready' as const,
        count: 28,
        mean: 8.4,
        score: 8.1,
      },
    };
    const page = recordedPage();
    const selectedJson = JSON.parse(subjectPageJsonLd(page, 'en', { ratings })!);
    expect(selectedJson.name).toBe('Current selected title');
    expect(selectedJson.aggregateRating).toBeUndefined();
    const global = { ...page, context: { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } } };
    expect(JSON.parse(subjectPageJsonLd(global, 'en', { ratings })!).aggregateRating).toMatchObject({
      ratingValue: 8.4,
      ratingCount: 28,
    });
  });

  test('canonical redirects use the selected current title and retain Realm, native cursor, node and fragment', async () => {
    const requests: { body: Record<string, unknown>; authorization: string | null; path: string }[] = [];
    const page = recordedPage();
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          body: await request.json(),
          authorization: request.headers.get('authorization'),
          path: new URL(request.url).pathname,
        });
        return Response.json(page);
      }) as typeof fetch,
    });
    const result = await loadContextSubject(client, page.subject!, 'en', {
      realm,
      authorization: 'Bearer current-reader',
    });
    expect(result.kind).toBe('subject');
    if (result.kind !== 'subject') throw new Error('Expected a selected canonical address');
    expect(result.value.slug).toBe('current-selected-title');
    expect(result.value.paths.en).toEndWith('/current-selected-title');
    const query = `?realm=${realm}&node=editions&cursor=opaque%2Btoken`;
    expect(canonicalRedirect(result.value.href, query, '#reading').href).toBe(`${result.value.href}${query}#reading`);
    expect(requests).toEqual([
      {
        body: { target: { subject: page.subject, realm }, languages: ['en'] },
        authorization: 'Bearer current-reader',
        path: '/v1/pages:read',
      },
    ]);
  });

  test('only the selected node continues, with the current Realm and bearer on both native page reads', async () => {
    const overview = recordedPage();
    const document: CompositionDocument = {
      root: { props: {} },
      content: [
        { type: 'SubjectList', props: { id: 'editions', property: 'schema:exampleOfWork', limit: 12, paged: true } },
        { type: 'SubjectList', props: { id: 'works', property: 'schema:author', limit: 12, paged: true } },
      ],
    };
    const cursor = 'native+opaque/cursor';
    const continuation = { node: 'editions', cursor };
    const page: SubjectPageData = { ...overview, document, continuation, reads: {} };
    const plan = planReads(platformRegistry, document, { subject: page.subject, context: selected, continuation });
    page.reads[plan.nodes.editions!] = { status: 200, body: { links: [], next: 'next+native' } };
    page.reads[plan.nodes.works!] = { status: 204, body: {} };
    const requests: {
      target: { realm?: string; view?: string };
      continuation?: unknown;
      authorization: string | null;
    }[] = [];
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async (input, init) => {
        const request = new Request(input, init);
        const body = await request.json();
        requests.push({ ...body, authorization: request.headers.get('authorization') });
        return Response.json(body.target.view ? page : overview);
      }) as typeof fetch,
    });
    const loaded = await loadViewPages(client, page.subject!, 'editions', 'en', cursor, {
      realm,
      node: 'editions',
      authorization: 'Bearer reader-a',
    });
    expect(requests).toHaveLength(2);
    expect(requests[0]).toMatchObject({
      target: { realm, view: 'editions' },
      continuation,
      authorization: 'Bearer reader-a',
    });
    expect(requests[1]).toMatchObject({ target: { realm }, authorization: 'Bearer reader-a' });
    expect(requests[1]?.continuation).toBeUndefined();
    if (loaded.kind !== 'page') throw new Error('Expected current page');
    expect(loaded.next).toBeUndefined();
    expect(loaded.page.requestedRealm).toBe(realm);
    const html = renderToString(
      createElement(
        QueryClientProvider,
        { client: new QueryClient() },
        createElement(SubjectPage, {
          page: loaded.page,
          locale: 'en',
          messages,
          view: 'editions',
          subjectLabel: 'Current selected title',
        }),
      ),
    );
    expect(html).toContain('data-slot="continue-group"');
    expect(html).toContain(`/editions?node=editions&amp;cursor=next%2Bnative&amp;realm=${realm}`);
    expect(html).toContain(`/works?node=works&amp;realm=${realm}`);
  });

  test('More retains the requested Realm but retires the old group when current Context or fallback changes', async () => {
    const document: CompositionDocument = {
      root: { props: {} },
      content: [
        { type: 'SubjectList', props: { id: 'editions', property: 'schema:exampleOfWork', limit: 12, paged: true } },
      ],
    };
    const request = {
      subject: recording.subject,
      locale: 'en',
      view: 'editions' as const,
      node: 'editions',
      cursor: 'opaque+token',
      realm,
      reader: 'reader-a',
      context: selected.id,
      population: 'realm' as const,
    };
    const global = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } };
    for (const context of [selected, { ...selected, id: '00000000-0000-8000-8000-000000000099' }, global]) {
      const page: SubjectPageData = { ...recordedPage(), context, document, continuation: request, reads: {} };
      const plan = planReads(platformRegistry, document, { subject: page.subject, context, continuation: request });
      page.reads[plan.nodes.editions!] = { status: 200, body: { links: [], next: 'current-next' } };
      const calls: unknown[] = [];
      const client = createKernelClient('https://kernel.invalid', {
        fetch: (async (input, init) => {
          const call = new Request(input, init);
          calls.push({ body: await call.json(), authorization: call.headers.get('authorization') });
          return Response.json(page);
        }) as typeof fetch,
      });
      const result = await readRelationGroup(client, request, 'Bearer reader-a');
      if (context === selected) expect(result).toMatchObject({ ok: true, body: { next: 'current-next' } });
      else expect(result).toEqual({ ok: false, status: 409 });
      expect(calls).toEqual([
        {
          body: {
            target: { subject: request.subject, realm, view: request.view },
            languages: ['en'],
            continuation: { node: request.node, cursor: request.cursor },
          },
          authorization: 'Bearer reader-a',
        },
      ]);
      if (context === global) {
        expect(
          await readRelationGroup(client, { ...request, context: PAGE_GLOBAL_CONTEXT, population: 'global' }),
        ).toMatchObject({ ok: true, body: { next: 'current-next' } });
      }
    }
    const first = relationGroupKey(request);
    for (const variant of [
      { ...request, reader: 'reader-b' },
      { ...request, reader: null },
      { ...request, context: PAGE_GLOBAL_CONTEXT, population: 'global' as const },
      { ...request, node: 'works' },
      { ...request, cursor: 'another-token' },
    ])
      expect(relationGroupKey(variant)).not.toEqual(first);
  });

  test('Context replacement and late Global fallback cannot mix an old view with a new overview', async () => {
    for (const current of [
      { ...selected, id: '00000000-0000-8000-8000-000000000099' },
      { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } },
    ]) {
      const before = recordedPage();
      const after = { ...recordedPage(), context: current };
      expect(() => assertSamePageContext(before, after)).toThrow('dependency_unavailable');
      let count = 0;
      const client = createKernelClient('https://kernel.invalid', {
        fetch: (async () => Response.json(++count === 1 ? before : after)) as typeof fetch,
      });
      await expect(loadViewPages(client, before.subject!, 'editions', 'en', undefined, { realm })).rejects.toThrow(
        'dependency_unavailable',
      );
      expect(count).toBe(2);
    }
  });

  test('Global fallback is explicit, retains the selector on navigation and never discloses an old Realm title', async () => {
    const page = recordedPage();
    page.context = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' } };
    for (const read of Object.values(page.reads)) {
      const body = read.body as { subject?: { context: string } };
      if (body.subject) body.subject.context = PAGE_GLOBAL_CONTEXT;
    }
    const client = createKernelClient('https://kernel.invalid', {
      fetch: (async () => Response.json(page)) as typeof fetch,
    });
    const result = await loadSubjectPage(client, page.subject!, undefined, 'en', { realm });
    if (result.kind !== 'page') throw new Error('Expected independently authorized Global fallback');
    const html = renderToString(createElement(SubjectPage, { page: result.page, locale: 'en', messages }));
    expect(html).toContain('Reading Global');
    expect(html).toContain('Retry this selection');
    expect(html).not.toContain(realmRecording.realm.title);
    expect(html).not.toContain(`/realms/${realm}`);
    expect(html).toContain(`realm=${realm}`);
    const address = contextSubjectAddress(result.page, 'en');
    expect(contextHref(`${address.href}/editions?node=editions&cursor=a%2Bb#items`, realm)).toBe(
      `${address.href}/editions?node=editions&cursor=a%2Bb&realm=${realm}#items`,
    );
    expect(subjectPageJsonLd(result.page, 'en')).toContain(subjectBody(result.page)!.subject.labels.en!);
    expect(subjectPageJsonLd(result.page, 'en')).not.toContain(realmRecording.realm.title);
  });

  test('missing and unavailable selections stay concealed or retryable without a Global read', async () => {
    for (const status of [404, 503]) {
      let calls = 0;
      const client = createKernelClient('https://kernel.invalid', {
        fetch: (async () => {
          calls += 1;
          return Response.json({ code: status === 404 ? 'not_found' : 'dependency_unavailable' }, { status });
        }) as typeof fetch,
      });
      const load = loadContextSubject(client, recording.subject, 'en', { realm });
      if (status === 404) expect(await load).toEqual({ kind: 'missing' });
      else await expect(load).rejects.toThrow('dependency_unavailable');
      expect(calls).toBe(1);
    }
  });

  test('retirement after a selected Realm merge read prevents its survivor stage and Global fallback', async () => {
    let startRead!: () => void;
    let finishRead!: (response: Response) => void;
    const started = new Promise<void>((resolve) => (startRead = resolve));
    const delayed = new Promise<Response>((resolve) => (finishRead = resolve));
    const requests: { path: string; authorization: string | null; body: unknown; signal: AbortSignal }[] = [];
    const client = createKernelClient('https://kernel.invalid', {
      fetch: async (input, init) => {
        const request = new Request(input, init);
        requests.push({
          path: new URL(request.url).pathname,
          authorization: request.headers.get('authorization'),
          body: await request.json(),
          signal: request.signal,
        });
        startRead();
        return delayed;
      },
    });
    const controller = new AbortController();
    const pending = loadContextSubject(client, recording.subject, 'en', {
      realm,
      authorization: 'Bearer selected-reader',
      signal: controller.signal,
    });
    await started;
    controller.abort();
    finishRead(Response.json({ ...recordedPage(), subject: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e81' }));
    await expect(pending).rejects.toMatchObject({ name: 'AbortError' });
    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      path: '/v1/pages:read',
      authorization: 'Bearer selected-reader',
    });
    expect(requests[0]?.signal.aborted).toBe(true);
    expect(requests[0]?.body).toEqual({
      target: { subject: recording.subject, realm },
      languages: ['en'],
    });
  });

  test('anonymous, account, Realm, language and independent node cursors have separate cache identities', async () => {
    const client = new QueryClient();
    const first = subjectViewPagesQuery(
      recording.subject,
      'en',
      'editions',
      'same-token',
      realm,
      'editions',
      'reader-a',
    );
    client.setQueryData(first.queryKey, { private: 'reader-a' });
    const variants = [
      subjectViewPagesQuery(recording.subject, 'en', 'editions', 'same-token', realm, 'editions', 'reader-b'),
      subjectViewPagesQuery(recording.subject, 'en', 'editions', 'same-token', realm, 'editions'),
      subjectViewPagesQuery(recording.subject, 'en', 'editions', 'same-token', undefined, 'editions'),
      subjectViewPagesQuery(recording.subject, 'ja', 'editions', 'same-token', realm, 'editions', 'reader-a'),
      subjectViewPagesQuery(recording.subject, 'en', 'editions', 'same-token', realm, 'works', 'reader-a'),
    ];
    for (const query of variants) expect(client.getQueryData(query.queryKey)).toBeUndefined();
    expect(subjectPageQuery(recording.subject, 'en', 'overview', realm, 'reader-a').queryKey).not.toEqual(
      subjectPageQuery(recording.subject, 'en', 'overview', realm, 'reader-b').queryKey,
    );
    expect(subjectCanonicalQuery(recording.subject, 'en', realm, 'reader-a').queryKey).not.toEqual(
      subjectCanonicalQuery(recording.subject, 'en').queryKey,
    );
    expect(subjectReaderPartition(realm, 'reader-a', { state: 'signed-in', subject: 'reader-b' })).toBe('reader-b');
    expect(subjectReaderPartition(realm, 'reader-a', { state: 'signed-out' })).toBeNull();
    expect(subjectReaderPartition(realm, 'reader-a', { state: 'unavailable' })).toBe('unavailable');
    const query = subjectPageQuery(recording.subject, 'en', 'overview', realm, 'reader-a');
    let reads = 0;
    const current = { ...query, queryFn: async () => ({ revision: ++reads }) };
    expect(await client.fetchQuery(current)).toEqual({ revision: 1 });
    expect(await client.fetchQuery(current)).toEqual({ revision: 2 });
    expect(query.gcTime).toBe(0);
    expect(query.retry).toBe(false);
    client.clear();
  });
});

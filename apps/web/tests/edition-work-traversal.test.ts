import { expect, mock, test } from 'bun:test';
import { createKernelClient } from '@rezics/client';
import {
  planReads,
  platformRegistry,
  readCost,
  resolveView,
  validateProfile,
  type PresentationProfile,
  type CompositionDocument,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { SubjectPageData } from '../src/features/pages/subject';
import type { OverviewValue } from '../src/features/pages/overview';
import { relationDefinitions } from '../src/subject/relations';
import { defaultReader } from '../src/subject/reader';
import {
  traversalPage,
  traversalSubjects,
  traversalRealm,
  traversalRelease,
  type TraversalScenario,
} from '../src/kernel/fake/edition-work';

// Direct Bun runs have no Workers runtime; transport assertions below use the actual injected client.
mock.module('cloudflare:workers', () => ({ env: {} }));
const { SubjectPage, pageContext, pageRelationProperties } = await import('../src/features/pages/subject');
const { subjectPageMessages } = await import('../src/features/pages/route-support');
const { subjectTabs } = await import('../src/features/pages/views');
const { readRelationGroup, relationGroupKey } = await import('../src/features/pages/relation-stream-query');
const { relationStreamItems } = await import('../src/features/pages/relation-stream');
const { loadViewPages } = await import('../src/features/pages/subject-frame');
const { holderItems, statementItems } = await import('../src/features/pages/overview');

const profile = profileJson as PresentationProfile;
let requestSignal: AbortSignal | null | undefined;
const definitions = (page: SubjectPageData) =>
  relationDefinitions(traversalRelease, pageRelationProperties(page), 'en');
function render(
  page: SubjectPageData,
  scenario: TraversalScenario,
  view: 'overview' | 'works' | 'editions' | 'relations' = 'overview',
) {
  return renderToStaticMarkup(
    createElement(
      QueryClientProvider,
      { client: new QueryClient() },
      createElement(SubjectPage, {
        page,
        locale: 'en',
        view,
        subjectLabel: traversalSubjects[scenario].label,
        messages: subjectPageMessages(),
        relations: definitions(page),
        renderJsonLd: false,
      }),
    ),
  );
}
function group(page: SubjectPageData, node: string) {
  const plan = planReads(platformRegistry, page.document as CompositionDocument, pageContext(page));
  const key = plan.nodes[node]!;
  return { read: plan.reads[key]!, result: page.reads[key]! };
}
function clientFor(scenario: TraversalScenario, seen: { body: Record<string, any>; headers: Headers }[], status = 200) {
  return createKernelClient('http://fixture.test', {
    fetch: (async (input, init) => {
      requestSignal = init?.signal;
      const request = new Request(input, init);
      expect(new URL(request.url).pathname).toBe('/v1/pages:read');
      const body = (await request.json()) as Record<string, any>;
      seen.push({ body, headers: request.headers });
      return Response.json(
        status === 200
          ? traversalPage(scenario, body.target.view, { realm: body.target.realm, continuation: body.continuation })
          : { code: 'not_found' },
        { status },
      );
    }) as typeof fetch,
  });
}

test('edition-to-work and work-to-editions use the current released template, canonical target and Context', () => {
  expect(validateProfile(platformRegistry, profile)).toEqual([]);
  const types = traversalRelease.types as Record<string, { bases: string[]; properties: string[] }>;
  for (const [type, definition] of Object.entries(types)) {
    if (!definition.properties.includes('schema:exampleOfWork')) continue;
    const target = { type, bases: definition.bases };
    for (const view of ['overview', 'relations'] as const) {
      const document = resolveView(profile, target, view)!.document;
      const plan = planReads(platformRegistry, document, { subject: traversalSubjects.edition.id });
      expect(
        Object.values(plan.reads).some((read) => read.kind === 'relations' && read.property === 'schema:exampleOfWork'),
      ).toBe(true);
      expect(Object.values(plan.reads).length).toBeLessThanOrEqual(16);
      expect(Object.values(plan.reads).reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(128);
    }
  }
  const html = render(traversalPage('edition', 'overview', { realm: traversalRealm }), 'edition');
  expect(html).toContain(`/subjects/${traversalSubjects.work.id}/the-harbour?realm=${traversalRealm}`);
  expect(html).toContain('The harbour');
  const work = render(traversalPage('work'), 'work');
  expect(work).toContain('Edition 12');
  expect(work).not.toContain('Edition 13');
  expect(work).toContain(`/subjects/${traversalSubjects.work.id}/the-harbour/editions`);
  expect(work).toContain('data-slot="see-all"');
  expect(subjectTabs(traversalPage('work')).find((tab) => tab.view === 'editions')?.count).toEqual({
    value: 15,
    relation: 'exact',
  });
});

test('preview affordances respect exact, lower-bound and unavailable native totals and explicit continuation', () => {
  for (const count of ['exact', 'lower', 'unavailable'] as const) {
    const page = traversalPage('work', 'overview', { count });
    const html = render(page, 'work');
    expect(html).toContain('data-slot="see-all"');
    const tab = subjectTabs(page).find((tab) => tab.view === 'editions');
    expect(tab).toBeDefined();
    expect(tab?.count).toEqual(
      count === 'unavailable' ? undefined : { value: 15, relation: count === 'exact' ? 'exact' : 'lower_bound' },
    );
    // A signed next page wins even when a native total equals the currently embedded length.
    const editions = group(page, 'editions').result.body as Record<string, unknown>;
    editions.count = { value: 12, exact: true };
    expect(render(page, 'work')).toContain('data-slot="see-all"');
    expect(subjectTabs(page).some((tab) => tab.view === 'editions')).toBe(true);
    // Native scanning may return an empty page with a usable continuation.
    editions.links = [];
    delete editions.count;
    expect(render(page, 'work')).toContain('data-slot="see-all"');
    expect(subjectTabs(page).some((tab) => tab.view === 'editions')).toBe(true);
  }
});

test('creator-to-Works continues each current configured role independently with its opaque binding', async () => {
  const seen: { body: Record<string, any>; headers: Headers }[] = [];
  const client = clientFor('creator', seen);
  const initial = traversalPage('creator', 'works', { realm: traversalRealm });
  const before = structuredClone(initial);
  for (const node of ['author', 'illustrator']) {
    const result = group(initial, node).result.body as { next: string };
    expect(result.next).toBe(`fixture-${node}-next`);
    const input = {
      subject: traversalSubjects.creator.id,
      locale: 'en',
      view: 'works' as const,
      realm: traversalRealm,
      node,
      cursor: result.next,
    };
    const controller = new AbortController();
    const section = await readRelationGroup(client, input, 'Bearer current-viewer', controller.signal);
    expect(section.ok).toBe(true);
    if (!section.ok) throw new Error('Expected current role');
    expect(section.body.next).toBeNull();
    expect((section.body.links as unknown[]).length).toBe(node === 'author' ? 3 : 2);
    expect(seen.at(-1)?.body).toMatchObject({
      target: { subject: input.subject, view: 'works', realm: traversalRealm },
      continuation: { node, cursor: result.next },
    });
    expect(seen.at(-1)?.headers.get('authorization')).toBe('Bearer current-viewer');
    expect(requestSignal).toBe(controller.signal);
    expect(relationGroupKey(input)).not.toEqual(relationGroupKey({ ...input, node: 'another-role' }));
    expect(relationGroupKey(input)).not.toEqual(relationGroupKey({ ...input, realm: undefined }));
    expect(relationGroupKey(input)).not.toEqual(relationGroupKey({ ...input, view: 'editions' }));
  }
  expect(seen).toHaveLength(2);
  expect(initial).toEqual(before);
});

test('actual full-view loading keeps sibling groups unrequested and uses only selected aggregate plus frame reads', async () => {
  const seen: { body: Record<string, any>; headers: Headers }[] = [];
  const loaded = await loadViewPages(
    clientFor('creator', seen),
    traversalSubjects.creator.id,
    'works',
    'en',
    'fixture-author-next',
    { realm: traversalRealm, node: 'author' },
  );
  expect(loaded.kind).toBe('page');
  if (loaded.kind !== 'page') throw new Error('Expected page');
  expect(group(loaded.page, 'illustrator').result.status).toBe(204);
  expect(group(loaded.overview, 'illustrator').result.status).toBe(200);
  expect(seen).toHaveLength(2);
  expect(seen.every(({ body }) => body.target.realm === traversalRealm)).toBe(true);
  expect(loaded.next).toBeUndefined();
  expect(render(loaded.page, 'creator', 'works')).toContain('Start again');
});

test('hidden targets have no successful raw-ID link; missing sources and current refusals stay unavailable', async () => {
  const html = render(traversalPage('hidden', 'relations'), 'hidden', 'relations');
  expect(html).not.toContain(`/subjects/${traversalSubjects.work.id}`);
  const unavailable = render(traversalPage('unavailable'), 'unavailable');
  expect(unavailable).toContain('data-state="failed"');
  expect(unavailable).not.toContain(`/subjects/${traversalSubjects.work.id}`);
  for (const status of [403, 404, 409, 503]) {
    const page = traversalPage('creator', 'works', {
      continuation: { node: 'author', cursor: 'fixture-author-next' },
      failure: status,
    });
    const result = render(page, 'creator', 'works');
    expect(result).toContain('Start again');
  }
  const seen: { body: Record<string, any>; headers: Headers }[] = [];
  const request = {
    subject: traversalSubjects.edition.id,
    view: 'relations' as const,
    locale: 'en',
    realm: traversalRealm,
    node: 'edition-work',
    cursor: 'opaque-current-cursor',
  };
  expect(await readRelationGroup(clientFor('edition', seen, 404), request)).toEqual({ ok: false, status: 404 });
  expect(seen).toHaveLength(1);
  expect(seen[0]?.body.target.realm).toBe(traversalRealm);
});

test('embedded qualified previews retain disclosed canonical type, cover and native total instead of array length', () => {
  const target = traversalSubjects.work.id;
  const survivor = traversalSubjects.edition.id;
  const statement = {
    id: target,
    property: { id: 'schema:exampleOfWork', data_type: 'wikibase-item' },
    value: { type: 'value', content: target },
    rank: 'normal',
    qualifiers: [],
    references: [],
  };
  const value = { locale: 'en', reader: defaultReader } as OverviewValue;
  const cover = { media: survivor };
  const section = {
    ok: true as const,
    read: { kind: 'subject' as const, id: target },
    body: {
      subject: { statements: { 'schema:exampleOfWork': [statement] }, relationCounts: { 'schema:exampleOfWork': 31 } },
      related: {
        [target]: {
          labels: { en: 'Current title' },
          redirect: survivor,
          type: 'schema:Book',
          types: ['schema:Book', 'schema:CreativeWork'],
          cover,
        },
      },
    },
  };
  const items = statementItems(section, 'schema:exampleOfWork', 12, value)!;
  expect(items.count).toEqual({ value: 31, relation: 'exact' });
  expect(items.more).toBe(true);
  expect(items.items[0]).toMatchObject({ id: survivor, summary: { id: survivor, type: 'schema:Book', cover } });
  section.body.subject.relationCounts = {} as typeof section.body.subject.relationCounts;
  expect(statementItems(section, 'schema:exampleOfWork', 12, value)?.count).toBeUndefined();
  const projected = relationStreamItems(
    {
      ok: true,
      read: { kind: 'relations', id: target, property: 'schema:exampleOfWork', limit: 12 },
      body: {
        relations: [{ target, statement, summary: { id: survivor, type: 'schema:Book' }, label: 'Current title' }],
        next: null,
      },
    },
    value,
  )!;
  expect(projected.items[0]?.id).toBe(survivor);
  const incoming = holderItems(
    {
      links: [
        { subject: target, label: 'Current title', summary: { id: survivor, type: 'schema:Book', cover } },
        { subject: target, summary: null },
      ],
      next: 'native-current-next',
    },
    12,
  )!;
  expect(incoming.items).toHaveLength(1);
  expect(incoming.items[0]).toMatchObject({ id: survivor, summary: { type: 'schema:Book', cover } });
  expect(incoming.count).toBeUndefined();
  expect(incoming.more).toBe(true);
});

test('the editions-over-twelve story transport reaches its canonical frame, preview and continued actual page', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { loadSubjectPage } = await import('../src/features/pages/subject');
  const { subjectFrame } = await import('../src/features/pages/subject-frame');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  const canonical = await loadSubject(client, traversalSubjects.work.id, 'en');
  expect(canonical.kind).toBe('subject');
  if (canonical.kind !== 'subject') throw new Error('Expected canonical Work');
  expect(canonical.value.href).toBe(`/en/subjects/${traversalSubjects.work.id}/the-harbour`);

  const loaded = await loadViewPages(client, canonical.value.id, 'editions', 'en', undefined, {
    realm: traversalRealm,
  });
  if (loaded.kind !== 'page') throw new Error('Expected editions story page');
  expect(subjectFrame(loaded.overview, 'en')?.title.text).toBe(traversalSubjects.work.label);
  expect(loaded.page.context).toEqual(loaded.overview.context);
  expect(loaded.page.context?.population).toEqual({ kind: 'realm', id: traversalRealm, title: 'Harbour readers' });
  expect(subjectTabs(loaded.overview).find((tab) => tab.view === 'editions')?.count).toEqual({
    value: 15,
    relation: 'exact',
  });
  expect(render(loaded.overview, 'work')).toContain('data-slot="see-all"');
  const initial = render(loaded.page, 'work', 'editions');
  expect(initial).toContain('Edition 12');
  expect(initial).not.toContain('Edition 15');
  expect(initial).toContain(`node=editions&amp;cursor=fixture-editions-next&amp;realm=${traversalRealm}`);
  expect(initial).toContain(
    `/subjects/${traversalSubjects.edition.id}/the-harbour-first-edition?realm=${traversalRealm}`,
  );

  const continued = await loadSubjectPage(client, canonical.value.id, 'editions', 'en', {
    realm: traversalRealm,
    continuation: { node: 'editions', cursor: 'fixture-editions-next' },
  });
  if (continued.kind !== 'page') throw new Error('Expected continued editions');
  const html = render(continued.page, 'work', 'editions');
  expect(html).toContain('Edition 15');
  expect(html).not.toContain('data-slot="continue-group"');
});

test('the independent-role story transport loads both native groups and continues each without requesting its sibling', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { loadSubjectPage } = await import('../src/features/pages/subject');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  expect((await loadSubject(client, traversalSubjects.creator.id, 'en')).kind).toBe('subject');
  const loaded = await loadViewPages(client, traversalSubjects.creator.id, 'works', 'en', undefined, {
    realm: traversalRealm,
  });
  if (loaded.kind !== 'page') throw new Error('Expected independent-role story page');
  const before = structuredClone(loaded.page);
  const initial = render(loaded.page, 'creator', 'works');
  expect(initial).toContain('author 12');
  expect(initial).toContain('illustrator 12');
  expect(group(loaded.page, 'author').result.body).toMatchObject({ count: { value: 15, exact: true } });
  expect(group(loaded.page, 'illustrator').result.body).not.toHaveProperty('count');
  for (const [node, sibling, last] of [
    ['author', 'illustrator', 'author 15'],
    ['illustrator', 'author', 'illustrator 14'],
  ] as const) {
    const continued = await loadSubjectPage(client, traversalSubjects.creator.id, 'works', 'en', {
      realm: traversalRealm,
      continuation: { node, cursor: `fixture-${node}-next` },
    });
    if (continued.kind !== 'page') throw new Error('Expected continued role');
    expect(group(continued.page, sibling).result.status).toBe(204);
    expect(group(continued.page, node).result.body).toMatchObject({ next: null });
    const html = render(continued.page, 'creator', 'works');
    expect(html).toContain(last);
    expect(html).toContain('Start again');
    const plan = planReads(
      platformRegistry,
      continued.page.document as CompositionDocument,
      pageContext(continued.page),
    );
    expect(Object.keys(plan.reads).length).toBeLessThanOrEqual(16);
    expect(Object.values(plan.reads).reduce((sum, read) => sum + readCost(read), 0)).toBeLessThanOrEqual(128);
  }
  expect(loaded.page).toEqual(before);
});

test('the role-conflict story transport keeps the page ready and scopes native cursor refusal to the author stream', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { loadSubjectPage } = await import('../src/features/pages/subject');
  const { m } = await import('../src/paraglide/messages.js');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  expect((await loadSubject(client, traversalSubjects.conflict.id, 'en')).kind).toBe('subject');
  const loaded = await loadViewPages(client, traversalSubjects.conflict.id, 'works', 'en', undefined, {
    realm: traversalRealm,
  });
  if (loaded.kind !== 'page') throw new Error('Expected ready role-conflict page');
  const initial = render(loaded.page, 'conflict', 'works');
  expect(initial).toContain('author 12');
  expect(initial).toContain('illustrator 12');
  const request = {
    subject: traversalSubjects.conflict.id,
    locale: 'en',
    view: 'works' as const,
    realm: traversalRealm,
    node: 'author',
    cursor: 'fixture-author-next',
  };
  expect(await readRelationGroup(client, request)).toEqual({ ok: false, status: 400 });
  const continued = await loadSubjectPage(client, request.subject, request.view, request.locale, {
    realm: request.realm,
    continuation: { node: request.node, cursor: request.cursor },
  });
  if (continued.kind !== 'page') throw new Error('Expected a refused leaf within the actual page');
  expect(group(continued.page, 'author').result).toEqual({ status: 400, body: { code: 'invalid_request' } });
  expect(group(continued.page, 'illustrator').result.status).toBe(204);
  expect(render(continued.page, 'conflict', 'works')).toContain(m.subject_relation_invalid());
  const illustrator = await readRelationGroup(client, {
    ...request,
    node: 'illustrator',
    cursor: 'fixture-illustrator-next',
  });
  if (!illustrator.ok) throw new Error('Expected independent illustrator continuation');
  expect(illustrator.body.links).toHaveLength(2);
  expect(illustrator.body.next).toBeNull();
});

test('the remaining edition story transports retain ready, hidden-target and genuinely unavailable relation states', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { loadSubjectPage } = await import('../src/features/pages/subject');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  for (const scenario of ['edition', 'hidden', 'unavailable'] as const) {
    expect((await loadSubject(client, traversalSubjects[scenario].id, 'en')).kind).toBe('subject');
    const loaded = await loadSubjectPage(client, traversalSubjects[scenario].id, undefined, 'en', {
      realm: traversalRealm,
    });
    if (loaded.kind !== 'page') throw new Error('Expected the actual edition story page');
    const html = render(loaded.page, scenario);
    const relation = group(loaded.page, 'edition-work').result;
    expect(relation.status).toBe(scenario === 'unavailable' ? 503 : 200);
    if (scenario === 'edition') {
      expect(html).toContain(`/subjects/${traversalSubjects.work.id}/the-harbour?realm=${traversalRealm}`);
    } else {
      expect(html).not.toContain(`/subjects/${traversalSubjects.work.id}`);
      const section = html.match(/<section\b[^>]*aria-labelledby="edition-work-title"[^>]*>/)?.[0];
      expect(section).toBeDefined();
      expect(section?.includes('data-state="failed"')).toBe(scenario === 'unavailable');
    }
  }
});

test('all seven current edition stories retain their own canonical subject and requested view before page loading', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { loadSubject } = await import('../src/subject/load-subject');
  const { canonicalRedirect, subjectUrlForView } = await import('../src/subject/subject-href');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  for (const [scenario, slug, view] of [
    ['edition', 'the-harbour-first-edition', undefined],
    ['work', 'the-harbour', undefined],
    ['work', 'the-harbour', 'editions'],
    ['creator', 'ada-harbour', 'works'],
    ['hidden', 'an-edition-with-an-unresolved-work', undefined],
    ['unavailable', 'an-edition-awaiting-its-source', undefined],
    ['conflict', 'ada-harbour', 'works'],
  ] as const) {
    const subject = traversalSubjects[scenario];
    const canonical = await loadSubject(client, subject.id, 'en');
    if (canonical.kind !== 'subject') throw new Error('Expected the current story subject');
    const base = `/en/subjects/${subject.id}/${slug}`;
    expect(canonical.value.id).toBe(subject.id);
    expect(canonical.value.href).toBe(base);
    expect(canonical.value.paths.en).toBe(base.slice(3));
    expect(canonicalRedirect(subjectUrlForView(canonical.value, view), `?realm=${traversalRealm}`).href).toBe(
      `${base}${view ? `/${view}` : ''}?realm=${traversalRealm}`,
    );
  }
});

test('only the declared traversal subjects have an empty verified-account story lookup', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { routes } = await import('../src/kernel/fake/accounts');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  for (const { id } of Object.values(traversalSubjects)) {
    const response = await client.accounts.get({ query: { agent: id } });
    expect(response.status).toBe(200);
    expect(response.data).toEqual({ accounts: [], next: null });
  }
  // Other selectors and identities still reach their existing account/alias fixtures and guards.
  for (const query of ['agent=another-subject', 'handle=mira', `ids=${traversalSubjects.creator.id}`, '']) {
    expect(
      await routes[0]!.story!({
        request: new Request(`http://kernel.local/v1/accounts?${query}`),
        recordings: {},
        match: null,
      }),
    ).toBeUndefined();
  }
});

test('the actual Work overview transport supplies its ready frame and twelve-edition preview in both responsive layouts', async () => {
  const { createStoryRecordedKernelFetch } = await import('../src/kernel/fake');
  const { loadSubjectPage } = await import('../src/features/pages/subject');
  const { subjectFrame } = await import('../src/features/pages/subject-frame');
  const client = createKernelClient('http://kernel.local', { fetch: createStoryRecordedKernelFetch() });
  const loaded = await loadSubjectPage(client, traversalSubjects.work.id, undefined, 'en', { realm: traversalRealm });
  if (loaded.kind !== 'page') throw new Error('Expected the actual Work overview');
  expect(subjectFrame(loaded.page, 'en')).toMatchObject({
    id: traversalSubjects.work.id,
    title: { text: traversalSubjects.work.label },
    context: '0192f3a0-6c1e-7b2a-9d4e-000000000921',
  });
  expect(loaded.page.context?.population).toEqual({ kind: 'realm', id: traversalRealm, title: 'Harbour readers' });
  expect(group(loaded.page, 'editions').result.body).toMatchObject({
    links: expect.arrayContaining([expect.objectContaining({ label: 'Edition 12' })]),
    count: { value: 15, exact: true },
    next: 'fixture-editions-next',
  });
  expect((group(loaded.page, 'editions').result.body as { links: unknown[] }).links).toHaveLength(12);
  const html = render(loaded.page, 'work');
  expect(html).toContain('data-layout="cover-row"');
  expect(html).toContain('data-layout="cover-grid"');
  expect(html).toContain('Edition 12');
  expect(html).not.toContain('Edition 13');
  expect(html).toContain(`/subjects/${traversalSubjects.work.id}/the-harbour/editions?realm=${traversalRealm}`);
});

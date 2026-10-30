import { expect, test } from 'bun:test';
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
import { SubjectPage, pageContext, pageRelationProperties, type SubjectPageData } from '../src/features/pages/subject';
import { subjectPageMessages } from '../src/features/pages/route-support';
import { subjectTabs } from '../src/features/pages/views';
import { readRelationGroup, relationGroupKey } from '../src/features/pages/relation-stream-query';
import { relationStreamItems } from '../src/features/pages/relation-stream';
import { loadViewPages } from '../src/features/pages/subject-frame';
import { statementItems, type OverviewValue } from '../src/features/pages/overview';
import { relationDefinitions } from '../src/subject/relations';
import { defaultReader } from '../src/subject/reader';
import {
  traversalPage,
  traversalSubjects,
  traversalRealm,
  traversalRelease,
  type TraversalScenario,
} from '../src/kernel/fake/edition-work';

const profile = profileJson as PresentationProfile;
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
    const input = {
      subject: traversalSubjects.creator.id,
      locale: 'en',
      view: 'works' as const,
      realm: traversalRealm,
      node,
      cursor: result.next,
    };
    const section = await readRelationGroup(client, input, 'Bearer current-viewer');
    expect(section.ok).toBe(true);
    if (!section.ok) throw new Error('Expected current role');
    expect(section.body.next).toBeNull();
    expect((section.body.links as unknown[]).length).toBe(node === 'author' ? 3 : 2);
    expect(seen.at(-1)?.body).toMatchObject({
      target: { subject: input.subject, view: 'works', realm: traversalRealm },
      continuation: { node, cursor: result.next },
    });
    expect(seen.at(-1)?.headers.get('authorization')).toBe('Bearer current-viewer');
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
});

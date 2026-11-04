import { expect, mock, test } from 'bun:test';
import { createElement } from 'react';
import { renderToStaticMarkup } from 'react-dom/server';
import type { FilterDocument } from '@rezics/filter';
import type { Related, Subject } from '../src/subject/types';
import recording from '../src/kernel/recorded/definitions-release.json';
import { conceptWorksAdmission } from '../src/features/catalogue/source-concept-explorer';
import {
  boundedConceptWorksState,
  conceptWorksExactEmpty,
  conceptWorksRequest,
  readConceptWorksPage,
} from '../src/features/catalogue/concept-works';
import type { DiscoveryState } from '../src/search/discovery';

const conceptId = '00000000-0000-4000-8000-000000000041';
const schemeId = '00000000-0000-4000-8000-000000000042';
const otherConceptId = '00000000-0000-4000-8000-000000000043';
const workId = '00000000-0000-4000-8000-000000000044';
const admission = conceptWorksAdmission(recording.release, true);
const schemes = [{ id: schemeId, label: 'Genre', lang: 'en', readable: true, conceptPage: true }];

function conceptLeaf(filter: FilterDocument): Extract<FilterDocument, { statement: unknown }> | undefined {
  if ('statement' in filter)
    return filter.statement.concept ? (filter as Extract<FilterDocument, { statement: unknown }>) : undefined;
  if ('and' in filter || 'or' in filter) {
    for (const child of 'and' in filter ? filter.and : filter.or) {
      const found = conceptLeaf(child);
      if (found) return found;
    }
  }
  return 'not' in filter ? conceptLeaf(filter.not) : undefined;
}

const additional: FilterDocument = {
  and: [
    { not: { statement: { property: 'schema:wordCount', range: { gte: 100, unit: '1' } } } },
    {
      statement: {
        property: 'schema:keywords',
        in: [otherConceptId],
        qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      },
    },
  ],
};

mock.module('cloudflare:workers', () => ({ env: {} }));

test('a disclosed work tag opens the mounted Concept host with its released role, same-statement spoiler and work return', async () => {
  const { SubjectConceptTags } = await import('../src/features/pages/subject-slots');
  const subject = {
    id: workId,
    type: 'schema:Book',
    revision: 1,
    release: 'sha256:recorded',
    context: workId,
    labels: { en: 'A novel' },
    aliases: {},
    descriptions: {},
    statements: {
      'schema:genre': [
        {
          id: 'genre-statement',
          rank: 'normal',
          property: { id: 'schema:genre', data_type: 'wikibase-item' },
          value: { type: 'value', content: conceptId },
          qualifiers: [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+1', unit: '1' } },
            },
          ],
          references: [],
        },
      ],
    },
  } as unknown as Subject;
  const related = {
    [conceptId]: { id: conceptId, type: 'skos:Concept', labels: { en: 'Fantasy' } },
  } as unknown as Related;
  const markup = renderToStaticMarkup(
    createElement(SubjectConceptTags, {
      subject,
      related,
      definitions: recording.release,
      locale: 'en',
      spoilerThreshold: 1,
    }),
  );
  const href = /href="([^"]+)"/.exec(markup)?.[1]?.replaceAll('&amp;', '&');
  if (!href) throw new Error('Expected a readable Concept tag link');
  const address = new URL(href, 'https://rezics.test');
  expect(address.pathname).toContain(`/subjects/${conceptId}/`);
  expect(address.pathname).toEndWith('/concepts');
  expect(address.searchParams.get('role')).toBe('schema:genre');
  expect(address.searchParams.get('returnTo')).toContain(`/subjects/${workId}/`);
  expect(address.searchParams.get('tagQualifiers')).toBe(
    JSON.stringify([{ property: 'rezics:spoilerLevel', in: ['1'] }]),
  );
});

test('builds one admitted Concept statement with exact role, scheme, descendants, spoiler qualifier, type and Boolean conditions', () => {
  expect(admission.state).toBe('available');
  if (admission.state !== 'available') return;
  expect(
    admission.properties.some((property) => property.id === 'schema:genre' && property.types.includes('schema:Book')),
  ).toBe(true);

  const request = conceptWorksRequest(
    {
      conceptId,
      property: 'schema:genre',
      scheme: schemeId,
      type: 'schema:Book',
      spoilerThreshold: 2,
      qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
      condition: additional,
    },
    admission,
    schemes,
    'en',
  );
  expect(request?.limit).toBe(24);
  expect(request?.spoilerThreshold).toBe(2);
  expect(request?.filter).toEqual({
    and: [
      {
        and: [
          { type: { in: ['schema:Book'] } },
          {
            statement: {
              property: 'schema:genre',
              in: [conceptId],
              concept: { scheme: schemeId },
              qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
            },
          },
          additional,
        ],
      },
      { kind: { in: ['subject'] } },
    ],
  });

  const descendants = conceptWorksRequest(
    { conceptId, property: 'schema:genre', scheme: schemeId, includeChildren: true },
    admission,
    schemes,
    'en',
  );
  const leaf = descendants?.filter ? conceptLeaf(descendants.filter as FilterDocument) : undefined;
  expect(leaf?.statement.concept).toEqual({ scheme: schemeId, includeChildren: true });
  expect(
    conceptWorksRequest({ conceptId, property: 'schema:genre', scheme: schemeId }, admission, [], 'en'),
  ).toBeUndefined();
  expect(
    conceptWorksRequest({ conceptId, property: 'schema:unsupported', scheme: schemeId }, admission, schemes, 'en'),
  ).toBeUndefined();
});

test('retains at most 24 rows and issues one bounded Search dispatch without detail reads', async () => {
  const request = conceptWorksRequest(
    { conceptId, property: 'schema:genre', scheme: schemeId, type: 'schema:Book' },
    admission,
    schemes,
    'en',
  );
  if (!request) throw new Error('Recorded release must admit Book genre tags');

  const retained = boundedConceptWorksState({
    status: 'ready',
    page: { hits: Array.from({ length: 24 }, () => ({})), next: null, freshness: { state: 'current' } },
  } as unknown as DiscoveryState);
  expect(retained.status).toBe('ready');
  for (const size of [64, 512, 4096]) {
    expect(
      boundedConceptWorksState({
        status: 'ready',
        page: { hits: Array.from({ length: size }, () => ({})), next: null, freshness: { state: 'current' } },
      } as unknown as DiscoveryState).status,
    ).toBe('unavailable');
  }

  const dispatches: unknown[] = [];
  const state = await readConceptWorksPage(request, async (body) => {
    dispatches.push(body);
    return { status: 503, data: { code: 'semantic_not_ready' } } as never;
  });
  expect(dispatches).toEqual([request]);
  expect(JSON.stringify(request).length).toBeLessThanOrEqual(65_536);
  expect(state.status).toBe('not-ready');
});

test('distinguishes exact empty from lagging empty and offers restart for an invalid cursor without scanning', async () => {
  const exact = {
    status: 'ready',
    page: { hits: [], next: null, freshness: { state: 'current' } },
  } as unknown as DiscoveryState;
  const lagging = {
    status: 'ready',
    page: { hits: [], next: 'opaque-next', freshness: { state: 'catching-up' } },
  } as unknown as DiscoveryState;
  expect(conceptWorksExactEmpty(exact)).toBe(true);
  expect(conceptWorksExactEmpty(lagging)).toBe(false);

  const request = conceptWorksRequest(
    { conceptId, property: 'schema:genre', scheme: schemeId, type: 'schema:Book', cursor: 'opaque-current' },
    admission,
    schemes,
    'en',
  );
  if (!request) throw new Error('Recorded release must admit Book genre tags');
  const dispatches: unknown[] = [];
  const state = await readConceptWorksPage(request, async (body) => {
    dispatches.push(body);
    return { status: 409, error: { code: 'search_restart_required' } };
  });
  expect(dispatches).toHaveLength(1);
  expect((dispatches[0] as { cursor?: string }).cursor).toBe('opaque-current');
  expect(state.status).toBe('restart');
});

test('work-tag visits keep the supported original window and focus while the destination consumes only its native role and qualifiers', async () => {
  const { workTagReturnHref, workTagReturn, workTagOriginatingReturn, subjectVisitReturn } =
    await import('../src/features/pages/subject-visit-navigation');
  const { originatingConceptReturn, originatingReturn } =
    await import('../src/features/pages/source-concept-reading/origin');
  const { SubjectConceptTags } = await import('../src/features/pages/subject-slots');
  const source = `/en/subjects/${workId}/novel/relations?realm=${schemeId}&node=tags&cursor=opaque%2Fpage&property=schema%3Agenre#connections`;
  const selection = {
    statement: otherConceptId,
    property: 'schema:genre',
    spoiler: 1 as const,
    focus: 'evidence' as const,
  };
  const returned = workTagReturnHref(source, `/en/subjects/${workId}/novel`, 'en', selection);
  expect(returned.split('#')[0]).toBe(source.split('#')[0]);
  expect(workTagReturn(new URL(returned, 'https://site.test').hash)).toEqual(selection);
  expect(originatingConceptReturn(returned, 'en')).toBe(returned);
  expect(subjectVisitReturn(returned, 'en')).toBe(returned);
  expect(originatingReturn(returned)).toBeUndefined();
  expect(workTagOriginatingReturn(returned, 'ja')).toBeUndefined();
  expect(originatingConceptReturn('https://elsewhere.test/work', 'en')).toBeUndefined();
  expect(originatingConceptReturn(returned + '&focus=browse', 'en')).toBeUndefined();
  const restart = workTagReturnHref(
    '/en/subjects/invalid/name?cursor=lost',
    `/en/subjects/${workId}/novel`,
    'en',
    selection,
  );
  expect(restart).toBe(`/en/subjects/${workId}/novel#work-tags?${new URLSearchParams({ ...selection, spoiler: '1' })}`);

  const subject = {
    id: workId,
    type: 'schema:Book',
    labels: { en: 'A novel' },
    statements: {
      'schema:genre': [
        {
          id: otherConceptId,
          property: { id: 'schema:genre', data_type: 'wikibase-item' },
          rank: 'normal',
          value: { type: 'value', content: conceptId },
          qualifiers: [
            {
              property: { id: 'rezics:spoilerLevel', data_type: 'quantity' },
              value: { type: 'value', content: { amount: '+1', unit: '1' } },
            },
          ],
          references: [],
        },
      ],
    },
  } as unknown as Subject;
  const html = renderToStaticMarkup(
    createElement(SubjectConceptTags, {
      subject,
      related: {
        [conceptId]: { type: 'skos:Concept', labels: { en: 'Fantasy' }, redirect: schemeId },
      } as unknown as Related,
      locale: 'en',
      definitions: recording.release,
      spoilerThreshold: 1,
      currentHref: source,
    }),
  );
  const href = /href="([^"]+)"/.exec(html)![1]!.replaceAll('&amp;', '&');
  const address = new URL(href, 'https://site.test');
  expect(address.pathname).toContain(conceptId);
  expect(address.pathname).not.toContain(schemeId);
  expect([...address.searchParams.keys()]).toEqual(['role', 'returnTo', 'tagQualifiers', 'spoiler']);
  const query = address.searchParams;
  const request = conceptWorksRequest(
    {
      conceptId,
      property: query.get('role')!,
      scheme: schemeId,
      qualifiers: JSON.parse(query.get('tagQualifiers')!),
      spoilerThreshold: 1,
    },
    admission,
    schemes,
    'en',
  );
  expect(request?.spoilerThreshold).toBe(1);
  expect(conceptLeaf(request!.filter as FilterDocument)?.statement).toMatchObject({
    property: 'schema:genre',
    in: [conceptId],
    qualifiers: [{ property: 'rezics:spoilerLevel', in: ['1'] }],
  });
  expect(originatingConceptReturn(query.get('returnTo'), 'en')?.split('#')[0]).toBe(source.split('#')[0]);
  expect(JSON.stringify(request)).not.toContain('opaque/page');
  expect(JSON.stringify(request)).not.toContain('returnTo');
});

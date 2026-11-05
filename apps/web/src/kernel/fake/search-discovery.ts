import { parseLegacySearchPage, type DiscoveryPage } from '../../search/discovery';
import type { FakeRoute } from '../fake-modules';
import typedSearch from '../recorded/search-typed.json';
import { chosenLabels, isRecord } from './languages';

const sameId = '00000000-0000-4000-8000-000000000811';
const handlelessId = '00000000-0000-4000-8000-000000000812';
const bookId = '00000000-0000-4000-8000-000000000813';

/** Explicit UI fixtures for the adopted wire, not recordings or evidence of native readiness. */
export const discoveryExample: DiscoveryPage = {
  hits: [
    {
      key: { owner: 'semantic', kind: 'schema:Person', route: 0, id: sameId },
      matchEvidence: { state: 'unavailable' },
      summary: {
        kind: 'subject',
        value: {
          id: sameId,
          type: 'schema:Person',
          types: ['schema:Person'],
          label: { value: 'Mira', language: 'en' },
          creativeWork: false,
          cover: null,
        },
      },
    },
    {
      key: { owner: 'accounts', kind: 'account', route: 0, id: sameId },
      matchEvidence: { state: 'unsupported' },
      summary: {
        kind: 'account',
        value: {
          id: sameId,
          accountKind: 'actor',
          handle: 'mira',
          displayName: 'Mira',
          automated: false,
          operatorId: null,
          avatar: null,
          verifiedAgent: { id: sameId, label: 'Mira', type: 'schema:Person' },
        },
      },
    },
    {
      key: { owner: 'accounts', kind: 'account', route: 0, id: handlelessId },
      matchEvidence: { state: 'unsupported' },
      summary: {
        kind: 'account',
        value: {
          id: handlelessId,
          accountKind: 'organization',
          handle: null,
          displayName: 'Mira Reading Room',
          automated: false,
          operatorId: null,
          avatar: null,
          verifiedAgent: null,
        },
      },
    },
    {
      key: { owner: 'semantic', kind: 'schema:Book', route: 0, id: bookId },
      matchEvidence: { state: 'unavailable' },
      summary: {
        kind: 'subject',
        value: {
          id: bookId,
          type: 'schema:Book',
          types: ['schema:Book', 'schema:CreativeWork'],
          label: { value: 'Mira’s Atlas', language: 'en' },
          creativeWork: true,
          cover: null,
        },
      },
    },
  ],
  kinds: {
    values: [
      { id: 'schema:Person', labels: { en: 'Person', 'zh-Hans': '人物', 'zh-Hant': '人物' }, icon: 'person' },
      { id: 'account', labels: { en: 'Account', 'zh-Hans': '帐号', 'zh-Hant': '帳號' }, icon: 'account' },
      { id: 'schema:Book', labels: { en: 'Book', 'zh-Hans': '图书', 'zh-Hant': '圖書' }, icon: 'book' },
    ],
    next: null,
  },
  next: null,
  as_of: '2026-10-31T00:00:00Z',
};

/** Recorded public content in the illustrative discovery wire, not a native mixed-search recording. */
export function typedSearchDiscoveryExample(languages: readonly string[]): DiscoveryPage {
  const recorded = parseLegacySearchPage(typedSearch);
  if (!recorded) throw new Error('The typed Search recording is invalid.');
  return {
    hits: recorded.subjects.map(({ id, type, summary, labels, descriptions, facts, matchEvidence }) => {
      if (
        !summary ||
        !summary.label ||
        summary.id !== id ||
        summary.type !== type ||
        !/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(id)
      )
        throw new Error('The typed Search recording needs its complete native Subject identity and summary.');
      const selected = languages.length ? chosenLabels(labels, languages, summary.label.language) : labels;
      const language = Object.keys(selected)[0] ?? summary.label.language;
      return {
        // Catalogue kinds belong to Semantic (search/discovery-registry.ts). The native UUID
        // carries its route in bytes 10–11 (route/route.ts); it is not the example cast's route 0.
        key: { owner: 'semantic', kind: type, route: Number.parseInt(id.slice(24, 28), 16), id },
        summary: {
          kind: 'subject',
          value: { ...summary, label: languages.length ? { value: selected[language]!, language } : summary.label },
        },
        matchEvidence: matchEvidence ?? { state: 'unavailable' as const },
        labels: selected,
        ...(descriptions
          ? {
              descriptions: languages.length
                ? chosenLabels(descriptions, languages, summary.label.language)
                : descriptions,
            }
          : {}),
        ...(facts ? { facts } : {}),
      };
    }),
    kinds: {
      values: discoveryExample.kinds.values
        .filter(({ id }) => id === typedSearch.filterType)
        .map((kind) => ({ ...kind, labels: languages.length ? chosenLabels(kind.labels, languages) : kind.labels })),
      next: null,
    },
    next: typedSearch.next,
    as_of: typedSearch.as_of,
  };
}

export function currentLinkRefusal(): DiscoveryPage {
  const result = structuredClone(discoveryExample);
  result.hits = result.hits
    .filter((hit) => hit.summary.kind === 'account')
    .map<DiscoveryPage['hits'][number]>((hit) => {
      if (hit.summary.kind !== 'account' || hit.key.owner !== 'accounts') return hit;
      return {
        key: hit.key,
        matchEvidence: { state: 'unsupported' },
        summary: { ...hit.summary, value: { ...hit.summary.value, handle: null, verifiedAgent: null } },
      };
    });
  return result;
}

/** Presentation-only examples, explicitly separate from native readiness evidence. */
export function factualDiscoveryExample(): DiscoveryPage {
  const result = structuredClone(discoveryExample);
  result.hits.push({
    key: { owner: 'semantic', kind: 'catalogue:Atlas', route: 0, id: '00000000-0000-4000-8000-000000000814' },
    matchEvidence: { state: 'unavailable' },
    summary: {
      kind: 'subject',
      value: {
        id: '00000000-0000-4000-8000-000000000814',
        type: 'catalogue:Atlas',
        types: ['catalogue:Atlas'],
        label: { value: 'Mira Star Atlas', language: 'en' },
        creativeWork: true,
        cover: null,
      },
    },
    labels: { en: 'Mira Star Atlas' },
    aliases: { en: ['Maps of Mira'] },
    descriptions: { en: 'An atlas of nearby stars.' },
    facts: {
      'schema:author': [{ kind: 'item', id: sameId, labels: { en: 'Mira' } }],
      'schema:datePublished': [{ kind: 'time', year: 2026 }],
    },
    figure: {
      questionId: '00000000-0000-7000-8000-000000000001',
      populationId: '00000000-0000-8000-8000-000000000000',
      scale: { min: 0, max: 100, displayStep: 1 },
      count: 12,
      state: 'ready',
      mean: 8,
      score: 7.8,
    },
    listPresentation: { imageAspect: 'landscape', keyFacts: ['schema:author', 'schema:datePublished'] },
  });
  result.kinds.values[0]!.count = { kind: 'schema:Person', value: 1, exact: false };
  result.kinds.values[1]!.count = { kind: 'account', value: 2, exact: true };
  result.kinds.values.push({
    id: 'schema:Event',
    labels: { en: 'Event' },
    icon: 'calendar',
    count: { kind: 'schema:Event', value: 0, exact: true },
  });
  result.kinds.next = 'opaque-kind-page+/=';
  return result;
}

export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/subjects:search',
    story: async ({ request }) => {
      const body: unknown = await request
        .clone()
        .json()
        .catch(() => undefined);
      if (!isRecord(body) || body.representation !== 'discovery-v1') return;
      if (isRecord(body.kindPage) && body.kindPage.cursor === 'opaque-kind-page+/=')
        return {
          status: 200,
          kinds: { values: [{ id: 'catalogue:Atlas', labels: { en: 'Atlas' }, icon: 'map' }], next: null },
          as_of: discoveryExample.as_of,
        };
      if (body.text === 'Mira facts') return { status: 200, ...factualDiscoveryExample() };
      if (body.text === 'Mira continued') {
        const result = structuredClone(discoveryExample);
        result.hits = body.cursor ? result.hits.slice(1) : result.hits.slice(0, 1);
        result.next = body.cursor ? null : 'opaque-hits-page+/=';
        return { status: 200, ...result };
      }
      if (body.text === 'Mira restart' && body.cursor) return { status: 409, code: 'search_restart_required' };
      if (body.text === 'Mira restart') return { status: 200, ...structuredClone(discoveryExample) };
      if (body.text === 'Mira closed') return { status: 403, code: 'platform_closed' };
      if (body.text === 'Mira') return { status: 200, ...structuredClone(discoveryExample) };
      if (body.text === 'Mira empty') return { status: 200, ...structuredClone(discoveryExample), hits: [] };
      if (body.text === 'Mira unavailable') return { status: 503, code: 'unavailable' };
      if (body.text === 'Mira preparing') return { status: 503, code: 'index_not_ready' };
      if (body.text === 'Mira current') return { status: 200, ...currentLinkRefusal() };
    },
  },
];

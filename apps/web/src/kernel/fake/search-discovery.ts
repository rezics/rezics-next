import type { DiscoveryPage } from '../../search/discovery';
import type { FakeRoute } from '../fake-modules';
import { isRecord } from './languages';

const sameId = '00000000-0000-4000-8000-000000000811';
const handlelessId = '00000000-0000-4000-8000-000000000812';
const bookId = '00000000-0000-4000-8000-000000000813';

/** Explicit UI fixtures for the adopted wire, not recordings or evidence of native readiness. */
export const discoveryExample: DiscoveryPage = {
  hits: [
    {
      key: { owner: 'semantic', kind: 'schema:Person', route: 0, id: sameId },
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

export function currentLinkRefusal(): DiscoveryPage {
  const result = structuredClone(discoveryExample);
  result.hits = result.hits
    .filter((hit) => hit.summary.kind === 'account')
    .map<DiscoveryPage['hits'][number]>((hit) => {
      if (hit.summary.kind !== 'account' || hit.key.owner !== 'accounts') return hit;
      return {
        key: hit.key,
        summary: { ...hit.summary, value: { ...hit.summary.value, handle: null, verifiedAgent: null } },
      };
    });
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
      if (body.text === 'Mira') return { status: 200, ...structuredClone(discoveryExample) };
      if (body.text === 'Mira empty') return { status: 200, ...structuredClone(discoveryExample), hits: [] };
      if (body.text === 'Mira unavailable') return { status: 503, code: 'unavailable' };
      if (body.text === 'Mira preparing') return { status: 503, code: 'index_not_ready' };
      if (body.text === 'Mira current') return { status: 200, ...currentLinkRefusal() };
    },
  },
];

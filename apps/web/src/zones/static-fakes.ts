import type { ZonePageResponse } from '../../../../services/kernel/src/zones/contract.ts';
import subject from '../kernel/recorded/subject.json';
import subjectPage from '../kernel/recorded/subject-page.json';
import { slug } from '@rezics/definitions/slug';

/** Contract-shaped story data, not a recording or evidence of native Zone authorization. */
export const staticZoneHomeFake = {
  profile: subjectPage.profile,
  template: { scope: 'route', key: '' },
  document: {
    root: { props: {} },
    content: [
      {
        type: 'Heading',
        props: {
          id: 'zone-title',
          level: 1,
          text: {
            en: 'Field Notes',
            'zh-Hant': '田野筆記',
            'zh-Hans': '田野札记',
            ja: 'フィールドノート',
            ko: '현장 노트',
            de: 'Feldnotizen',
            fr: 'Notes de terrain',
            es: 'Notas de campo',
          },
        },
      },
      {
        type: 'Text',
        props: {
          id: 'zone-copy',
          text: {
            en: 'A public page from the native Zone configuration.',
            'zh-Hant': '原生區域頁面內容。',
            'zh-Hans': '原生区域页面内容。',
            ja: 'ネイティブなゾーンページです。',
            ko: '네이티브 구역 페이지입니다.',
            de: 'Eine native Zone-Seite.',
            fr: 'Une page Zone native.',
            es: 'Una página Zone nativa.',
          },
        },
      },
      {
        type: 'LinkGrid',
        props: {
          id: 'featured-subject',
          links: [
            {
              href: `/subjects/${subject.subject.id}/${slug(subject.subject.labels.en)}`,
              label: subject.subject.labels,
            },
          ],
        },
      },
    ],
  },
  reads: {},
  zone: {
    id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e11',
    revision: '1',
    labels: {
      en: 'Field Notes',
      'zh-Hant': '田野筆記',
      'zh-Hans': '田野札记',
      ja: 'フィールドノート',
      ko: '현장 노트',
      de: 'Feldnotizen',
      fr: 'Notes de terrain',
      es: 'Notas de campo',
    },
    visibility: 'public',
    appearance: { density: 'compact', radius: 'sm', surface: 'cards', cover: 'square', headingScale: 'lg' },
    navigation: [{ route: '' }, { route: 'guide' }],
  },
} satisfies ZonePageResponse;

export const staticZoneGuideFake = {
  ...staticZoneHomeFake,
  template: { scope: 'route', key: 'guide' },
  document: {
    root: { props: { appearance: { density: 'comfortable', radius: 'md', surface: 'cards' } } },
    content: [
      {
        type: 'Heading',
        props: {
          id: 'guide-title',
          level: 1,
          text: {
            en: 'Guide',
            'zh-Hant': '指南',
            'zh-Hans': '指南',
            ja: 'ガイド',
            ko: '안내',
            de: 'Leitfaden',
            fr: 'Guide',
            es: 'Guía',
          },
        },
      },
      {
        type: 'Text',
        props: {
          id: 'guide-copy',
          text: {
            en: 'A second declared static page.',
            'zh-Hant': '另一個已設定的靜態頁面。',
            'zh-Hans': '另一个已配置的静态页面。',
            ja: 'もう一つの静的ページです。',
            ko: '또 다른 정적 페이지입니다.',
            de: 'Eine weitere statische Seite.',
            fr: 'Une autre page statique.',
            es: 'Otra página estática.',
          },
        },
      },
    ],
  },
} satisfies ZonePageResponse;

const bookSummary = {
  id: subject.subject.id,
  type: 'schema:Book',
  types: ['schema:Book', 'schema:CreativeWork', 'schema:Thing'],
  label: { value: subject.subject.labels.en, language: 'en' },
  creativeWork: true,
  cover: null,
};

const typeListTitles = {
  en: 'Books',
  'zh-Hant': '書籍',
  'zh-Hans': '书籍',
  ja: '本',
  ko: '책',
  de: 'Bücher',
  fr: 'Livres',
  es: 'Libros',
};

/** Native ordered members for a routed Zone TypeList, including an overlapping duplicate id. */
export const composedZoneMembersFake = {
  ...staticZoneHomeFake,
  zone: { ...staticZoneHomeFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e13', revision: '4' },
  document: {
    root: { props: { appearance: { cover: 'portrait' } } },
    content: [
      {
        type: 'TypeList',
        props: {
          id: 'books',
          title: typeListTitles,
          types: ['schema:Book'],
          sort: 'name',
          limit: 12,
          paged: true,
        },
      },
    ],
  },
  reads: {
    r0: {
      status: 200,
      body: {
        subjects: [
          {
            id: subject.subject.id,
            type: 'schema:Book',
            labels: subject.subject.labels,
            summary: bookSummary,
          },
          {
            id: subject.subject.id,
            type: 'schema:Book',
            labels: subject.subject.labels,
            summary: bookSummary,
          },
        ],
        next: 'next_members-2',
      },
    },
  },
} satisfies ZonePageResponse;

export const composedZonePrivateMountFake = {
  ...composedZoneMembersFake,
  zone: { ...composedZoneMembersFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e14', visibility: 'private' },
} satisfies ZonePageResponse;

/** Empty current window with a later native continuation. */
export const composedZoneSparseFake = {
  ...composedZoneMembersFake,
  zone: { ...composedZoneMembersFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e15', revision: '6' },
  reads: {
    r0: {
      status: 200,
      body: { subjects: [], next: 'next_sparse-2' },
    },
  },
} satisfies ZonePageResponse;

/** Exhausted TypeList window: empty members and no continuation. */
export const composedZoneEmptyFake = {
  ...composedZoneMembersFake,
  zone: { ...composedZoneMembersFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e16', revision: '7' },
  reads: {
    r0: {
      status: 200,
      body: { subjects: [], next: null },
    },
  },
} satisfies ZonePageResponse;

export const staticZoneOwnerFake = {
  ...staticZoneHomeFake,
  zone: { ...staticZoneHomeFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e12', visibility: 'private' },
  document: {
    root: { props: {} },
    content: [{ type: 'Text', props: { id: 'private-copy', text: 'PRIVATE-ZONE-STATIC-CONTENT' } }],
  },
} satisfies ZonePageResponse;

import type { ZonePageResponse } from './appearance.ts';
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
      {
        type: 'TypeList',
        props: {
          id: 'books',
          title: {
            en: 'Books',
            'zh-Hant': '書籍',
            'zh-Hans': '书籍',
            ja: '本',
            ko: '책',
            de: 'Bücher',
            fr: 'Livres',
            es: 'Libros',
          },
          types: ['schema:Book'],
          sort: 'name',
          limit: 12,
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
            summary: null,
          },
        ],
        next: 'opaque-native-cursor',
      },
    },
  },
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

const tideglassLabels = {
  en: 'Tideglass Atlas',
  'zh-Hant': '潮璃地圖集',
  'zh-Hans': '潮璃地图集',
  ja: '潮ガラスの地図帳',
  ko: '물결 유리 지도책',
  de: 'Tideglas-Atlas',
  fr: 'Atlas de verre marin',
  es: 'Atlas de cristal de marea',
};

/** Fictional configured pages with no planned source reads; these are not a launch roster. */
export const configuredStaticZoneHomeFake = {
  profile: 'sha256:configured-static-zone',
  template: { scope: 'route', key: '' },
  document: {
    root: { props: {} },
    content: [
      {
        type: 'Heading',
        props: { id: 'tideglass-title', level: 1, text: tideglassLabels },
      },
      {
        type: 'Text',
        props: {
          id: 'tideglass-intro',
          text: {
            en: 'A pocket atlas of imagined islands, their weather, and the paths between them.',
            'zh-Hant': '一本袖珍地圖集，描繪想像中的島嶼、天氣，以及島嶼之間的路徑。',
            'zh-Hans': '一本袖珍地图集，描绘想象中的岛屿、天气，以及岛屿之间的路径。',
            ja: '想像上の島々や天気、島々を結ぶ道を記した小さな地図帳です。',
            ko: '상상 속의 섬과 날씨, 섬 사이의 길을 담은 작은 지도책입니다.',
            de: 'Ein Taschenatlas mit erdachten Inseln, ihrem Wetter und den Wegen dazwischen.',
            fr: 'Un atlas de poche des îles imaginaires, de leur météo et des chemins qui les relient.',
            es: 'Un atlas de bolsillo de islas imaginarias, su clima y los caminos que las conectan.',
          },
        },
      },
    ],
  },
  reads: {},
  zone: {
    id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1b',
    revision: '1',
    labels: tideglassLabels,
    visibility: 'public',
    appearance: { density: 'comfortable', radius: 'md', surface: 'cards', cover: 'square', headingScale: 'md' },
    navigation: [{ route: '' }, { route: 'guide' }],
  },
} satisfies ZonePageResponse;

export const configuredStaticZoneGuideFake = {
  ...configuredStaticZoneHomeFake,
  template: { scope: 'route', key: 'guide' },
  document: {
    root: { props: {} },
    content: [
      {
        type: 'Heading',
        props: {
          id: 'tideglass-guide-title',
          level: 1,
          text: {
            en: 'Reading the atlas',
            'zh-Hant': '閱讀地圖集',
            'zh-Hans': '阅读地图集',
            ja: '地図帳の読み方',
            ko: '지도책 읽기',
            de: 'Den Atlas lesen',
            fr: "Lire l'atlas",
            es: 'Cómo leer el atlas',
          },
        },
      },
      {
        type: 'Text',
        props: {
          id: 'tideglass-guide-copy',
          text: {
            en: 'Read each island from shore inward; dotted routes mark crossings we have only sketched.',
            'zh-Hant': '從海岸向內閱讀每座島；虛線路徑代表仍在草圖中的航線。',
            'zh-Hans': '从海岸向内阅读每座岛；虚线路径代表仍在草图中的航线。',
            ja: '島は海岸から内陸へ読み進めます。点線はまだ構想中の航路です。',
            ko: '각 섬은 해안에서 안쪽으로 읽습니다. 점선은 아직 구상 중인 항로입니다.',
            de: 'Lies jede Insel von der Küste nach innen; gestrichelte Routen sind erst skizziert.',
            fr: "Parcourez chaque île depuis la côte; les pointillés indiquent des traversées encore esquissées.",
            es: 'Lee cada isla desde la costa; las rutas punteadas son cruces aún esbozados.',
          },
        },
      },
    ],
  },
} satisfies ZonePageResponse;

const quietCabinetLabels = {
  en: 'Quiet Cabinet',
  'zh-Hant': '靜謐收藏室',
  'zh-Hans': '静谧收藏室',
  ja: '静かな書架',
  ko: '고요한 서가',
  de: 'Stilles Kabinett',
  fr: 'Cabinet tranquille',
  es: 'Gabinete sereno',
};

/** A valid routed document with no blocks and no source reads. */
export const configuredStaticEmptyFake = {
  profile: 'sha256:configured-static-empty',
  template: { scope: 'route', key: '' },
  document: { root: { props: {} }, content: [] },
  reads: {},
  zone: {
    id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1c',
    revision: '1',
    labels: quietCabinetLabels,
    visibility: 'public',
    appearance: { density: 'comfortable', radius: 'md', surface: 'cards' },
    navigation: [{ route: '' }],
  },
} satisfies ZonePageResponse;

/** Private counterpart used to verify that an anonymous route keeps the missing response. */
export const configuredStaticZonePrivateFake = {
  ...configuredStaticZoneHomeFake,
  zone: {
    ...configuredStaticZoneHomeFake.zone,
    id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1d',
    visibility: 'private',
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

const collectionId = '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e18';

/** Native ordered Collection members with an overlapping alias id, projected onto Members. */
export const composedZoneCollectionFake = {
  ...composedZoneMembersFake,
  zone: { ...composedZoneMembersFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e17', revision: '8' },
  document: {
    root: { props: {} },
    content: [
      {
        type: 'Members',
        props: {
          id: 'mounted',
          title: typeListTitles,
          source: { kind: 'collection', id: collectionId },
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
        members: [
          { kind: 'dynamic', subjectId: subject.subject.id, summary: bookSummary },
          { kind: 'dynamic', subjectId: subject.subject.id, summary: bookSummary },
        ],
        next: 'next_collection-2',
      },
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

const withheldId = '01a17a3b-0884-721b-91ef-d7ffd7bb58e5';

/** Native membership with a withheld summary: the locator stays, facts are not invented. */
export const composedZoneWithheldFake = {
  ...composedZoneMembersFake,
  zone: { ...composedZoneMembersFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e19', revision: '9' },
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
            id: withheldId,
            type: 'schema:Book',
            labels: { en: 'Withheld work' },
            summary: null,
          },
        ],
        next: null,
      },
    },
  },
} satisfies ZonePageResponse;

export const composedZoneAlicePrivateFake = {
  ...composedZonePrivateMountFake,
  zone: { ...composedZonePrivateMountFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1a', revision: '10' },
} satisfies ZonePageResponse;

export const composedZoneEditorFake = {
  ...composedZoneMembersFake,
  zone: { ...composedZoneMembersFake.zone, id: '0192f3a0-6c1e-7b2a-9d4e-1a2b3c4d5e1b', revision: '11' },
} satisfies ZonePageResponse;

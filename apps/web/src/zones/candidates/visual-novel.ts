import type { CompositionDocument } from '@rezics/composition';
import type { ZonePageResponse, ZonePublic } from '../appearance';

export const visualNovelZoneIds = {
  preview: '0193c000-0008-7000-8000-000000000000',
  empty: '0193c000-0008-7000-8000-000000000001',
  sparse: '0193c000-0008-7000-8000-000000000002',
  closed: '0193c000-0008-7000-8000-000000000003',
  unavailable: '0193c000-0008-7000-8000-000000000004',
  private: '0193c000-0008-7000-8000-000000000005',
  missing: '0193c000-0008-7000-8000-000000000006',
} as const;

const labels = {
  en: 'Visual novels',
  'zh-Hant': '視覺小說',
  'zh-Hans': '视觉小说',
  ja: 'ビジュアルノベル',
  ko: '비주얼 노벨',
  de: 'Visual Novels',
  fr: 'Visual novels',
  es: 'Novelas visuales',
};

const listTitle = {
  en: 'All visual novels',
  'zh-Hant': '全部視覺小說',
  'zh-Hans': '所有视觉小说',
  ja: 'すべてのビジュアルノベル',
  ko: '모든 비주얼 노벨',
  de: 'Alle Visual Novels',
  fr: 'Tous les visual novels',
  es: 'Todas las novelas visuales',
};

type CompositionNode = { type: string; props: Record<string, unknown> };

function heading(text: string): CompositionNode {
  return { type: 'Heading', props: { id: 'title', text, level: 2 } };
}

function paragraph(id: string, text: string): CompositionNode {
  return { type: 'Text', props: { id, text } };
}

function slot(id: string): CompositionNode {
  return { type: 'Slot', props: { id, name: id, children: [] } };
}

function homeDocument(intro: string, notes: string[]): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'page',
          gap: 'md',
          children: [
            heading('Visual novels'),
            paragraph('intro', intro),
            paragraph('preview-label', 'Development preview · deferred'),
            {
              type: 'TypeList',
              props: {
                id: 'works',
                title: listTitle,
                types: ['wd:Q689445'],
                sort: 'name',
                limit: 24,
              },
            },
            ...notes.map((note, index) => paragraph(`example-${index + 1}`, note)),
            slot('hero'),
            slot('entity'),
            slot('aside'),
            slot('footer'),
          ],
        },
      },
    ],
  } as unknown as CompositionDocument;
}

function releasesDocument(): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'page',
          gap: 'md',
          children: [
            heading('Releases'),
            paragraph(
              'intro',
              'This route is a static development preview. It has no release feed, publication dates, or producer roster.',
            ),
            paragraph(
              'return',
              'Use the Visual novels route to return to the candidate home. No release read is configured here.',
            ),
            slot('hero'),
            slot('entity'),
            slot('aside'),
            slot('footer'),
          ],
        },
      },
    ],
  } as unknown as CompositionDocument;
}

const admittedHome = homeDocument(
  'A development preview of the Visual novels candidate. The official-instance roster is deferred; the examples below are fictional story copy, not catalogue results.',
  [
    'The Paper Moon Archive follows a night-shift conservator who finds tomorrow written in the margins of an old atlas.',
    'Blue Hour at Station Nine is a quiet romance told through unsent letters and the weather reports of a coastal train stop.',
    'The Orchard of Borrowed Names is a mystery about a village library whose books remember every reader differently.',
  ],
);

const emptyHome = homeDocument(
  'This ready-empty preview shows no work rows in its saved visual-novel/all scope. No official-instance roster has been adopted.',
  ['The list is intentionally empty while the candidate waits for an evidenced public roster.'],
);

const sparseHome = homeDocument(
  'A sparse development preview · deferred. This fictional note is authored for the preview and does not stand for a live catalogue entry.',
  ['The Cartographer of Small Fires follows a mapmaker who redraws one safe path through a city after every storm.'],
);

const navigation = [{ route: '' }, { route: 'releases' }];

function zone(id: string): ZonePublic {
  return {
    id,
    revision: '1',
    labels,
    primaryLanguage: 'en',
    visibility: 'public',
    appearance: {},
    navigation,
  };
}

export type VisualNovelPageCase = {
  zone: ZonePublic;
  pages: Record<string, CompositionDocument>;
};

export type VisualNovelReadCase =
  | { status: 200; response: ZonePageResponse }
  | { status: 403 | 404 | 503; headers?: Record<string, string>; error: string };

function pageCase(id: string, home: CompositionDocument): VisualNovelPageCase {
  return { zone: zone(id), pages: { '': home, releases: releasesDocument() } };
}

export const visualNovelPageCases: Record<string, VisualNovelPageCase> = {
  [visualNovelZoneIds.preview]: pageCase(visualNovelZoneIds.preview, admittedHome),
  [visualNovelZoneIds.empty]: pageCase(visualNovelZoneIds.empty, emptyHome),
  [visualNovelZoneIds.sparse]: pageCase(visualNovelZoneIds.sparse, sparseHome),
  [visualNovelZoneIds.unavailable]: pageCase(visualNovelZoneIds.unavailable, admittedHome),
};

export const visualNovelReadCases: Record<string, Record<string, VisualNovelReadCase>> = {
  [visualNovelZoneIds.preview]: {},
  [visualNovelZoneIds.empty]: {},
  [visualNovelZoneIds.sparse]: {},
  [visualNovelZoneIds.closed]: {
    '': { status: 403, error: 'platform_closed' },
    releases: { status: 403, error: 'platform_closed' },
  },
  [visualNovelZoneIds.unavailable]: {
    '': { status: 503, headers: { 'Retry-After': '1' }, error: 'semantic_not_ready' },
  },
  [visualNovelZoneIds.private]: {
    '': { status: 404, error: 'not_found' },
    releases: { status: 404, error: 'not_found' },
  },
  [visualNovelZoneIds.missing]: {
    '': { status: 404, error: 'not_found' },
    releases: { status: 404, error: 'not_found' },
  },
};

export function visualNovelPageResponse(zoneId: string, route: string): ZonePageResponse | undefined {
  const fixture = visualNovelPageCases[zoneId];
  const document = fixture?.pages[route];
  if (!fixture || !document) return undefined;
  return {
    profile: 'default',
    template: { scope: 'route', key: route },
    document,
    reads: {},
    zone: fixture.zone,
  };
}

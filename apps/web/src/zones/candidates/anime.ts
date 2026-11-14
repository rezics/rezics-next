import type { CompositionDocument } from '@rezics/composition';
import type { ZonePageResponse } from '../appearance';

/** Decision summary: keep Anime a synthetic, gated development preview until an official instance is adopted. */
export const animeCandidateIds = {
  admittedPreview: '0193c000-0001-7000-8000-000000000000',
  platformClosed: '0193c000-0001-7000-8000-000000000001',
  semanticUnavailable: '0193c000-0001-7000-8000-000000000002',
  private: '0193c000-0001-7000-8000-000000000003',
  readyEmpty: '0193c000-0001-7000-8000-000000000004',
  sparse: '0193c000-0001-7000-8000-000000000005',
  missing: '0193c000-0001-7000-8000-000000000006',
} as const;

export const animeCandidateSubjectIds = {
  film: '0193c100-0001-7000-8000-000000000001',
  series: '0193c100-0001-7000-8000-000000000002',
  secondFilm: '0193c100-0001-7000-8000-000000000003',
  release: '0193c100-0001-7000-8000-000000000004',
} as const;

const labels = {
  en: 'Anime',
  'zh-Hant': '動畫',
  'zh-Hans': '动画',
  ja: 'アニメ',
  ko: '애니메이션',
  de: 'Anime',
  fr: 'Anime',
  es: 'Anime',
};

const navigation = [{ route: '' }, { route: 'films' }, { route: 'releases' }, { route: 'series' }];
const previewCopy =
  'Anime candidate — gated development preview; these fictional rows are admitted only for this Storybook fixture while source opening is deferred. No official Anime site or live public release catalogue is adopted.';

export type AnimeCandidateSubject = {
  id: string;
  type: 'schema:Movie' | 'schema:TVSeries' | 'rezics:AnimeRelease';
  labels: { en: string };
};

const film: AnimeCandidateSubject = {
  id: animeCandidateSubjectIds.film,
  type: 'schema:Movie',
  labels: { en: 'The Lantern on Sora Bay' },
};
const series: AnimeCandidateSubject = {
  id: animeCandidateSubjectIds.series,
  type: 'schema:TVSeries',
  labels: { en: 'Moss and Meteors' },
};
const secondFilm: AnimeCandidateSubject = {
  id: animeCandidateSubjectIds.secondFilm,
  type: 'schema:Movie',
  labels: { en: 'A Map for Cloud Harbour' },
};
const release: AnimeCandidateSubject = {
  id: animeCandidateSubjectIds.release,
  type: 'rezics:AnimeRelease',
  labels: { en: 'The Lantern on Sora Bay — home-video release' },
};

function slots() {
  return ['hero', 'entity', 'aside', 'footer'].map((name) => ({
    type: 'Slot',
    props: { id: name, name, children: [] },
  }));
}

function staticDocument(title: string, intro: string, extra: string): CompositionDocument {
  return {
    root: { props: {} },
    content: [
      {
        type: 'Stack',
        props: {
          id: 'page',
          gap: 'md',
          children: [
            { type: 'Heading', props: { id: 'title', text: title, level: 2 } },
            { type: 'Text', props: { id: 'intro', text: intro } },
            { type: 'Text', props: { id: 'preview', text: extra } },
            ...slots(),
          ],
        },
      },
    ],
  };
}

const homeDocument: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'Stack',
      props: {
        id: 'page',
        gap: 'md',
        children: [
          { type: 'Heading', props: { id: 'title', text: 'Anime', level: 2 } },
          {
            type: 'Text',
            props: {
              id: 'intro',
              text: 'A starting page for anime films and television series. Seasons and episodes are parts of those works.',
            },
          },
          { type: 'Text', props: { id: 'preview', text: previewCopy } },
          {
            type: 'TypeList',
            props: {
              id: 'works',
              title: {
                en: 'All anime',
                'zh-Hant': '全部動畫',
                'zh-Hans': '所有动画',
                ja: 'すべてのアニメ',
                ko: '모든 애니메이션',
                de: 'Alle Anime',
                fr: 'Tous les anime',
                es: 'Todos los anime',
              },
              types: ['schema:Movie', 'schema:TVSeries'],
              sort: 'name',
              limit: 24,
            },
          },
          ...slots(),
        ],
      },
    },
  ],
};

const releasesDocument: CompositionDocument = {
  root: { props: {} },
  content: [
    {
      type: 'Stack',
      props: {
        id: 'page',
        gap: 'md',
        children: [
          {
            type: 'Heading',
            props: { id: 'title', text: 'Anime releases', level: 2 },
          },
          {
            type: 'Text',
            props: {
              id: 'intro',
              text: 'Independently identified anime publications and distributed versions. Tracking stays on the anime work.',
            },
          },
          { type: 'Text', props: { id: 'preview', text: previewCopy } },
          {
            type: 'TypeList',
            props: {
              id: 'releases',
              title: {
                en: 'Anime releases',
                de: 'Anime-Veröffentlichungen',
                es: 'Ediciones de anime',
                fr: 'Éditions d’anime',
                ja: 'アニメ刊行版',
                ko: '애니메이션 발행판',
                'zh-Hans': '动画发行版',
                'zh-Hant': '動畫發行版',
              },
              types: ['rezics:AnimeRelease'],
              sort: 'name',
              limit: 24,
            },
          },
          ...slots(),
        ],
      },
    },
  ],
};

export type AnimeRoute = '' | 'films' | 'releases' | 'series';

const documents: Record<AnimeRoute, CompositionDocument> = {
  '': homeDocument,
  films: staticDocument(
    'Films',
    'Animated films, including features and shorts.',
    'This authored route is a static guide; the home page holds the film and series browse list.',
  ),
  releases: releasesDocument,
  series: staticDocument(
    'Series',
    'Animated television series.',
    'This authored route is a static guide. Seasons and episodes remain parts of their series.',
  ),
};

export const animeCandidateZone = (id: string): ZonePageResponse['zone'] => ({
  id,
  revision: '1',
  labels,
  primaryLanguage: 'en',
  visibility: 'unlisted',
  appearance: {},
  navigation,
});

export function animeCandidatePage(
  id: string,
  route: AnimeRoute,
  profile: string,
  reads: Record<string, unknown>,
): ZonePageResponse {
  return {
    profile,
    template: { scope: 'route', key: route },
    document: documents[route],
    reads,
    zone: animeCandidateZone(id),
  };
}

export const animeCandidateReads = {
  admittedPreview: [film, series, secondFilm],
  readyEmpty: [],
  sparse: [film, series],
  releases: [release],
};

export function animeCandidateRows(zoneId: string, route: AnimeRoute): AnimeCandidateSubject[] {
  if (route === '') {
    if (zoneId === animeCandidateIds.readyEmpty) return animeCandidateReads.readyEmpty;
    if (zoneId === animeCandidateIds.sparse) return animeCandidateReads.sparse;
    return animeCandidateReads.admittedPreview;
  }
  if (route === 'releases') return animeCandidateReads.releases;
  return [];
}

export function animeCandidateSubject(id: string): AnimeCandidateSubject | undefined {
  return [film, series, secondFilm, release].find((subject) => subject.id === id);
}

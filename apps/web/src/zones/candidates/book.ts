import type { ZonePageResponse, ZonePageTarget, ZonePublic } from '../appearance';

/** Synthetic gated development preview, deferred from official-site and public-release claims. */
export const BOOK_CANDIDATE_ZONE_IDS = {
  admitted: '0193c000-0002-7000-8000-000000000000',
  readyEmpty: '0193c000-0002-7000-8000-000000000001',
  sparse: '0193c000-0002-7000-8000-000000000002',
  platformClosed: '0193c000-0002-7000-8000-000000000003',
  semanticNotReady: '0193c000-0002-7000-8000-000000000004',
  private: '0193c000-0002-7000-8000-000000000005',
  missing: '0193c000-0002-7000-8000-000000000006',
} as const;

export const BOOK_CANDIDATE_SUBJECT_IDS = {
  archive: '0193c100-0002-7000-8000-000000000001',
  orchard: '0193c100-0002-7000-8000-000000000002',
  winter: '0193c100-0002-7000-8000-000000000003',
} as const;

export const BOOK_CANDIDATE_SAVED_SCOPES = ['book/all', 'book/editions', 'book/before-2000'] as const;

type BookCandidateState = keyof typeof BOOK_CANDIDATE_ZONE_IDS;

type BookCandidateSubject = {
  id: string;
  type: 'schema:Book';
  labels: { en: string };
  descriptions: { en: string };
  aliases: Record<string, never>;
  statements: Record<string, never>;
};

type CandidateRead =
  | { kind: 'page'; response: ZonePageResponse }
  | {
      kind: 'error';
      status: 403 | 404 | 503;
      code: 'platform_closed' | 'not_found' | 'semantic_not_ready';
      message: string;
      retryAfter?: '1';
    }
  | { kind: 'decline' };

const bookSubjects: BookCandidateSubject[] = [
  {
    id: BOOK_CANDIDATE_SUBJECT_IDS.archive,
    type: 'schema:Book',
    labels: { en: 'The Archive of Quiet Stars' },
    descriptions: {
      en: 'A speculative novel about a night archivist mapping messages found between constellations.',
    },
    aliases: {},
    statements: {},
  },
  {
    id: BOOK_CANDIDATE_SUBJECT_IDS.orchard,
    type: 'schema:Book',
    labels: { en: 'Salt Beneath the Orchard' },
    descriptions: {
      en: 'A family story set in a coastal orchard where each generation keeps a different map.',
    },
    aliases: {},
    statements: {},
  },
  {
    id: BOOK_CANDIDATE_SUBJECT_IDS.winter,
    type: 'schema:Book',
    labels: { en: 'The Mapmaker’s Winter' },
    descriptions: {
      en: 'A quiet adventure following a cartographer who redraws the roads after the first snow.',
    },
    aliases: {},
    statements: {},
  },
];

const bookLabels = {
  en: 'Books',
  'zh-Hant': '書籍',
  'zh-Hans': '图书',
  ja: '書籍',
  ko: '도서',
  de: 'Bücher',
  fr: 'Livres',
  es: 'Libros',
};

const allBooksLabels = {
  en: 'All books',
  'zh-Hant': '全部書籍',
  'zh-Hans': '全部图书',
  ja: 'すべての書籍',
  ko: '모든 도서',
  de: 'Alle Bücher',
  fr: 'Tous les livres',
  es: 'Todos los libros',
};

function slot(id: string, name: string) {
  return { type: 'Slot', props: { id, name, children: [] } };
}

function homeDocument(copy: string) {
  return {
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
              props: { id: 'title', text: 'Books', level: 2 },
            },
            { type: 'Text', props: { id: 'intro', text: copy } },
            {
              type: 'TypeList',
              props: {
                id: 'works',
                title: allBooksLabels,
                types: ['schema:Book'],
                sort: 'name',
                limit: 24,
              },
            },
            slot('hero', 'hero'),
            slot('entity', 'entity'),
            slot('aside', 'aside'),
            slot('footer', 'footer'),
          ],
        },
      },
    ],
  };
}

const editionsDocument = {
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
            props: { id: 'title', text: 'Editions', level: 2 },
          },
          {
            type: 'Text',
            props: {
              id: 'intro',
              text: 'Published editions of book works, including translations and versions.',
            },
          },
          {
            type: 'Text',
            props: {
              id: 'static-note',
              text: 'A book work and a published edition are separate records. This page stays static in the development preview and does not publish an edition list.',
            },
          },
          slot('hero', 'hero'),
          slot('entity', 'entity'),
          slot('aside', 'aside'),
          slot('footer', 'footer'),
        ],
      },
    },
  ],
};

function zone(id: string): ZonePublic {
  return {
    id,
    revision: '1',
    labels: bookLabels,
    primaryLanguage: 'en',
    visibility: 'public',
    appearance: {},
    navigation: [{ route: '' }, { route: 'editions' }],
  };
}

const stateForId = new Map<string, BookCandidateState>(
  Object.entries(BOOK_CANDIDATE_ZONE_IDS).map(([state, id]) => [id, state as BookCandidateState]),
);

function subjectDocument(subject: BookCandidateSubject) {
  return {
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
              props: { id: 'title', text: subject.labels.en, level: 2 },
            },
            {
              type: 'Text',
              props: { id: 'description', text: subject.descriptions.en },
            },
          ],
        },
      },
    ],
  };
}

function publicPage(
  id: string,
  templateKey: string,
  document: unknown,
  reads: Record<string, unknown>,
  subject?: string,
): ZonePageResponse {
  return {
    profile: subject ? 'schema:Book' : 'book',
    template: subject ? { scope: 'type', key: 'schema:Book' } : { scope: 'route', key: templateKey },
    document,
    reads,
    zone: zone(id),
    ...(subject ? { subject, views: ['overview'] } : {}),
  };
}

function notFound(): CandidateRead {
  return {
    kind: 'error',
    status: 404,
    code: 'not_found',
    message: 'The requested page was not found.',
  };
}

function homeState(state: BookCandidateState): CandidateRead {
  if (state === 'platformClosed') {
    return {
      kind: 'error',
      status: 403,
      code: 'platform_closed',
      message: 'This Books development preview is closed by the platform gate.',
    };
  }
  if (state === 'semanticNotReady') {
    return {
      kind: 'error',
      status: 503,
      code: 'semantic_not_ready',
      message: 'The Books source is not ready yet; retry after the owner is available.',
      retryAfter: '1',
    };
  }
  if (state === 'private' || state === 'missing') return notFound();

  const copyByState: Record<'admitted' | 'readyEmpty' | 'sparse', string> = {
    admitted:
      'Gated development preview: these fictional works illustrate an admitted source branch. They are not an official Books roster or a public live catalogue.',
    readyEmpty:
      'Gated development preview: this source response is ready and has no matching book works. Empty results stay empty.',
    sparse:
      'Gated development preview: this sparse source response contains one fictional book work with no author, publication date or word count recorded.',
  };
  const subjects = state === 'admitted' ? bookSubjects : state === 'sparse' ? [bookSubjects[2]!] : [];
  return {
    kind: 'page',
    response: publicPage(BOOK_CANDIDATE_ZONE_IDS[state], '', homeDocument(copyByState[state]), {
      works: { items: subjects },
    }),
  };
}

export function readBookCandidatePage(id: string, target: ZonePageTarget): CandidateRead {
  const state = stateForId.get(id);
  if (!state) return { kind: 'decline' };

  if ('route' in target) {
    if (state === 'private' || state === 'missing') return notFound();
    if (target.route === 'editions') {
      return {
        kind: 'page',
        response: publicPage(id, 'editions', editionsDocument, {}),
      };
    }
    if (target.route === '') return homeState(state);
    return notFound();
  }

  if (state === 'private' || state === 'missing') return notFound();
  if (state === 'platformClosed' || state === 'semanticNotReady') return homeState(state);
  const subject = bookSubjects.find((book) => book.id === target.subject);
  const shownSubjects = state === 'admitted' ? bookSubjects : state === 'sparse' ? [bookSubjects[2]!] : [];
  if (!subject || !shownSubjects.some((book) => book.id === subject.id) || (target.view && target.view !== 'overview'))
    return notFound();
  return {
    kind: 'page',
    response: publicPage(id, 'schema:Book', subjectDocument(subject), {}, subject.id),
  };
}

export const bookCandidatePreviewCopy =
  'Synthetic gated development preview, deferred from official-site and public dynamic-release claims.';

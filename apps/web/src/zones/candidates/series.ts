import type { CompositionDocument } from '@rezics/composition';
import seriesStarter from '../../../../../packages/definitions/presentation/series/zone.json';
import type { ZonePageResponse, ZonePublic } from '../appearance';

export const SERIES_CANDIDATE_IDS = {
  preview: '0193c000-0007-7000-8000-000000000000',
  readyEmpty: '0193c000-0007-7000-8000-000000000001',
  sparse: '0193c000-0007-7000-8000-000000000002',
  platformClosed: '0193c000-0007-7000-8000-000000000003',
  semanticNotReady: '0193c000-0007-7000-8000-000000000004',
  private: '0193c000-0007-7000-8000-000000000005',
  missing: '0193c000-0007-7000-8000-000000000006',
} as const;

export const SERIES_CANDIDATE_SUBJECTS = [
  {
    id: '0193c100-0007-7000-8000-000000000001',
    type: 'wd:Q7725310',
    label: 'The Tidemark Atlas',
    description: 'A fictional example of a series across creative works.',
  },
  {
    id: '0193c100-0007-7000-8000-000000000002',
    type: 'schema:BookSeries',
    label: 'Mosslight Almanac',
    description: 'A fictional example of a book series.',
  },
] as const;

export const SERIES_CANDIDATE_ROUTES = ['', 'book-series', 'creative-works'] as const;
type SeriesCandidateRoute = (typeof SERIES_CANDIDATE_ROUTES)[number];
const routeNavigation = SERIES_CANDIDATE_ROUTES.map((route) => ({ route }));
const seriesLabels = seriesStarter.labels as ZonePublic['labels'];

function starterDocument(route: SeriesCandidateRoute, notice?: string): CompositionDocument {
  const page = seriesStarter.pages.find((candidate) => candidate.route === route);
  if (!page) throw new Error(`The Series starter is missing its ${route || 'home'} page.`);
  if (!notice) return page.document as CompositionDocument;

  const source = page.document as unknown as {
    root: CompositionDocument['root'];
    content: unknown[];
  };
  const content = [...source.content];
  const intro = content.findIndex(
    (node) =>
      typeof node === 'object' &&
      node !== null &&
      'type' in node &&
      node.type === 'Text' &&
      'props' in node &&
      typeof node.props === 'object' &&
      node.props !== null &&
      'id' in node.props &&
      node.props.id === 'intro',
  );
  content.splice(intro + 1, 0, {
    type: 'Text',
    props: { id: 'series-preview-note', text: notice },
  });
  return { root: source.root, content } as CompositionDocument;
}

const homeNotices = {
  preview:
    'Gated development preview: both records are fictional. Their names imply no membership or reading sequence, and this is not an adopted official site.',
  readyEmpty:
    'Gated development preview: this source read is ready and has no matching series. The authored page and its empty slots remain visible.',
  sparse:
    'Gated development preview: one fictional record is available. Optional facts, artwork, translations, membership, and ordering are absent.',
} as const;

export const SERIES_CANDIDATE_DOCUMENTS = {
  home: starterDocument('', homeNotices.preview),
  readyEmpty: starterDocument('', homeNotices.readyEmpty),
  sparse: starterDocument('', homeNotices.sparse),
  bookSeries: starterDocument(
    'book-series',
    'This authored route is static in the gated development preview. It does not run the saved book-series scope or assert which works belong to a series. Use Zone navigation to return to Series.',
  ),
  creativeWorks: starterDocument(
    'creative-works',
    'This authored route is static in the gated development preview. It does not run the saved creative-works scope or infer membership from a name. Use Zone navigation to return to Series.',
  ),
};

export function seriesCandidateZone(id: string): ZonePublic {
  return {
    id,
    revision: '1',
    labels: seriesLabels,
    primaryLanguage: 'en',
    visibility: 'public',
    appearance: {},
    navigation: routeNavigation,
  };
}

export function seriesCandidateZonePage(
  id: string,
  route: SeriesCandidateRoute,
  document: CompositionDocument,
  reads: Record<string, unknown>,
): ZonePageResponse {
  return {
    profile: 'development-preview:series',
    template: { scope: 'route', key: route },
    document,
    reads,
    zone: seriesCandidateZone(id),
  };
}

export function seriesCandidateSubject(subjectId: string) {
  return SERIES_CANDIDATE_SUBJECTS.find((subject) => subject.id === subjectId);
}

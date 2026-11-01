import type { KernelClient } from '@rezics/client';
import type { PublicFigure, RatingQuestion, Ratings } from '../../features/pages/subject-ratings';
import type { FakeRoute } from '../fake-modules';
import realmRecording from '../recorded/realm.json';
import subjectSourceStatisticsRecording from '../recorded/subject-source-statistics.json';

type SubjectRoutes = ReturnType<KernelClient['subjects']>;
export type AggregateResponse = NonNullable<Awaited<ReturnType<SubjectRoutes['ratings']['get']>>['data']>;
export type SourceStatisticsResponse = NonNullable<
  Awaited<ReturnType<SubjectRoutes['source-statistics']['get']>>['data']
>;
type VoteResponse = NonNullable<Awaited<ReturnType<ReturnType<SubjectRoutes['ratings']>['vote']['get']>>['data']>;

export const GLOBAL = '00000000-0000-8000-8000-000000000000';
export const QUESTION = '00000000-0000-7000-8000-000000000001';
export const IMPORTED_VN_SUBJECT_ID = '01a1773a-f700-7074-b1ee-5e05671d3be3';

export const standardRatingQuestion: RatingQuestion = {
  id: QUESTION,
  revision: 1,
  label: 'How much did you like this work?',
  grain: 'work',
  scale: { min: 0, max: 20, displayStep: 1 },
};
const emptyPublicFigure: PublicFigure = {
  questionId: QUESTION,
  populationId: GLOBAL,
  scale: standardRatingQuestion.scale,
  count: 0,
  state: 'insufficient_data',
  mean: null,
  score: null,
};
const readyPublicFigure: PublicFigure = {
  ...emptyPublicFigure,
  count: 1203,
  state: 'ready',
  mean: 8.4,
  score: 8.3,
};

export const ratingPopulationRealms = [
  { id: '01a1a000-0000-7000-8000-000000000002', name: 'The Quiet Novel Club' },
  { id: '01a1a000-0000-7000-8000-000000000051', name: 'Night Shift Translators' },
  { id: '01a1a000-0000-7000-8000-000000000052', name: 'Hearth and Skillet' },
  { id: '01a1a000-0000-7000-8000-000000000053', name: 'Weekend Readers' },
  { id: '01a1a000-0000-7000-8000-000000000054', name: 'Small Press Discussion' },
  { id: '01a1a000-0000-7000-8000-000000000055', name: 'Archive Readers' },
];

const histogram = (entries: [number, number][]) => {
  const values = Array.from({ length: 21 }, () => 0);
  for (const [unit, count] of entries) values[unit] = count;
  return values;
};

const globalScore = {
  population: GLOBAL,
  count: 1203,
  freshness: { asOf: null, updating: false },
  mean: 16.8,
  histogram: histogram([
    [14, 50],
    [15, 100],
    [16, 150],
    [17, 700],
    [18, 160],
    [19, 30],
    [20, 13],
  ]),
} satisfies AggregateResponse['figures'][number];

const importedStatistics = [
  {
    source: 'vndb',
    sourceRecordId: 'v4',
    scale: { min: 1, max: 10 },
    mean: 8.4,
    count: 267,
    asOf: '2026-10-20',
    licence: 'ODbL-1.0',
    attribution: 'VNDB',
  },
] satisfies SourceStatisticsResponse;
const emptyStatistics = subjectSourceStatisticsRecording as SourceStatisticsResponse;

const emptyGlobal = {
  population: GLOBAL,
  count: 0,
  freshness: { asOf: null, updating: false },
} satisfies AggregateResponse['figures'][number];

const ownVote = { units: 17, revision: 1, at: '2026-10-28T00:00:00.000Z' } satisfies VoteResponse;

export type RatingsFixtureName =
  | 'subject-ratings-statistics-failed'
  | 'subject-ratings-sparse'
  | 'subject-ratings-empty'
  | 'subject-ratings-global'
  | 'subject-ratings-realms'
  | 'subject-ratings-below-threshold'
  | 'subject-ratings-imported'
  | 'subject-ratings-own-forbidden';

export type RatingsFixture = {
  aggregate: AggregateResponse;
  statistics: SourceStatisticsResponse;
  voteStatus: number;
  vote?: VoteResponse;
  preview: Ratings;
  statisticsStatus?: number;
  sparse?: boolean;
};

function aggregate(figures: AggregateResponse['figures']): AggregateResponse {
  return { question: QUESTION, subject: '00000000-0000-4000-8000-000000000001', figures };
}

const baseRatingsFixtures: Record<
  Exclude<RatingsFixtureName, 'subject-ratings-statistics-failed' | 'subject-ratings-sparse'>,
  RatingsFixture
> = {
  'subject-ratings-empty': {
    aggregate: aggregate([emptyGlobal]),
    statistics: emptyStatistics,
    voteStatus: 404,
    preview: {
      question: standardRatingQuestion,
      figure: emptyPublicFigure,
      figures: [emptyGlobal],
      statistics: emptyStatistics,
      realms: [],
      own: null,
    },
  },
  'subject-ratings-global': {
    aggregate: aggregate([globalScore]),
    statistics: emptyStatistics,
    voteStatus: 404,
    preview: {
      question: standardRatingQuestion,
      figure: readyPublicFigure,
      figures: [globalScore],
      statistics: [],
      realms: [],
      own: null,
    },
  },
  'subject-ratings-realms': {
    aggregate: aggregate([
      globalScore,
      {
        population: ratingPopulationRealms[0]!.id,
        count: 36,
        freshness: { asOf: null, updating: false },
        mean: 17.61,
        histogram: histogram([
          [17, 14],
          [18, 22],
        ]),
      },
      {
        population: ratingPopulationRealms[1]!.id,
        count: 82,
        freshness: { asOf: null, updating: false },
        mean: 16.4,
        histogram: histogram([
          [16, 49],
          [17, 33],
        ]),
      },
      { population: ratingPopulationRealms[2]!.id, count: 0, freshness: { asOf: null, updating: false } },
    ]),
    statistics: emptyStatistics,
    voteStatus: 200,
    vote: ownVote,
    preview: {
      question: standardRatingQuestion,
      figure: readyPublicFigure,
      figures: [
        globalScore,
        {
          population: ratingPopulationRealms[0]!.id,
          count: 36,
          mean: 17.61,
          histogram: histogram([
            [17, 14],
            [18, 22],
          ]),
        },
        {
          population: ratingPopulationRealms[1]!.id,
          count: 82,
          mean: 16.4,
          histogram: histogram([
            [16, 49],
            [17, 33],
          ]),
        },
        { population: ratingPopulationRealms[2]!.id, count: 0 },
      ],
      statistics: [],
      realms: ratingPopulationRealms,
      own: ownVote.units,
    },
  },
  'subject-ratings-below-threshold': {
    aggregate: aggregate([{ population: GLOBAL, count: 3, freshness: { asOf: null, updating: false }, remaining: 2 }]),
    statistics: emptyStatistics,
    voteStatus: 404,
    preview: {
      question: standardRatingQuestion,
      figure: { ...emptyPublicFigure, count: 3 },
      figures: [{ population: GLOBAL, count: 3, remaining: 2 }],
      statistics: [],
      realms: [],
      own: null,
    },
  },
  'subject-ratings-imported': {
    aggregate: aggregate([emptyGlobal]),
    statistics: importedStatistics,
    voteStatus: 404,
    preview: {
      question: standardRatingQuestion,
      figure: emptyPublicFigure,
      figures: [emptyGlobal],
      statistics: importedStatistics,
      realms: [],
      own: null,
    },
  },
  'subject-ratings-own-forbidden': {
    aggregate: aggregate([emptyGlobal]),
    statistics: emptyStatistics,
    voteStatus: 403,
    preview: {
      question: standardRatingQuestion,
      figure: emptyPublicFigure,
      figures: [emptyGlobal],
      statistics: [],
      realms: [],
      own: null,
    },
  },
};

export const ratingsFixtures: Record<RatingsFixtureName, RatingsFixture> = {
  ...baseRatingsFixtures,
  'subject-ratings-statistics-failed': { ...baseRatingsFixtures['subject-ratings-realms'], statisticsStatus: 503 },
  'subject-ratings-sparse': { ...baseRatingsFixtures['subject-ratings-realms'], sparse: true },
};

let selectedName: RatingsFixtureName | undefined;

export function selectRatingsFixture(name?: RatingsFixtureName): void {
  selectedName = name;
}

function selectedFixture(request: Request): RatingsFixture {
  const name =
    selectedName ??
    (globalThis as typeof globalThis & { __rezicsStoryContext?: { ratingsFixture?: string } }).__rezicsStoryContext
      ?.ratingsFixture;
  if (!name || !Object.hasOwn(ratingsFixtures, name)) return ratingsFixtures['subject-ratings-empty'];

  const subjectId = new URL(request.url).pathname.split('/')[3];
  if (name === 'subject-ratings-imported' && subjectId !== IMPORTED_VN_SUBJECT_ID)
    return ratingsFixtures['subject-ratings-empty'];

  return ratingsFixtures[name as RatingsFixtureName];
}

function aggregateRoute(request: Request, path: string, fixture: RatingsFixture) {
  const subject = path.split('/')[3]!;
  const requested = requestUrl(request).searchParams.getAll('population');
  return {
    status: 200,
    question: requestUrl(request).searchParams.get('question') ?? fixture.aggregate.question,
    subject,
    figures: requested.map(
      (population) =>
        fixture.aggregate.figures.find((figure) => figure.population === population) ?? {
          population,
          count: 0,
          freshness: { asOf: null, updating: false },
        },
    ),
  } satisfies AggregateResponse & { status: number };
}

const requestUrl = (request: Request) => new URL(request.url);

function ratingsRoutes(): FakeRoute[] {
  const aggregateAnswer: NonNullable<FakeRoute['story']> = ({ request, match }) =>
    match ? aggregateRoute(request, match[0], selectedFixture(request)) : undefined;
  const statisticsAnswer: NonNullable<FakeRoute['story']> = ({ request }) => ({
    status: selectedFixture(request).statisticsStatus ?? 200,
    __responseBody: selectedFixture(request).statisticsStatus
      ? { code: 'overloaded' }
      : selectedFixture(request).statistics,
  });
  const voteAnswer: NonNullable<FakeRoute['story']> = ({ request }) => {
    const fixture = selectedFixture(request);
    if (fixture.voteStatus === 200 && fixture.vote) return { status: 200, ...fixture.vote };
    return { status: fixture.voteStatus, ...(fixture.voteStatus === 404 ? { code: 'not_found' } : {}) };
  };
  return [
    {
      method: 'GET',
      path: /^\/v1\/subjects\/[^/]+\/ratings$/,
      story: aggregateAnswer,
      fixture: aggregateAnswer,
    },
    {
      method: 'GET',
      path: /^\/v1\/subjects\/[^/]+\/source-statistics$/,
      story: statisticsAnswer,
      fixture: statisticsAnswer,
    },
    {
      method: 'GET',
      path: /^\/v1\/subjects\/[^/]+\/ratings\/[^/]+\/vote$/,
      story: voteAnswer,
      fixture: voteAnswer,
    },
  ];
}

export const routes: FakeRoute[] = [
  ...ratingsRoutes(),
  {
    method: 'GET',
    path: /^\/v1\/subjects\/[^/]+\/ratings\/populations$/,
    story: ({ request }) => populationPage(request),
    fixture: ({ request }) => populationPage(request),
  },
  {
    method: 'GET',
    path: /^\/v1\/realms\/[^/]+$/,
    story: ({ request }) => populationRealm(request),
    fixture: ({ request }) => populationRealm(request),
  },
  {
    method: 'GET',
    path: /^\/v1\/rating-questions\/[^/]+$/,
    story: () => ({ status: 200, ...standardRatingQuestion }),
    fixture: () => ({ status: 200, ...standardRatingQuestion }),
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/[^/]+\/figure$/,
    story: ({ request }) => ({ status: 200, figure: selectedFixture(request).preview.figure }),
    fixture: ({ request }) => ({ status: 200, figure: selectedFixture(request).preview.figure }),
  },
];

// Declared native DTO fixtures for connected consumers; no membership, credential freshness or native proof is inferred.
function populationPage(request: Request) {
  const url = new URL(request.url);
  const fixture = selectedFixture(request);
  if (url.searchParams.get('question') !== QUESTION) return { status: 400, code: 'invalid_request' };
  const cursor = url.searchParams.get('cursor');
  const continuation = `recorded.opaque.${url.pathname.split('/')[3]}.next`;
  if (cursor !== null && cursor !== continuation) return { status: 400, code: 'invalid_cursor' };
  return {
    status: 200,
    populations:
      fixture.sparse && cursor === null ? [] : fixture.preview.realms.map(({ id }) => ({ population: id, count: 1 })),
    next: fixture.sparse && cursor === null ? continuation : null,
  };
}
function populationRealm(request: Request) {
  const id = new URL(request.url).pathname.split('/')[3];
  const item = ratingPopulationRealms.find((item) => item.id === id);
  if (!item || !selectedFixture(request).preview.realms.some((realm) => realm.id === item.id)) return;
  return { status: 200, realm: { ...realmRecording.realm, realmId: item.id, title: item.name } };
}

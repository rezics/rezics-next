import type { KernelClient } from '@rezics/client';
import type { Ratings } from '../../features/pages/subject-ratings';
import type { FakeRoute } from '../fake-modules';
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

const realmList = [
  { id: '01a1a000-0000-7000-8000-000000000002', name: 'The Quiet Novel Club' },
  { id: '01a1a000-0000-7000-8000-000000000051', name: 'Night Shift Translators' },
  { id: '01a1a000-0000-7000-8000-000000000052', name: 'Hearth and Skillet' },
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
};

function aggregate(figures: AggregateResponse['figures']): AggregateResponse {
  return { question: QUESTION, subject: '00000000-0000-4000-8000-000000000001', figures };
}

export const ratingsFixtures: Record<RatingsFixtureName, RatingsFixture> = {
  'subject-ratings-empty': {
    aggregate: aggregate([emptyGlobal]),
    statistics: emptyStatistics,
    voteStatus: 404,
    preview: { figures: [emptyGlobal], statistics: emptyStatistics, realms: [], own: null },
  },
  'subject-ratings-global': {
    aggregate: aggregate([globalScore]),
    statistics: emptyStatistics,
    voteStatus: 404,
    preview: { figures: [globalScore], statistics: [], realms: [], own: null },
  },
  'subject-ratings-realms': {
    aggregate: aggregate([
      globalScore,
      {
        population: realmList[0]!.id,
        count: 36,
        freshness: { asOf: null, updating: false },
        mean: 17.61,
        histogram: histogram([
          [17, 14],
          [18, 22],
        ]),
      },
      {
        population: realmList[1]!.id,
        count: 82,
        freshness: { asOf: null, updating: false },
        mean: 16.4,
        histogram: histogram([
          [16, 49],
          [17, 33],
        ]),
      },
      { population: realmList[2]!.id, count: 0, freshness: { asOf: null, updating: false } },
    ]),
    statistics: emptyStatistics,
    voteStatus: 200,
    vote: ownVote,
    preview: {
      figures: [
        globalScore,
        {
          population: realmList[0]!.id,
          count: 36,
          mean: 17.61,
          histogram: histogram([
            [17, 14],
            [18, 22],
          ]),
        },
        {
          population: realmList[1]!.id,
          count: 82,
          mean: 16.4,
          histogram: histogram([
            [16, 49],
            [17, 33],
          ]),
        },
        { population: realmList[2]!.id, count: 0 },
      ],
      statistics: [],
      realms: realmList,
      own: ownVote.units,
    },
  },
  'subject-ratings-below-threshold': {
    aggregate: aggregate([{ population: GLOBAL, count: 3, freshness: { asOf: null, updating: false }, remaining: 2 }]),
    statistics: emptyStatistics,
    voteStatus: 404,
    preview: {
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
    preview: { figures: [emptyGlobal], statistics: importedStatistics, realms: [], own: null },
  },
  'subject-ratings-own-forbidden': {
    aggregate: aggregate([emptyGlobal]),
    statistics: emptyStatistics,
    voteStatus: 403,
    preview: { figures: [emptyGlobal], statistics: [], realms: [], own: null },
  },
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
    figures: fixture.aggregate.figures.filter((figure) => requested.includes(figure.population)),
  } satisfies AggregateResponse & { status: number };
}

const requestUrl = (request: Request) => new URL(request.url);

function ratingsRoutes(): FakeRoute[] {
  const aggregateAnswer: NonNullable<FakeRoute['story']> = ({ request, match }) =>
    match ? aggregateRoute(request, match[0], selectedFixture(request)) : undefined;
  const statisticsAnswer: NonNullable<FakeRoute['story']> = ({ request }) => ({
    status: 200,
    __responseBody: selectedFixture(request).statistics,
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

export const routes: FakeRoute[] = ratingsRoutes();

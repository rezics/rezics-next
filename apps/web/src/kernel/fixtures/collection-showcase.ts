import type { SubjectRead } from '@rezics/client';
import type { CollectionMember } from '../../library/reads';
import definitions from '../recorded/definitions-release.json';

/** An invented catalogue, shared by list envelopes and the ordinary Subject destinations. */
export const reviewId = (value: number) => `0193c000-0000-7000-8000-${String(value).padStart(12, '0')}`;
export const reviewDate = '2026-11-14T00:00:00Z';
export const reviewCreators = [
  { id: reviewId(201), label: 'Nao Mizuno' },
  { id: reviewId(202), label: 'Leila Haddad' },
  { id: reviewId(203), label: 'Elian Vale' },
  { id: reviewId(204), label: 'Mara Chen' },
  { id: reviewId(205), label: 'Aki Morita' },
] as const;
export const reviewGenres = [
  { id: reviewId(301), label: 'Literary fantasy' },
  { id: reviewId(302), label: 'Journeys and discovery' },
  { id: reviewId(303), label: 'Life by the sea' },
] as const;

type ReviewType = 'schema:Book' | 'schema:VideoGame' | 'rezics:AnimeRelease' | 'schema:BookSeries' | 'bf:Instance';
type Facts = NonNullable<CollectionMember['facts']>;
export type ReviewItem = {
  id: string;
  type: ReviewType;
  labels: Record<string, string>;
  description: string;
  creator?: (typeof reviewCreators)[number];
  creatorProperty?: 'schema:author' | 'schema:director';
  year?: number;
  words?: number;
  genre: (typeof reviewGenres)[number];
  art?: number;
  color: string;
};
const item = (
  number: number,
  title: string,
  description: string,
  options: Omit<ReviewItem, 'id' | 'labels' | 'description'>,
): ReviewItem => ({ id: reviewId(number), labels: { en: title }, description, ...options });

export const reviewBooks: ReviewItem[] = [
  item(
    1,
    'The Atlas of Quiet Harbours',
    'An apprentice cartographer follows the changing coastline of a city that remembers every departing ship.',
    {
      type: 'schema:Book',
      creator: reviewCreators[0],
      year: 2014,
      words: 128400,
      genre: reviewGenres[0],
      art: 101,
      color: '#193d47',
    },
  ),
  item(
    2,
    'A Garden for the Rain',
    'Letters between two sisters turn an abandoned railway garden into a record of a changing neighbourhood.',
    {
      type: 'schema:Book',
      creator: reviewCreators[1],
      year: 2018,
      words: 64200,
      genre: reviewGenres[2],
      art: 102,
      color: '#304e39',
    },
  ),
  item(
    3,
    'Night Trains to the Inland Sea',
    'Seven passengers cross a sleeping country, each carrying a different account of the same summer.',
    {
      type: 'schema:Book',
      creator: reviewCreators[2],
      year: 2021,
      words: 96200,
      genre: reviewGenres[1],
      art: 103,
      color: '#292b50',
    },
  ),
  item(
    4,
    'The House of Small Repairs',
    'A patient novel about a repair shop, its regular visitors and the objects they cannot bring themselves to replace.',
    {
      type: 'schema:Book',
      creator: reviewCreators[3],
      year: 2016,
      words: 80100,
      genre: reviewGenres[0],
      art: 104,
      color: '#934d37',
    },
  ),
  item(
    5,
    'Islands Written in Blue',
    'A translator assembles a lost island dictionary from recipes, weather reports and the margins of borrowed books.',
    {
      type: 'schema:Book',
      creator: reviewCreators[0],
      year: 2024,
      words: 115600,
      genre: reviewGenres[2],
      art: 105,
      color: '#285b75',
    },
  ),
  item(
    6,
    'The Last Lighthouse Keeper',
    'A coastal journey told through the changing duties of a lighthouse keeper and the people who visit her.',
    {
      type: 'schema:Book',
      creator: reviewCreators[4],
      year: 2009,
      words: 53700,
      genre: reviewGenres[1],
      art: 106,
      color: '#414947',
    },
  ),
  item(
    7,
    'Letters from Beyond the Last Tide — A Chronicle of Names, Memory and Returning Home',
    'A multilingual family chronicle whose long title belongs to one work, with no invented edition or series identity.',
    {
      type: 'schema:Book',
      creator: reviewCreators[1],
      year: 2025,
      words: 146000,
      genre: reviewGenres[0],
      art: 107,
      color: '#663f59',
    },
  ),
  item(
    8,
    'A Map Still Unfolding',
    'An incomplete catalogue record: no supplied creator, publication year or cover. Those facts remain absent.',
    { type: 'schema:Book', genre: reviewGenres[1], color: '#536761' },
  ),
];
reviewBooks[0]!.labels.ja = '静かな港の地図帳';
reviewBooks[0]!.labels['zh-Hant'] = '寧靜港灣的地圖集';
reviewBooks[0]!.labels['zh-Hans'] = '宁静港湾的地图集';
reviewBooks[6]!.labels.ja = '最後の潮の向こうからの手紙 — 名前と記憶と帰郷の年代記';

export const reviewMedia: ReviewItem[] = [
  item(
    11,
    'Tidebound: The Cartographer’s Journey',
    'A quiet exploration game about charting unfamiliar islands and finding a safe route through the tides.',
    { type: 'schema:VideoGame', year: 2022, genre: reviewGenres[1], art: 111, color: '#243f64' },
  ),
  item(
    12,
    'The Orchard at Dusk',
    'A small cooperative game in which an old orchard changes with the stories its visitors tell.',
    { type: 'schema:VideoGame', year: 2020, genre: reviewGenres[0], art: 112, color: '#684a37' },
  ),
  item(
    13,
    'Lanterns over the Estuary',
    'An animated series following the night ferry crew through one extraordinary summer in a harbour town.',
    {
      type: 'rezics:AnimeRelease',
      creator: reviewCreators[4],
      creatorProperty: 'schema:director',
      year: 2023,
      genre: reviewGenres[2],
      art: 113,
      color: '#52456d',
    },
  ),
  item(
    14,
    'When the Paper Boats Return',
    'A hand-drawn animated special about a letter that takes the long way home.',
    {
      type: 'rezics:AnimeRelease',
      creator: reviewCreators[1],
      creatorProperty: 'schema:director',
      year: 2019,
      genre: reviewGenres[1],
      art: 114,
      color: '#577056',
    },
  ),
];
export const reviewLiterary: ReviewItem[] = [
  item(21, 'The Quiet Harbour Library', 'A literary series of independent stories set along one changing coastline.', {
    type: 'schema:BookSeries',
    creator: reviewCreators[0],
    genre: reviewGenres[0],
    art: 101,
    color: '#193d47',
  }),
  item(
    22,
    'The Atlas of Quiet Harbours — Illustrated English Edition',
    'The illustrated English edition of The Atlas of Quiet Harbours; its edition year is distinct from the work.',
    { type: 'bf:Instance', creator: reviewCreators[0], year: 2020, genre: reviewGenres[0], art: 105, color: '#285b75' },
  ),
];
export const reviewItems = [...reviewBooks, ...reviewMedia, ...reviewLiterary];
export const reviewItemMap = new Map(reviewItems.map((entry) => [entry.id, entry]));

const coverThumbhashes: Record<number, string> = {
  '101': 'DrcBDQAH2Ih2SbdYqIqWaAeHg3A4',
  '102': 'EMgBBQAHmIaGSKeIiIlHWAeHdHBI',
  '103': 'EgcGDQIGWmSoCLrUWlRZ2QZkYEAG',
  '104': 'mYkGBQAIx4Z4J8eoaIpWePh5jq/X',
  '105': 'maYFFQIIp3aHGceoeIdY1wh2gWAX',
  '106': 'E/gFDQIH2Id4J9eIaHlmiAiHcXAn',
  '107': '1kcCBQAHeIZ2KYd4mIg5eAiFc8+I',
  '111': 'kcYBDQAH2IiGSbdYqImGWAeIdHBH',
  '112': 'FDkCBQAHiIaGSJeIiIlHWAd6g/+H',
  '113': 'GBcGFQAH2IeIJ8eIaIlmiAd3coAn',
  '114': 'm9gFDQIIl3aHGceoeIdY1wh3gXAX',
};

export function reviewCover(entry: ReviewItem) {
  return entry.art === undefined
    ? null
    : {
        media: reviewId(entry.art),
        width: 640,
        height: 896,
        placeholder: { thumbhash: coverThumbhashes[entry.art]!, color: entry.color },
        variants: [
          { format: 'webp' as const, width: 320 },
          { format: 'webp' as const, width: 640 },
        ],
        focalPoint: null,
        credit: {
          rightsHolder: 'REZICS synthetic cover artwork',
          via: { name: 'Collection review artwork', url: 'https://rezics.com' },
          license: 'CC0-1.0',
          obligations: [] as string[],
        },
      };
}

export function reviewFacts(entry: ReviewItem): Facts {
  const facts: Facts = {};
  if (entry.creator)
    facts[entry.creatorProperty ?? 'schema:author'] = [
      { kind: 'item', id: entry.creator.id, labels: { en: entry.creator.label } },
    ];
  if (entry.year !== undefined) facts['schema:datePublished'] = [{ kind: 'time', year: entry.year }];
  if (entry.words !== undefined) facts['schema:wordCount'] = [{ kind: 'quantity', amount: entry.words, unit: '1' }];
  facts['schema:genre'] = [{ kind: 'item', id: entry.genre.id, labels: { en: entry.genre.label } }];
  return facts;
}

export function reviewSummary(entry: ReviewItem, locale = 'en') {
  const language = entry.labels[locale] ? locale : 'en';
  return {
    id: entry.id,
    type: entry.type,
    types: [entry.type, ...definitions.release.types[entry.type].bases],
    label: { value: entry.labels[language]!, language },
    creativeWork: true,
    cover: reviewCover(entry),
  };
}

/** Occurrence IDs are independent from Subject IDs, including repeated Subjects. */
export function reviewMember(
  entry: ReviewItem,
  occurrence: number,
  locale = 'en',
  note = entry.description,
): CollectionMember {
  return {
    id: reviewId(occurrence),
    subjectId: entry.id,
    subject: reviewSummary(entry, locale),
    facts: reviewFacts(entry),
    addedAt: reviewDate,
    note,
  };
}
export const bookReviewMembers = (locale = 'en') =>
  reviewBooks.map((entry, index) => reviewMember(entry, 401 + index, locale));
export const mediaReviewMembers = (locale = 'en') => [
  reviewMember(reviewBooks[0]!, 501, locale),
  reviewMember(reviewMedia[0]!, 502, locale),
  reviewMember(reviewMedia[2]!, 503, locale),
  reviewMember(reviewBooks[1]!, 504, locale),
  reviewMember(reviewMedia[1]!, 505, locale),
  reviewMember(reviewMedia[3]!, 506, locale),
  reviewMember(reviewBooks[4]!, 507, locale),
  reviewMember(reviewBooks[0]!, 508, locale, 'A second occurrence for our reread, with an independent curator note.'),
  reviewMember(reviewBooks[7]!, 509, locale),
];

type Subject = SubjectRead['subject'];
type Statement = Subject['statements'][string][number];
function statement(property: string, content: unknown, index: number): Statement {
  return {
    id: reviewId(10000 + index),
    property: {
      id: property,
      data_type: definitions.release.properties[property as keyof typeof definitions.release.properties]!.datatype,
    },
    value: { type: 'value', content },
    rank: 'normal',
    qualifiers: [],
    references: [],
    rezics: { release: definitions.digest, revision: 1 },
  };
}
export function reviewSubjectRead(id: string, locale = 'en'): SubjectRead | undefined {
  const entry = reviewItemMap.get(id);
  const reference = [...reviewCreators, ...reviewGenres].find((row) => row.id === id);
  if (!entry && !reference) return;
  const type = entry?.type ?? (reviewCreators.some((row) => row.id === id) ? 'schema:Person' : 'skos:Concept');
  const rows: Statement[] = [];
  if (entry?.creator) rows.push(statement(entry.creatorProperty ?? 'schema:author', entry.creator.id, rows.length));
  if (entry?.year !== undefined)
    rows.push(
      statement(
        'schema:datePublished',
        {
          time: `+${entry.year}-00-00T00:00:00Z`,
          precision: 9,
          calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
        },
        rows.length,
      ),
    );
  if (entry?.words !== undefined)
    rows.push(statement('schema:wordCount', { amount: `+${entry.words}`, unit: '1' }, rows.length));
  if (entry) rows.push(statement('schema:genre', entry.genre.id, rows.length));
  const labels = entry?.labels ?? { en: reference!.label };
  const language = labels[locale] ? locale : 'en';
  return {
    subject: {
      id,
      type,
      labels,
      descriptions: entry ? { en: entry.description } : {},
      aliases: {},
      revision: 1,
      release: definitions.digest,
      context: '00000000-0000-8000-8000-000000000000',
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
      statements: Object.groupBy(rows, (row) => row.property.id) as Subject['statements'],
    },
    summary: entry
      ? reviewSummary(entry, locale)
      : {
          id,
          type,
          types: [type],
          label: { value: labels[language]!, language },
          creativeWork: false,
          cover: null,
        },
    account: null,
    related: Object.fromEntries(
      [...reviewCreators, ...reviewGenres].map((row) => [
        row.id,
        {
          labels: { en: row.label },
          type: reviewCreators.some((creator) => creator.id === row.id) ? 'schema:Person' : 'skos:Concept',
        },
      ]),
    ),
  };
}

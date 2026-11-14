import type { KernelClient, SubjectRead } from '@rezics/client';
import { bundledRelease } from '@rezics/definitions/bundled';
import { releaseDigest } from '@rezics/definitions';
import synopsis from './anime-synopsis.json';

/** One invented production, shared by every routed showcase entry and locale. */
export const animeId = (n: number) => `0193a000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const anime = { id: animeId(1), label: 'The Last Observatory' };
export const animeDirector = { id: animeId(10), label: 'Aoi Mizuhara' };
export const animeWriter = { id: animeId(11), label: 'Ren Asakura' };
export const animeComposer = { id: animeId(12), label: 'Mika Sen' };
export const animeStudio = { id: animeId(13), label: 'Studio Blue Hour' };
export const animeVoice = { id: animeId(14), label: 'Hana Mori' };
export const animeCharacter = { id: animeId(20), label: 'Nagi' };
export const animeFriend = { id: animeId(21), label: 'Toma' };
export const animeSpecial = { id: animeId(30), label: 'A Letter to the Morning Star' };
export const animeRealm = animeId(40);
export const animeContext = animeId(41);
export const animeSource = 'https://blue-hour.example/observatory/catalogue';
export const animeRelease = bundledRelease;
export const animeDigest = releaseDigest(animeRelease);
export const animeGlobal = '00000000-0000-8000-8000-000000000000';

type Subject = SubjectRead['subject'];
type Statement = Subject['statements'][string][number];
type Snak = Statement['qualifiers'][number];
type Summary = NonNullable<SubjectRead['summary']>;
type LabelledSummary = Summary & { label: NonNullable<Summary['label']> };
export type AnimeDocument = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['documents']>['get']>>['data']
>['document'];

const snak = (property: string, content: unknown): Snak => ({
  property: { id: property, data_type: animeRelease.properties[property]!.datatype },
  value: { type: 'value', content },
});
let statementId = 10000;
export function animeStatement(property: string, content: unknown, qualifiers: Snak[] = []): Statement {
  return {
    id: animeId(statementId++),
    rank: 'normal',
    ...snak(property, content),
    qualifiers,
    references: [{ hash: 'observatory-production-register', parts: [snak('schema:url', animeSource)] }],
    rezics: { release: animeDigest, revision: 1 },
  };
}
const date = (value: string, precision = 11) => ({
  time: `+${value}T00:00:00Z`,
  precision,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
const quantity = (value: number) => ({ amount: `+${value}`, unit: '1' });
const position = (value: string) => [snak('schema:position', value)];
const spoiler = (level: number) => snak('rezics:spoilerLevel', quantity(level));
function subject(id: string, type: string, label: string, rows: Statement[] = []): Subject {
  return {
    id,
    type,
    revision: 1,
    release: animeDigest,
    context: animeGlobal,
    resolution: {},
    relationCounts: {},
    labels: { en: label },
    descriptions: {},
    aliases: {},
    statements: Object.groupBy(rows, (row) => row.property.id) as Subject['statements'],
    sourceRecords: [],
  };
}
const productionCredits = () => [
  animeStatement('schema:director', animeDirector.id, position('1')),
  animeStatement('wdt:P58', animeWriter.id, position('1')),
  animeStatement('schema:musicBy', animeComposer.id),
  animeStatement('schema:productionCompany', animeStudio.id),
  animeStatement('wdt:P725', animeVoice.id, [...position('1'), snak('wdt:P453', animeCharacter.id)]),
];
const appearances = () => [
  animeStatement('schema:character', animeCharacter.id),
  animeStatement('schema:character', animeFriend.id, [spoiler(1)]),
];
const series = subject(anime.id, 'schema:TVSeries', anime.label, [
  ...productionCredits(),
  ...appearances(),
  animeStatement('schema:datePublished', date('2023-01-01', 9)),
  animeStatement('schema:startDate', date('2023-04-01', 10)),
  animeStatement('schema:endDate', date('2025-09-27')),
  animeStatement('schema:inLanguage', 'ja'),
  animeStatement('schema:numberOfEpisodes', quantity(28)),
  animeStatement('schema:genre', animeId(22)),
  animeStatement('schema:keywords', animeId(23)),
  animeStatement('schema:abstract', { language: 'en', document: animeId(90), digest: synopsis.digest }),
]);
series.labels = {
  en: anime.label,
  ja: '最後の天文台',
  'zh-Hant': '最後的天文台',
  'zh-Hans': '最后的天文台',
  ko: '마지막 천문대',
  de: 'Die letzte Sternwarte',
  fr: 'Le dernier observatoire',
  es: 'El último observatorio',
};
series.descriptions = {
  en: 'A quiet coming-of-age anime about a hilltop observatory, the people who keep it open, and a city learning to look up.',
  ja: '閉館が決まった丘の上の天文台。星を見上げる人々と、見習い観測員の季節を描く。',
};
series.aliases = { en: ['Last Light on the Hill', 'Observatory'], ja: ['天文台の最後の季節'] };
series.sourceRecords = [
  {
    name: 'Studio Blue Hour production register',
    url: animeSource,
    attribution: 'REZICS synthetic production catalogue',
    licence: { id: 'CC0-1.0' },
  },
];

const seasonSpecs = [
  ['Season One · The Hill of Small Lights', '1', '2023-04-01', 10, 22],
  ['Season Two · Letters Across the Sky', '2', '2025-07-05', 11, 6],
  ['Season Three · An Unwritten Sky', '3', null, null, null],
] as const;
export const animeSeasons = seasonSpecs.map(([title, order, published, precision, count], index) => {
  const item = subject(animeId(100 + index), 'schema:TVSeason', title, [
    // This assertion is the installed inverse reading projection, not a claim of Season write admission.
    animeStatement('schema:isPartOf', anime.id, position(order)),
    ...(published ? [animeStatement('schema:datePublished', date(published, precision))] : []),
    ...(count
      ? [animeStatement('schema:numberOfEpisodes', quantity(count)), ...productionCredits(), ...appearances()]
      : []),
    ...(index === 1 ? [animeStatement('wdt:P155', animeId(100))] : []),
  ]);
  item.descriptions =
    index === 2
      ? {}
      : {
          en:
            index === 0
              ? 'Nagi begins work at the observatory. The city below is changing, and every visitor brings a different reason to watch the night sky.'
              : 'A packet of undelivered letters sends Nagi and Toma beyond the hill, following a constellation of ordinary lives.',
        };
  return item;
});
const episodeTitles = [
  'The Key at the Foot of the Hill',
  'A Window Facing North',
  'The Visitor with Two Umbrellas',
  'Clouds over the Planetarium',
  'A Map of Familiar Streets',
  'The Night Bus Home',
  'The Music in the Dome',
  'A Star Nobody Named',
  'Two Cups on the Windowsill',
  'A Light beyond the Station',
  'When the City Sleeps',
  'The First Clear Evening',
  'A Telescope for Tomorrow',
  'The Quietest Room',
  'A Postcard without an Address',
  'The Long Way up the Hill',
  'The Keeper of the Keys',
  'The Winter Triangle',
  'An Empty Chair under the Stars',
  'Someone Is Still Watching',
  'Before the Doors Close',
  'All the Lights We Leave Behind',
  'A Letter from Another Summer',
  'The Constellation of Small Things',
  'Beyond the Last Train',
  'The Unfinished Star Chart',
  'A City Looking Up',
  'The Morning after the Meteor Shower',
];
export const animeEpisodes = episodeTitles.map((title, index) => {
  const season = index < 22 ? animeSeasons[0]! : animeSeasons[1]!;
  const order = index < 22 ? index + 1 : index - 21;
  const item = subject(animeId(200 + index), 'schema:Episode', title, [
    animeStatement('schema:isPartOf', season.id, position(String(order))),
    animeStatement('schema:episodeNumber', String(order)),
    animeStatement('schema:duration', { amount: '+1440', unit: 'http://www.wikidata.org/entity/Q11574' }),
    animeStatement('schema:inLanguage', 'ja'),
    animeStatement('schema:director', animeDirector.id),
    ...(index === 0 ? appearances() : []),
  ]);
  item.descriptions = {
    en:
      index === 0
        ? 'On her first evening as an apprentice observer, Nagi finds a key left beneath a broken telescope. A stranger at the gate is waiting for the sky to clear.'
        : 'An evening at the observatory brings another encounter, another small question, and a new way of seeing the city below.',
  };
  return item;
});
const special = subject(animeSpecial.id, 'schema:Movie', animeSpecial.label, [
  animeStatement('rezics:sideStoryOf', anime.id),
  animeStatement('schema:datePublished', date('2024-08-01', 10)),
  animeStatement('schema:inLanguage', 'ja'),
  ...productionCredits(),
]);
special.descriptions = {
  en: 'A companion film following the night bus driver during the observatory’s summer closure.',
};
const people = [
  subject(animeDirector.id, 'schema:Person', animeDirector.label),
  subject(animeWriter.id, 'schema:Person', animeWriter.label),
  subject(animeComposer.id, 'schema:Person', animeComposer.label),
  subject(animeVoice.id, 'schema:Person', animeVoice.label),
  subject(animeStudio.id, 'schema:Organization', animeStudio.label),
];
const characters = [
  subject(animeCharacter.id, 'wd:Q95074', animeCharacter.label),
  subject(animeFriend.id, 'wd:Q95074', animeFriend.label),
];
characters[0]!.descriptions = {
  en: 'An apprentice observer who knows every path up the hill and is learning to ask for help.',
};
characters[1]!.descriptions = { en: 'A letter carrier who takes the long way home.' };
const concepts = [
  subject(animeId(22), 'skos:Concept', 'Coming of age'),
  subject(animeId(23), 'skos:Concept', 'Astronomy'),
];
export const animeSubjects = [
  series,
  ...animeSeasons,
  ...animeEpisodes,
  special,
  ...people,
  ...characters,
  ...concepts,
];
export const animeSubjectMap = new Map(animeSubjects.map((item) => [item.id, item]));
export const isAnimeShowcase = (id: string | undefined): id is string => id !== undefined && animeSubjectMap.has(id);

export function animeSummary(id: string, locale = 'en'): LabelledSummary {
  const item = animeSubjectMap.get(id)!;
  const language = item.labels[locale] ? locale : 'en';
  const type = animeRelease.types[item.type]!;
  const creativeWork = item.type === 'schema:TVSeries' || type.bases.includes('schema:CreativeWork');
  const seasonIndex = animeSeasons.findIndex((season) => season.id === id);
  const isEpisode = item.type === 'schema:Episode';
  const media = animeId(isEpisode ? 74 : seasonIndex >= 0 ? 71 + seasonIndex : 70);
  const sparse = id === animeSeasons[2]!.id;
  return {
    id,
    type: item.type,
    types: [item.type, ...type.bases],
    creativeWork,
    label: { value: item.labels[language]!, language },
    cover:
      creativeWork && !sparse
        ? {
            media,
            width: 640,
            height: isEpisode ? 360 : 960,
            placeholder: { thumbhash: '', color: isEpisode ? '#233e50' : '#183545' },
            variants: [
              { format: 'webp', width: 320 },
              { format: 'webp', width: 640 },
            ],
            focalPoint: null,
            credit: {
              rightsHolder: 'REZICS story illustration',
              license: 'CC0-1.0',
              obligations: [],
              via: {
                name: 'Authored Observatory artwork',
                url: 'https://github.com/rezics/rezics-next/tree/main/apps/web/.storybook/media',
              },
            },
          }
        : null,
  };
}
export function animeSubjectRead(id: string, locale = 'en', context = animeGlobal): SubjectRead {
  const item = animeSubjectMap.get(id)!;
  const related = Object.fromEntries(
    Object.values(item.statements)
      .flat()
      .flatMap((statement) => {
        const parts = [statement, ...statement.qualifiers];
        return parts.flatMap((part) =>
          part.value.type === 'value' &&
          typeof part.value.content === 'string' &&
          animeSubjectMap.has(part.value.content)
            ? [
                [
                  part.value.content,
                  {
                    ...animeSummary(part.value.content, locale),
                    labels: animeSubjectMap.get(part.value.content)!.labels,
                  },
                ],
              ]
            : [],
        );
      }),
  );
  return { subject: { ...item, context }, summary: animeSummary(id, locale), related, account: null };
}
export function animeSynopsisDocument(): AnimeDocument {
  const statement = series.statements['schema:abstract']![0]!;
  return {
    id: animeId(90),
    subjectId: anime.id,
    candidateId: statement.id,
    revision: 1,
    origin: 'account',
    author: '01a17a3a-20f5-72aa-9f14-f4cc56678188',
    licence: 'CC0-1.0',
    language: 'en',
    digest: synopsis.digest,
    availability: 'available',
    body: synopsis.body as NonNullable<AnimeDocument['body']>,
  };
}
export function animePageSubjectRead(id: string, locale: string, context: string) {
  const read = animeSubjectRead(id, locale, context);
  if (id !== anime.id) return read;
  const document = animeSynopsisDocument();
  return { ...read, documents: { [document.candidateId]: document } };
}

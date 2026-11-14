import type { SubjectRead, WorkReleaseCard } from '@rezics/client';
import { PAGE_GLOBAL_CONTEXT, pickText } from '@rezics/composition';
import type { Release } from '@rezics/definitions';
import definitions from '../recorded/definitions-release.json';

/** Invented game, release catalogue and people. Never a provider recording or a real game's bibliography. */
export const gameId = (n: number) => `0193d000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const game = { id: gameId(1), label: 'Harbour Lights' };
export const gameSparse = { id: gameId(2), label: 'Harbour Lights: The Uncharted Shore' };
export const gameStudio = { id: gameId(3), label: 'North Quay Studio' };
export const gamePublisher = { id: gameId(4), label: 'Paper Lantern Interactive' };
export const gameDirector = { id: gameId(5), label: 'Mira Aoki' };
export const gameComposer = { id: gameId(6), label: 'Jonas Vale' };
export const gameSeries = { id: gameId(7), label: 'Stories from the North Quay' };
export const gameSource = 'https://north-quay.example/harbour-lights/catalogue';
export const gameDefinitions = definitions.release as Release;
export const gameDigest = definitions.digest;
type Subject = SubjectRead['subject'];
type Statement = Subject['statements'][string][number];
type Snak = Statement['qualifiers'][number];
type Summary = NonNullable<SubjectRead['summary']> & { label: { value: string; language: string } };
let serial = 10000;
export const gameSnak = (property: string, content: unknown): Snak => ({
  property: { id: property, data_type: gameDefinitions.properties[property]!.datatype },
  value: { type: 'value', content },
});
export function gameStatement(property: string, content: unknown, qualifiers: Snak[] = []): Statement {
  return {
    id: gameId(serial++),
    rank: 'normal',
    ...gameSnak(property, content),
    qualifiers,
    references: [{ hash: 'synthetic-game-catalogue', parts: [gameSnak('schema:url', gameSource)] }],
    rezics: { release: gameDigest, revision: 1 },
  };
}
export const gameDate = (value: string, precision = 11) => ({
  time: `+${value}T00:00:00Z`,
  precision,
  timezone: 0,
  before: 0,
  after: 0,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
function subject(n: number, type: string, label: string, rows: Statement[] = [], description = ''): Subject {
  return {
    id: gameId(n),
    type,
    revision: 1,
    release: gameDigest,
    context: PAGE_GLOBAL_CONTEXT,
    labels: { en: label },
    descriptions: description ? { en: description } : {},
    aliases: {},
    statements: Object.groupBy(rows, (row) => row.property.id) as Subject['statements'],
    relationCounts: {},
    resolution: {},
    sourceRecords: [{ name: 'Synthetic North Quay catalogue', url: gameSource, licence: { id: 'CC0-1.0' } }],
  };
}
const primary = subject(1, 'schema:VideoGame', game.label, [
  gameStatement('wdt:P178', gameStudio.id),
  gameStatement('schema:publisher', gamePublisher.id),
  gameStatement('schema:director', gameDirector.id),
  gameStatement('schema:author', gameDirector.id),
  gameStatement('schema:musicBy', gameComposer.id),
  gameStatement('schema:gamePlatform', gameId(20)),
  gameStatement('schema:gamePlatform', gameId(21)),
  gameStatement('schema:gamePlatform', gameId(22)),
  gameStatement('schema:inLanguage', 'en'),
  gameStatement('schema:inLanguage', 'ja'),
  gameStatement('schema:inLanguage', 'zh-Hant'),
  gameStatement('schema:datePublished', gameDate('2023-10-12')),
  gameStatement('schema:creativeWorkStatus', gameId(25)),
  gameStatement('wdt:P408', gameId(23)),
  gameStatement('schema:numberOfPlayers', { amount: '+1', unit: '1' }),
  gameStatement('schema:genre', gameId(27)),
  gameStatement('schema:keywords', gameId(28)),
  gameStatement('wdt:P179', gameSeries.id, [gameSnak('schema:position', '1')]),
]);
primary.labels = {
  en: game.label,
  ja: '港の灯り',
  'zh-Hant': '港灣燈火',
  'zh-Hans': '港湾灯火',
  ko: '항구의 불빛',
  de: 'Lichter im Hafen',
  fr: 'Les lumières du port',
  es: 'Luces del puerto',
};
primary.aliases = { en: ['Harbor Lights', 'North Quay Stories: Harbour Lights'], ja: ['みなとのあかり'] };
primary.descriptions = {
  en: 'Keep the lighthouse shining. A story-driven exploration game about a coastal town, the people who leave and the people who stay.\n\nReturn to North Quay as Iona, an apprentice lighthouse keeper. Mend the lamp, chart the islands and learn why the night ferry has stopped calling. Days follow the tide: explore the harbour, restore its forgotten paths and choose which neighbours to spend the evening with.\n\nConversations, hand-drawn maps and small environmental puzzles carry the story. There is no combat and no countdown. A missed conversation can be found again on another tide. The changing weather and a score built from piano, strings and distant ship bells make each crossing feel different.\n\nThe original story stands on its own. The Last Ferry is a separate add-on, while the Complete release bundles both works. Platform and language availability belong to the exact releases below.',
  ja: '灯台の明かりを守り、潮の満ち引きとともに変わる港町を歩く物語。見習い灯台守イオナが、島々を巡り、住人たちの声に耳を傾けます。',
  'zh-Hant':
    '讓燈塔繼續發光。回到北碼頭，修復舊路、探索島嶼，在潮汐之間聆聽居民的故事。沒有戰鬥，也沒有倒數；錯過的對話會在下一次潮水回來。',
  'zh-Hans': '让灯塔继续发光。回到北码头，修复旧路、探索岛屿，在潮汐之间聆听居民的故事。没有战斗，也没有倒数。',
  ko: '등대의 불빛을 지키세요. 조수에 따라 달라지는 항구를 탐험하고 이웃의 이야기를 듣는 게임입니다.',
  de: 'Halte das Leuchtfeuer am Brennen. Erkunde eine Küstenstadt im Wechsel der Gezeiten und lerne die Menschen kennen, die bleiben oder weiterziehen.',
  fr: 'Gardez le phare allumé. Explorez une ville côtière au rythme des marées et écoutez les histoires de ses habitants.',
  es: 'Mantén encendido el faro. Explora un pueblo costero al ritmo de las mareas y escucha las historias de sus habitantes.',
};

const concepts = [
  subject(20, 'skos:Concept', 'Windows'),
  subject(21, 'skos:Concept', 'Nintendo Switch'),
  subject(22, 'skos:Concept', 'Linux'),
  subject(23, 'skos:Concept', 'Godot'),
  subject(24, 'skos:Concept', 'macOS'),
  subject(25, 'skos:Concept', 'Released'),
  subject(26, 'skos:Concept', 'In development'),
  subject(27, 'skos:Concept', 'Narrative adventure'),
  subject(28, 'skos:Concept', 'Coastal life'),
  subject(29, 'skos:Concept', 'Digital download'),
  subject(30, 'skos:Concept', 'Physical game card'),
  subject(31, 'skos:Concept', 'Complete work'),
  subject(32, 'skos:Concept', 'Trial / prologue'),
];
const people = [
  subject(
    3,
    'schema:Organization',
    gameStudio.label,
    [],
    'An independent team making stories about places and the people who call them home.',
  ),
  subject(
    4,
    'schema:Organization',
    gamePublisher.label,
    [],
    'Publisher of the North Quay games and their localized releases.',
  ),
  subject(5, 'schema:Person', gameDirector.label, [], 'Writer and director of Harbour Lights.'),
  subject(6, 'schema:Person', gameComposer.label, [], 'Composer of the piano, strings and ship-bell score.'),
  subject(8, 'schema:Person', 'Leila Mori', [], 'Art director and illustrator of the North Quay maps.'),
  subject(9, 'schema:Person', 'Sam Rivera', [], 'English voice of Iona.'),
  subject(10, 'schema:Person', 'Haru Sato', [], 'Japanese localization and dialogue adaptation.'),
];
primary.statements['schema:illustrator'] = [gameStatement('schema:illustrator', gameId(8))];
primary.statements['schema:contributor'] = [
  gameStatement('schema:contributor', gameId(10), [gameSnak('wdt:P1932', 'Haru Sato — Japanese localization')]),
];
primary.statements['wdt:P725'] = [gameStatement('wdt:P725', gameId(9), [gameSnak('schema:character', gameId(50))])];
export const gameCharacters = [
  subject(50, 'wd:Q95074', 'Iona, the lighthouse keeper', [], 'A mapmaker learning to find her way home.'),
  subject(51, 'wd:Q95074', 'Tariq, the ferry captain', [], 'He knows every island and avoids one crossing.'),
  subject(52, 'wd:Q95074', 'Jun, keeper of the night market', [], 'A neighbour with a story for every tide.'),
];
primary.statements['schema:character'] = gameCharacters.map((item, index) =>
  gameStatement('schema:character', item.id, [gameSnak('schema:position', String(index + 1))]),
);
export const gameContents = ['The Lamp Room', 'Across the Low-Water Road', 'The Night Ferry'].map((label, index) =>
  subject(
    60 + index,
    'wd:Q2620972',
    label,
    [gameStatement('wdt:P361', game.id, [gameSnak('schema:position', String(index + 1))])],
    `Act ${index + 1} of Harbour Lights. Catalogue information about the game narrative; no hosted playable content.`,
  ),
);
export const gameAddon = subject(
  70,
  'wd:Q209163',
  'Harbour Lights: The Last Ferry',
  [
    gameStatement('wdt:P8646', game.id),
    gameStatement('wdt:P178', gameStudio.id),
    gameStatement('schema:datePublished', gameDate('2025-02-20')),
  ],
  'A separate add-on story following Tariq on the winter ferry route. Requires the base game.',
);
export const gameRelated = [
  subject(
    71,
    'schema:VideoGame',
    'The Orchard at Low Tide',
    [
      gameStatement('rezics:sideStoryOf', game.id),
      gameStatement('wdt:P178', gameStudio.id),
      gameStatement('wdt:P179', gameSeries.id, [gameSnak('schema:position', '2')]),
    ],
    'A companion adventure set on the next island. A separate work in Stories from the North Quay.',
  ),
  subject(
    72,
    'schema:VideoGame',
    'Letters from the Breakwater',
    [
      gameStatement('rezics:sameSetting', game.id),
      gameStatement('wdt:P178', gameStudio.id),
      gameStatement('wdt:P179', gameSeries.id, [gameSnak('schema:position', '3')]),
    ],
    'A letter-writing adventure in the same coastal setting.',
  ),
];
primary.statements['rezics:sameSetting'] = [gameStatement('rezics:sameSetting', gameRelated[1]!.id)];

/** Dates belong to distinct authored release identities, never platform/language cross products. */
const releaseSpecs = [
  {
    name: 'Original PC release',
    platform: 20,
    languages: ['en', 'ja'],
    date: gameDate('2023-10-12'),
    version: '1.0',
    complete: 31,
    format: 29,
  },
  {
    name: 'Switch game card',
    platform: 21,
    languages: ['en', 'ja', 'zh-Hant'],
    date: gameDate('2024-05-23'),
    version: '1.2',
    complete: 31,
    format: 30,
  },
  {
    name: 'Linux release',
    platform: 22,
    languages: ['en', 'ja', 'zh-Hant'],
    date: gameDate('2024-08-00', 10),
    version: '1.3',
    complete: 31,
    format: 29,
  },
  {
    name: 'Complete PC release',
    platform: 20,
    languages: ['en', 'ja', 'zh-Hant'],
    date: gameDate('2025-02-20'),
    version: '2.0',
    complete: 31,
    format: 29,
  },
  {
    name: 'macOS release',
    platform: 24,
    languages: ['en', 'ja'],
    date: null,
    version: '2.1',
    complete: 31,
    format: 29,
  },
  {
    name: 'Festival prologue',
    platform: 20,
    languages: ['en'],
    date: gameDate('2023-06-00', 10),
    version: '0.8',
    complete: 32,
    format: 29,
  },
] as const;
export const gameReleases = releaseSpecs.map((spec, index) => {
  const date = gameStatement('schema:datePublished', spec.date);
  if (!spec.date) date.value = { type: 'somevalue' };
  const item = subject(
    100 + index,
    'wd:Q20631656',
    `${game.label} · ${spec.name}`,
    [
      gameStatement('schema:exampleOfWork', game.id, [gameSnak('wdt:P31', gameId(spec.complete))]),
      gameStatement('schema:gamePlatform', gameId(spec.platform)),
      ...spec.languages.map((language) => gameStatement('schema:inLanguage', language)),
      date,
      gameStatement('schema:creativeWorkStatus', gameId(spec.date ? 25 : 26)),
      gameStatement('schema:publisher', gamePublisher.id),
      gameStatement('wdt:P178', gameStudio.id),
      gameStatement('schema:producer', gameStudio.id),
      gameStatement('wdt:P437', gameId(spec.format)),
      gameStatement('wdt:P2899', { amount: '+7', unit: 'http://www.wikidata.org/entity/Q577' }),
    ],
    `${spec.name} (${spec.version}). ${spec.complete === 32 ? 'A trial containing the opening act, not the complete work.' : 'A complete release of Harbour Lights.'} ${spec.date ? 'Its date and languages are specific to this release.' : 'The release date has not been announced.'}`,
  );
  if (index === 3) {
    // The native association is multivalued only when the installed release admits it. This catalogue
    // describes the add-on in prose rather than inventing a second exampleOfWork assertion.
    item.descriptions.en += ' Includes The Last Ferry add-on.';
    item.statements['rezics:releaseSupersedes'] = [gameStatement('rezics:releaseSupersedes', gameId(100))];
  }
  item.aliases = { en: [spec.name] };
  return item;
});
const sparse = subject(2, 'schema:VideoGame', gameSparse.label);
export const gameSubjects = [
  primary,
  sparse,
  ...people,
  ...concepts,
  ...gameCharacters,
  ...gameContents,
  gameAddon,
  ...gameRelated,
  ...gameReleases,
  subject(7, 'wd:Q7725310', gameSeries.label, [], 'Independent stories set around North Quay.'),
];
export const gameSubjectMap = new Map(gameSubjects.map((item) => [item.id, item]));
export const isGameShowcase = (id: string | undefined): id is string => id !== undefined && gameSubjectMap.has(id);
for (const item of gameSubjects)
  item.relationCounts = Object.fromEntries(
    Object.entries(item.statements)
      .filter(([property]) => gameDefinitions.properties[property]!.datatype === 'wikibase-item')
      .map(([property, rows]) => [property, rows.length]),
  );
export function gameSummary(id: string, locale = 'en'): Summary {
  const item = gameSubjectMap.get(id)!;
  const label = pickText(item.labels, locale);
  const creativeWork = ['schema:VideoGame', 'wd:Q20631656', 'wd:Q209163', 'wd:Q2620972', 'wd:Q7725310'].includes(
    item.type,
  );
  const media = gameId(item.type === 'wd:Q20631656' ? 81 : item.id === gameAddon.id ? 82 : 80);
  return {
    id,
    type: item.type,
    types: [item.type, ...gameDefinitions.types[item.type]!.bases],
    label: { value: label.text, language: label.lang ?? 'en' },
    creativeWork,
    cover:
      creativeWork && id !== gameSparse.id
        ? {
            media,
            width: 640,
            height: 896,
            placeholder: { thumbhash: '', color: '#173e4c' },
            variants: [
              { format: 'webp', width: 320 },
              { format: 'webp', width: 640 },
            ],
            focalPoint: null,
            credit: {
              rightsHolder: 'REZICS synthetic Game showcase',
              license: 'CC0-1.0',
              obligations: [],
              via: {
                name: 'Original Harbour Lights cover illustration',
                url: 'https://github.com/rezics/rezics-next/tree/main/apps/web/.storybook/media',
              },
            },
          }
        : null,
  };
}
export function gameSubjectRead(id: string, locale = 'en', context = PAGE_GLOBAL_CONTEXT): SubjectRead {
  const item = gameSubjectMap.get(id)!;
  const targets = Object.values(item.statements)
    .flat()
    .flatMap((row) => [row, ...row.qualifiers, ...row.references.flatMap((ref) => ref.parts)]);
  const related = Object.fromEntries(
    targets.flatMap((snak) =>
      snak.value.type === 'value' && typeof snak.value.content === 'string' && gameSubjectMap.has(snak.value.content)
        ? [
            [
              snak.value.content,
              { ...gameSummary(snak.value.content, locale), labels: gameSubjectMap.get(snak.value.content)!.labels },
            ],
          ]
        : [],
    ),
  );
  return { subject: { ...item, context }, summary: gameSummary(id, locale), related, account: null };
}
export function gameReleaseCard(id: string, locale: string): WorkReleaseCard {
  const read = gameSubjectRead(id, locale);
  const properties = [
    'schema:gamePlatform',
    'schema:inLanguage',
    'schema:datePublished',
    'schema:creativeWorkStatus',
    'wdt:P5804',
    'rezics:releaseStatus',
    'wdt:P2899',
    'schema:contentRating',
    'schema:publisher',
    'schema:producer',
    'wdt:P162',
    'wdt:P178',
  ] as const;
  const related = Object.fromEntries(Object.keys(read.related).map((key) => [key, gameSummary(key, locale)]));
  return {
    subject: id,
    type: read.subject.type,
    summary: gameSummary(id, locale),
    membership: read.subject.statements['schema:exampleOfWork']![0]!,
    related,
    fields: Object.fromEntries(
      properties.map((property) => [
        property,
        read.subject.statements[property]?.length
          ? { state: 'available', statements: read.subject.statements[property], related }
          : {
              state: gameDefinitions.types[read.subject.type]!.properties.includes(property)
                ? 'missing'
                : 'unsupported',
            },
      ]),
    ) as WorkReleaseCard['fields'],
  };
}

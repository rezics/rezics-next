import type { KernelClient, SubjectRead } from '@rezics/client';
import synopsis from './book-synopsis.json';
import definitions from '../recorded/definitions-release.json';

/** Invented bibliography shared by the real-page showcase and its transport. */
export const bookId = (n: number) => `0193b000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const book = { id: bookId(1), label: 'The Atlas of Borrowed Days' };
export const bookSeries = { id: bookId(2), label: 'The Tide Archive' };
export const bookAuthor = { id: bookId(3), label: 'Nao Mizuno' };
export const bookCoauthor = { id: bookId(4), label: 'Elian Vale' };
export const bookIllustrator = { id: bookId(5), label: 'Leila Haddad' };
export const bookPublisher = { id: bookId(6), label: 'Lantern Quay Press' };
export const bookTranslator = { id: bookId(7), label: 'Mara Chen' };
export const bookRealm = bookId(8);
export const bookContext = bookId(9);
export const bookSparse = { id: bookId(10), label: 'A Map Still Unfolding' };
export const bookLong = {
  id: bookId(11),
  label:
    'The Atlas of Borrowed Days — Letters from the City Beyond the Last Tide, an Annotated Chronicle of Names, Memory and Returning Home',
};
export const bookCover = bookId(70);
export const bookSource = 'https://lantern-quay.example/books/atlas';

type Subject = SubjectRead['subject'];
type Statement = Subject['statements'][string][number];
type Snak = Statement['qualifiers'][number];
type Summary = NonNullable<SubjectRead['summary']>;
const release = definitions.release;
let assertion = 10000;
const snak = (property: string, content: unknown): Snak => ({
  property: { id: property, data_type: release.properties[property as keyof typeof release.properties].datatype },
  value: { type: 'value', content },
});
const reference = (url = bookSource) => ({ hash: 'book-bibliography', parts: [snak('schema:url', url)] });
export function bookStatement(property: string, content: unknown, qualifiers: Snak[] = []): Statement {
  return {
    id: bookId(assertion++),
    rank: 'normal',
    ...snak(property, content),
    qualifiers,
    references: [reference()],
    rezics: { release: definitions.digest, revision: 1 },
  };
}
const date = (value: string, precision = 11) => ({
  time: `+${value}T00:00:00Z`,
  precision,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
const quantity = (amount: number) => ({ amount: `+${amount}`, unit: '1' });
const statements = (...rows: Statement[]): Subject['statements'] =>
  Object.groupBy(rows, (row) => row.property.id) as Subject['statements'];
const position = (value: number) => [snak('schema:position', String(value))];
const sources: Subject['sourceRecords'] = [
  {
    name: 'Lantern Quay bibliography',
    url: bookSource,
    attribution: 'Lantern Quay editorial collective',
    licence: { id: 'CC0-1.0', url: 'https://creativecommons.org/publicdomain/zero/1.0/' },
  },
  {
    name: 'Tide Archive bibliographic register',
    url: 'https://tide-archive.example/catalogue/atlas',
    attribution: 'Tide Archive librarians and volunteer bibliographers',
    licence: { id: 'CC-BY-4.0' },
  },
];
function subject(id: string, type: string, label: string, rows: Statement[] = []): Subject {
  return {
    id,
    type,
    revision: 1,
    release: definitions.digest,
    context: '00000000-0000-8000-8000-000000000000',
    resolution: {},
    relationCounts: {},
    labels: { en: label },
    descriptions: {},
    aliases: {},
    statements: statements(...rows),
    sourceRecords: [],
  };
}
const primary = subject(book.id, 'schema:Book', book.label, [
  bookStatement('schema:author', bookAuthor.id, position(1)),
  bookStatement('schema:author', bookCoauthor.id, position(2)),
  bookStatement('schema:illustrator', bookIllustrator.id),
  bookStatement('schema:datePublished', date('2014-09-18')),
  bookStatement('schema:inLanguage', 'ja'),
  bookStatement('schema:wordCount', quantity(128400)),
  bookStatement('schema:genre', bookId(20)),
  bookStatement('schema:keywords', bookId(21)),
  bookStatement('wdt:P179', bookSeries.id, position(1)),
  bookStatement('schema:abstract', { language: 'en', document: bookId(90), digest: synopsis.digest }),
]);
primary.labels = {
  en: book.label,
  ja: '借りた日々の地図帳',
  'zh-Hant': '借來時光的地圖集',
  'zh-Hans': '借来时光的地图集',
  ko: '빌린 날들의 지도책',
  de: 'Atlas der geliehenen Tage',
  fr: 'Atlas des jours empruntés',
  es: 'Atlas de los días prestados',
};
primary.descriptions = {
  en: 'An illustrated literary fantasy about a harbour city, forgotten days and finding a way home.',
  ja: '忘れられた日々を記す地図帳と、港町をめぐる物語。',
  'zh-Hant': '一座港城、一本記錄遺忘日子的地圖集，以及尋找歸途的人們。',
};
primary.aliases = {
  en: ['Borrowed Days', 'The Cartographer’s Tide', 'Atlas, Volume One'],
  ja: ['借日地図', '港町の地図帳'],
  'zh-Hant': ['借日圖志'],
  fr: ['Les cartes de la marée'],
};
primary.sourceRecords = sources;
export const editionSpecs = [
  ['First Japanese hardback', 'ja', '2014-09-18', 384, '9784991000003'],
  ['Japanese paperback', 'ja', '2016-04-12', 416, '9784991000010'],
  ['English translation · hardback', 'en', '2018-03-06', 352, '9784991000027'],
  ['English translation · paperback', 'en', '2019-05-21', 368, '9784991000034'],
  ['Traditional Chinese translation', 'zh-Hant', '2019-10-08', 392, '9784991000041'],
  ['Simplified Chinese translation', 'zh-Hans', '2020-06-16', 392, '9784991000058'],
  ['Korean translation', 'ko', '2020-11-03', 408, '9784991000065'],
  ['French translation', 'fr', '2021-02-11', 376, '9784991000072'],
  ['German translation', 'de', '2021-08-24', 400, '9784991000089'],
  ['Spanish translation', 'es', '2022-04-19', 360, '9784991000096'],
  ['Revised Japanese hardback', 'ja', '2023-09-18', 432, '9784991000102'],
  ['English digital edition', 'en', '2024-01-09', null, '9784991000119'],
  ['Japanese digital edition', 'ja', '2024-02-20', null, '9784991000126'],
  ['Illustrated anniversary edition', 'ja', '2024-09-18', 448, '9784991000133'],
  ['Revised English digital edition', 'en', '2025-05-13', null, '9784991000140'],
] as const;
export const bookEditions = editionSpecs.map(([name, language, published, pages, isbn], index) => {
  const edition = subject(bookId(100 + index), 'bf:Instance', `${book.label} — ${name}`, [
    bookStatement('schema:exampleOfWork', book.id),
    bookStatement('schema:publisher', bookPublisher.id),
    bookStatement('schema:datePublished', date(published)),
    bookStatement('schema:inLanguage', language),
    bookStatement('schema:isbn', isbn),
    ...(pages ? [bookStatement('schema:numberOfPages', quantity(pages))] : []),
    ...(language === 'en' ? [bookStatement('schema:translator', bookTranslator.id)] : []),
  ]);
  edition.descriptions = {
    en: `${name}. ${pages ? `${pages} pages` : 'Reflowable digital publication'}. Published by Lantern Quay Press; a distinct edition of the same literary work.`,
  };
  edition.aliases = { en: [name] };
  edition.sourceRecords = sources;
  return edition;
});
const interludeTitles = [
  'The Clockmaker’s Window',
  'Postcards from Low Water',
  'A Letter in Two Languages',
  'The Orchard under the Station',
  'Night Ferry',
  'A Room for Returning',
  'The Salt Garden',
  'Margins in Blue Ink',
  'What the Diver Kept',
  'The Last Open Library',
  'A Stranger’s Birthday',
  'The Unfinished Bridge',
  'Maps for the Departing',
  'The City at Four in the Morning',
  'A Day to Give Back',
];
export const bookContents = interludeTitles.map((title, index) => {
  const item = subject(bookId(200 + index), 'schema:Book', title, [
    bookStatement('wdt:P361', book.id, position(index + 1)),
    bookStatement('schema:author', index % 2 ? bookCoauthor.id : bookAuthor.id),
    bookStatement('schema:inLanguage', 'ja'),
  ]);
  item.descriptions = {
    en: `Interlude ${index + 1} in the composite novel. Catalogue metadata; no hosted chapter text is implied.`,
  };
  return item;
});
const volumeTitles = ['The Orchard of Returning Ships', 'Letters from the Low-Water City', 'The Ferryman’s Almanac'];
export const seriesVolumes = [
  primary,
  ...volumeTitles.map((title, index) =>
    subject(bookId(300 + index), 'schema:Book', title, [
      bookStatement('wdt:P179', bookSeries.id, position(index + 2)),
      bookStatement('schema:author', bookAuthor.id),
      bookStatement('schema:datePublished', date(`${2016 + index * 2}-09-18`)),
      bookStatement('schema:inLanguage', 'ja'),
    ]),
  ),
];
const series = subject(bookSeries.id, 'schema:BookSeries', bookSeries.label, [
  bookStatement('schema:author', bookAuthor.id),
]);
series.descriptions = { en: 'Four novels set around the same changing harbour, in publication order.' };
const people = [
  subject(bookAuthor.id, 'schema:Person', bookAuthor.label),
  subject(bookCoauthor.id, 'schema:Person', bookCoauthor.label),
  subject(bookIllustrator.id, 'schema:Person', bookIllustrator.label),
  subject(bookPublisher.id, 'schema:Organization', bookPublisher.label),
  subject(bookTranslator.id, 'schema:Person', bookTranslator.label),
  ...[
    'Ada Finch',
    'Tomás Reyes',
    'Hana Mori',
    'Noor Saleh',
    'Jules Marchand',
    'Sofia Lin',
    'Otto Weiss',
    'Mei Tan',
    'Emil Park',
    'Iris Bell',
  ].map((name, index) => subject(bookId(400 + index), 'schema:Person', name)),
];
people[0]!.labels.ja = '水野ナオ';
const characters = [
  'Sora, the apprentice cartographer',
  'The nameless ferryman',
  'Iona, keeper of letters',
  'Tariq, the retired translator',
  'The clockmaker',
  'Jun of the night market',
  'The observatory diver',
  'The river librarian',
  'Mina, the gardener',
  'The returning sailor',
  'Ari, the bridge builder',
  'The salt merchant',
  'The station musician',
  'The child with the red atlas',
  'The keeper of low water',
].map((name, index) => subject(bookId(500 + index), 'wd:Q95074', name));
for (const [index, character] of characters.entries()) {
  (primary.statements['schema:character'] ??= []).push(
    bookStatement('schema:character', character.id, position(index + 1)),
  );
}
for (const [index, person] of people.slice(5).entries()) {
  (primary.statements['schema:contributor'] ??= []).push(
    bookStatement('schema:contributor', person.id, [...position(index + 1), snak('wdt:P1932', person.labels.en!)]),
  );
}
const sideStories = ['The Ferryman Before Dawn', 'An Atlas for Iona', 'Lanterns at the Edge of the Map'].map(
  (title, index) =>
    subject(bookId(600 + index), 'schema:Book', title, [
      bookStatement('rezics:sideStoryOf', book.id),
      bookStatement('schema:author', bookAuthor.id),
    ]),
);
const sparse = subject(bookSparse.id, 'schema:Book', bookSparse.label);
const long = structuredClone(primary);
long.id = bookLong.id;
for (const row of Object.values(long.statements).flat()) row.id = bookId(assertion++);
long.statements['schema:abstract']![0]!.value = {
  type: 'value',
  content: { language: 'en', document: bookId(91), digest: synopsis.digest },
};
long.labels = Object.fromEntries(
  Object.entries(primary.labels).map(([locale, title]) => [
    locale,
    `${title} — ${locale === 'ja' ? '最後の潮の向こうにある街からの手紙、名前と記憶と帰郷についての長い年代記' : bookLong.label.split(' — ')[1]}`,
  ]),
);
long.aliases.en!.push(
  'An extraordinarily long alternate bibliographic title: an atlas of every day that was borrowed, misplaced, translated, remembered and returned to the people of the harbour',
);
export const bookSubjects: Subject[] = [
  primary,
  series,
  ...seriesVolumes.slice(1),
  ...bookEditions,
  ...bookContents,
  ...people,
  ...characters,
  ...sideStories,
  sparse,
  long,
  subject(bookId(20), 'skos:Concept', 'Literary fantasy'),
  subject(bookId(21), 'skos:Concept', 'Memory and belonging'),
];
export const bookSubjectMap = new Map(bookSubjects.map((item) => [item.id, item]));
for (const item of bookSubjects) {
  item.relationCounts = Object.fromEntries(
    Object.entries(item.statements)
      .filter(
        ([property]) => release.properties[property as keyof typeof release.properties].datatype === 'wikibase-item',
      )
      .map(([property, rows]) => [property, rows.length]),
  );
}
export const isBookShowcase = (id: string | undefined) => id !== undefined && bookSubjectMap.has(id);
export function bookSummary(id: string, locale = 'en'): Summary {
  const item = bookSubjectMap.get(id)!;
  const types = release.types as Record<string, { bases: string[] }>;
  const language = item.labels[locale] ? locale : 'en';
  const creativeWork = ['schema:Book', 'schema:BookSeries', 'bf:Instance'].includes(item.type);
  return {
    id,
    type: item.type,
    types: [item.type, ...(types[item.type]?.bases ?? [])],
    label: { value: item.labels[language]!, language },
    creativeWork,
    cover:
      creativeWork && id !== bookSparse.id
        ? {
            media: bookId(70 + (item.type === 'bf:Instance' ? 1 : item.type === 'schema:BookSeries' ? 2 : 0)),
            width: 640,
            height: 960,
            placeholder: { thumbhash: '', color: '#213c47' },
            variants: [
              { format: 'webp', width: 320 },
              { format: 'webp', width: 640 },
            ],
            focalPoint: null,
            credit: { rightsHolder: 'REZICS story illustration', license: 'CC0-1.0' },
          }
        : null,
  };
}
export function bookSubjectRead(
  id: string,
  locale = 'en',
  context = '00000000-0000-8000-8000-000000000000',
): SubjectRead {
  const item = bookSubjectMap.get(id)!;
  const related = Object.fromEntries(
    Object.values(item.statements)
      .flat()
      .flatMap((row) =>
        row.value.type === 'value' && typeof row.value.content === 'string' && bookSubjectMap.has(row.value.content)
          ? [[row.value.content, bookSummary(row.value.content, locale)]]
          : [],
      ),
  );
  return { subject: { ...item, context }, summary: bookSummary(id, locale), related, account: null };
}

type AuthoredDocument = NonNullable<
  Awaited<ReturnType<ReturnType<KernelClient['documents']>['get']>>['data']
>['document'];
export function bookSynopsisDocument(id: string): AuthoredDocument {
  const candidate = bookSubjectMap.get(id)!.statements['schema:abstract']![0]!;
  return {
    id: bookId(id === bookLong.id ? 91 : 90),
    subjectId: id,
    candidateId: candidate.id,
    revision: 1,
    origin: 'account',
    author: '01a17a3a-20f5-72aa-9f14-f4cc56678188',
    licence: 'CC0-1.0',
    language: 'en',
    digest: synopsis.digest,
    availability: 'available',
    body: synopsis.body as AuthoredDocument['body'],
  };
}

/** Page reads embed the separately disclosed native document, keyed by its exact statement. */
export function bookPageSubjectRead(id: string, locale: string, context: string) {
  const read = bookSubjectRead(id, locale, context);
  if (!read.subject.statements['schema:abstract']?.length) return read;
  const document = bookSynopsisDocument(id);
  return { ...read, documents: { [document.candidateId]: document } };
}

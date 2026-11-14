import type { SubjectRead } from '@rezics/client';
import { releaseDigest } from '@rezics/definitions';
import { bundledRelease } from '@rezics/definitions/bundled';
import { planReads, platformRegistry, type CompositionDocument } from '@rezics/composition';
import type { SubjectPageData } from '../../features/pages/page-model';
import type { CommunityThread, SubjectCommunity } from '../../features/pages/subject-community';
import type { FakeRoute } from '../fake-modules';
import type { KernelRecording } from '../fake';
import { gameExample } from '../../features/catalogue/game-reader/examples';
import pageRecording from '../recorded/subject-page.json';
import subjectRecording from '../recorded/subject.json';

export type ReadingExampleDomain = 'book' | 'game' | 'anime';
export type ReadingExampleState = 'rich' | 'sparse' | 'section-failure';
type Statement = SubjectRead['subject']['statements'][string][number];
const id = (n: number) => `00000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const context = subjectRecording.subject.context;
const digest = releaseDigest(bundledRelease);
const identities = {
  book: { id: id(7801), type: 'schema:Book', title: 'Letters from the Harbour', language: 'en' },
  game: { id: id(7802), type: 'schema:VideoGame', title: 'Harbour Lights', language: 'en' },
  anime: { id: id(7803), type: 'schema:TVSeries', title: 'The Last Observatory', language: 'en' },
};

function statement(n: number, property: string, value: Statement['value']): Statement {
  return {
    id: id(n),
    rank: 'normal',
    property: { id: property, data_type: bundledRelease.properties[property]!.datatype },
    value,
    qualifiers: [],
    references: [],
    rezics: { release: digest, revision: 1 },
  };
}

function reviews(subjectId: string, title: string, state: ReadingExampleState): SubjectCommunity {
  const threads: CommunityThread[] = [
    ['A quiet story with a lasting afterglow', 'The small details give the harbour a life beyond the main story.'],
    ['Patient, humane and beautifully paced', 'A thoughtful journey about leaving home and finding a way back.'],
    ['A place I wanted to return to', 'The changing seasons make the familiar setting feel different each time.'],
    ['Notes for a second visit', 'There is more here to notice on a second visit.'],
  ].map(([heading, summary], n) => ({
    id: id(7900 + n),
    title: heading!,
    summary: summary!,
    authorId: id(7950 + n),
    boardId: id(7990),
    createdAt: '2026-09-19T09:00:00Z',
    licence: 'CC-BY-4.0',
    reactions: { like: 4 + n },
  }));
  return {
    now: '2026-10-01T12:00:00Z',
    reader: null,
    contextId: context,
    authors: Object.fromEntries(
      threads.map((thread, n) => [
        thread.authorId,
        {
          id: thread.authorId,
          kind: 'actor' as const,
          handle: `harbour-reader-${n + 1}`,
          displayName: ['Robin', 'Haru', 'Mina', 'Sam'][n]!,
          state: 'active' as const,
          automated: false,
          operatorId: null,
        },
      ]),
    ),
    regions: {
      review:
        state === 'section-failure'
          ? { state: 'unavailable' }
          : {
              state: 'ready',
              threads: state === 'sparse' ? [] : threads,
              next: null,
              context: { subjectId, subjectLabel: title, place: { kind: 'global', id: context } },
              reactionsAsOf: { epoch: 1, position: '1' },
            },
    },
  };
}

/** Authored contract-shaped examples. These are not recorded responses or evidence of native publication. */
export function readingOverviewExample(domain: ReadingExampleDomain, state: ReadingExampleState = 'rich') {
  const identity = identities[domain];
  const release = structuredClone(bundledRelease);
  const game = gameExample(state === 'sparse' ? 'empty' : 'work');
  const publicRead = structuredClone(domain === 'game' ? game.publicRead : subjectRecording) as unknown as SubjectRead;
  Object.assign(publicRead.subject, {
    id: identity.id,
    context,
    type: identity.type,
    labels: { [identity.language]: identity.title, ...(domain === 'anime' ? { ja: '最後の天文台' } : {}) },
    aliases: {},
    release: digest,
    relationCounts: {},
    resolution: {},
    sourceRecords: [],
    descriptions:
      state === 'sparse'
        ? {}
        : {
            en:
              domain === 'book'
                ? 'A box of letters draws a young translator back to the coastal town she once left behind. As she pieces together the lives of the people who wrote them, the familiar streets become a map of unexpected friendships.'
                : domain === 'game'
                  ? 'Restore an abandoned lighthouse and explore a changing coastal town. Each evening brings a new visitor, a small mystery and a choice about what to keep shining.'
                  : 'At the edge of a quiet city, an apprentice astronomer keeps watch over an observatory due to close. A series of unexpected visitors turns her final season into a journey through the lives of her neighbours.',
          },
  });
  publicRead.summary = null;
  for (const statements of Object.values(publicRead.subject.statements))
    for (const value of statements) value.rezics.release = digest;
  if (domain !== 'game') {
    publicRead.subject.statements =
      state === 'sparse'
        ? {}
        : {
            'schema:inLanguage': [statement(8001, 'schema:inLanguage', { type: 'value', content: 'en' })],
            'schema:datePublished': [
              statement(8002, 'schema:datePublished', {
                type: 'value',
                content: {
                  time: '+2024-05-16T00:00:00Z',
                  precision: 11,
                  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
                },
              }),
            ],
            ...(domain === 'book'
              ? {
                  'schema:author': [statement(8003, 'schema:author', { type: 'value', content: id(8101) })],
                }
              : {
                  'schema:numberOfEpisodes': [
                    statement(8005, 'schema:numberOfEpisodes', {
                      type: 'value',
                      content: { amount: '+12', unit: '1' },
                    }),
                  ],
                  'schema:director': [statement(8006, 'schema:director', { type: 'value', content: id(8102) })],
                }),
          };
    publicRead.related = {
      [id(8101)]: { type: 'schema:Person', labels: { en: 'Mira Chen' } },
      [id(8102)]: { type: 'schema:Person', labels: { ja: '山田 葵' } },
    };
  }
  // A long description exercises the same native synopsis disclosure used by every complete page.
  if (state !== 'sparse') {
    publicRead.subject.descriptions.en +=
      '\n\n' +
      [
        'The harbour changes with the weather. Familiar paths become meeting places, and each return reveals another side of the town.',
        'Across a year of departures and reunions, the story follows the everyday choices that connect neighbours. Its attention stays with the people, the places they share and the things they leave unsaid.',
        'By the final evening, even the smallest encounters have become part of a larger story about belonging.',
      ].join('\n\n');
  }
  const page = structuredClone(pageRecording) as unknown as SubjectPageData;
  page.subject = identity.id;
  page.context = { id: context, population: { kind: 'global' } };
  page.catalogue = { state: 'released', type: identity.type, digest, definitions: release };
  page.views = ['overview', 'contents', 'editions', 'relations', 'reviews', 'discussion', 'details'];
  page.community = reviews(identity.id, identity.title, state);
  // This is the real default composition; only its fixture-supplied facts and read results change.
  const plan = planReads(platformRegistry, page.document as CompositionDocument, {
    subject: identity.id,
    account: null,
    context: page.context,
  });
  page.reads = Object.fromEntries(
    Object.entries(plan.reads).map(([key, read]) => [
      key,
      read.kind === 'subject'
        ? { status: 200, body: publicRead }
        : read.kind === 'subjectThreads'
          ? { status: 200, body: { threads: [], next: null } }
          : {
              status: 200,
              body: {
                links: [],
                relations: [],
                subjects: [],
                collections: [],
                next: null,
                count: { value: 0, exact: true },
                freshness: { caught_up: true },
              },
            },
    ]),
  );
  const membership = statement(8201, domain === 'anime' ? 'schema:isPartOf' : 'schema:exampleOfWork', {
    type: 'value',
    content: identity.id,
  });
  const memberType = domain === 'anime' ? 'schema:TVSeason' : domain === 'game' ? 'wd:Q20631656' : 'bf:Instance';
  const memberTitle =
    domain === 'anime'
      ? 'Season One'
      : domain === 'game'
        ? 'Harbour Lights · Windows release'
        : 'Letters from the Harbour · paperback';
  const links = {
    links:
      state === 'sparse'
        ? []
        : [
            {
              subject: id(8202),
              property: membership.property.id,
              statement: membership.id,
              assertion: membership,
              type: memberType,
              label: memberTitle,
              summary: {
                creativeWork: true,
                id: id(8202),
                type: memberType,
                types: [memberType],
                label: { value: memberTitle, language: 'en' },
                cover: null,
              },
              related: {},
            },
          ],
    next: null,
    freshness: { consistency: 'eventual', target_seconds: 10, caught_up: true },
  };
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'links' && read.property === membership.property.id)
      page.reads[key] = { status: 200, body: links };
  }
  return { domain, state, identity, release, publicRead, page, links };
}

export type ReadingOverviewExample = ReturnType<typeof readingOverviewExample>;
let selected: ReadingOverviewExample | undefined;
/** Scoped to the active dedicated story; cleanup restores the ordinary provider fixtures. */
export function selectReadingOverviewExample(example?: ReadingOverviewExample) {
  selected = example;
}
const recording = (value: object, status = 200) => ({ ...value, status }) as KernelRecording;

export const routes: FakeRoute[] = [
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ match }) =>
      selected && match?.[1] === selected.identity.id ? recording(selected.publicRead) : undefined,
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/links$/,
    story: ({ match }) =>
      selected && match?.[1] === selected.identity.id
        ? selected.state === 'section-failure'
          ? recording({}, 503)
          : recording(selected.links)
        : undefined,
  },
  {
    method: 'GET',
    path: '/v1/definitions/active',
    story: () => (selected ? recording({ digest }) : undefined),
  },
  {
    method: 'GET',
    path: /^\/v1\/definitions\/releases\/([^/]+)$/,
    story: ({ match }) =>
      selected && decodeURIComponent(match?.[1] ?? '') === digest
        ? recording({ digest, release: selected.release })
        : undefined,
  },
];

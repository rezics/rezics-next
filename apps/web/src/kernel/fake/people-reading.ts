import type { SubjectRead } from '@rezics/client';
import {
  definedViews,
  PAGE_GLOBAL_CONTEXT,
  pickText,
  planReads,
  platformRegistry,
  profileDigest,
  resolveView,
  type PageContinuation,
  type PresentationProfile,
  type View,
} from '@rezics/composition';
import profileJson from '@rezics/composition/profiles/platform.json';
import type { Release } from '@rezics/definitions';
import { fromPlainText, type DocumentProfile } from '@rezics/document';
import type { SubjectPageData } from '../../features/pages/subject';
import type { FakeRoute } from '../fake-modules';
import definitions from '../recorded/definitions-release.json';
import { communityAuthor, communityBoard, communityThread, communityThreadPage } from './subject-community';
import { authoredReadingPage } from './thread-reading-page';

/** Invented public profiles, served through the real application routes and installed read plan. */
export type PeopleReadingFamily = 'character' | 'person' | 'organization';
export type PeopleReadingState = 'complete' | 'sparse' | 'relation-failure';
export const peopleReadingId = (n: number) => `0193e000-0000-7000-8000-${String(n).padStart(12, '0')}`;
export const peopleReadingIds = {
  character: peopleReadingId(1),
  person: peopleReadingId(2),
  organization: peopleReadingId(3),
};
const profile = profileJson as PresentationProfile;
const release = definitions.release as Release;
const freshness = { consistency: 'eventual', target_seconds: 10, caught_up: true };
const digest = 'c'.repeat(64);
const origin = 'https://people-reading.example/catalogue';
let state: PeopleReadingState = 'complete';

export function selectPeopleReading(next: PeopleReadingState = 'complete') {
  state = next;
}

type Statement = SubjectRead['subject']['statements'][string][number];
type Snak = Statement['qualifiers'][number];
type Summary = NonNullable<SubjectRead['summary']>;
const snak = (property: string, content: unknown): Snak => ({
  property: { id: property, data_type: release.properties[property]!.datatype },
  value: { type: 'value', content },
});
function assertion(n: number, property: string, content: unknown, qualifiers: Snak[] = []): Statement {
  return {
    id: peopleReadingId(n),
    rank: 'normal',
    ...snak(property, content),
    qualifiers,
    references: [{ hash: 'profile-citation', parts: [snak('schema:url', origin)] }],
    rezics: { release: definitions.digest, revision: 1 },
  };
}
const date = (year: number) => ({
  time: `+${year}-00-00T00:00:00Z`,
  precision: 9,
  calendarmodel: 'http://www.wikidata.org/entity/Q1985727',
});
function subject(id: string, type: string, labels: Record<string, string>, description: string): SubjectRead {
  return {
    subject: {
      id,
      type,
      labels,
      descriptions: description ? { en: description } : {},
      aliases: {},
      statements: {},
      revision: 1,
      release: definitions.digest,
      context: PAGE_GLOBAL_CONTEXT,
      resolution: {},
      relationCounts: {},
      sourceRecords: [],
    },
    account: null,
    summary: null,
    related: {},
  };
}
export const peopleReadingPortraitIds: Record<PeopleReadingFamily, string> = {
  character: '0193d000-0000-7000-8000-000000000070',
  person: '0193d000-0000-7000-8000-000000000071',
  organization: '0193d000-0000-7000-8000-000000000072',
};
function portrait(family: PeopleReadingFamily): NonNullable<Summary['cover']> {
  return {
    media: peopleReadingPortraitIds[family],
    width: 480,
    height: 600,
    placeholder: { thumbhash: '', color: family === 'person' ? '#764d44' : '#244d54' },
    variants: [
      { format: 'webp', width: 160 },
      { format: 'webp', width: 320 },
    ],
    focalPoint: null,
    credit: {
      rightsHolder: 'REZICS synthetic profile illustrations',
      license: 'CC0-1.0',
      obligations: [],
      via: { name: 'Illustrative profile artwork', url: origin },
    },
  };
}

/** Exact readbacks of one supplied document retain its paragraph identities as well as its content. */
function peopleDocument(n: number, text: string, profile: DocumentProfile = 'text') {
  const snapshot = fromPlainText(text, profile);
  return {
    ...snapshot,
    doc: {
      ...snapshot.doc,
      content: snapshot.doc.content!.map((paragraph, index) => ({
        ...paragraph,
        attrs: { ...paragraph.attrs, id: peopleReadingId(1000000 + n * 100 + index) },
      })),
    },
  };
}

export function peopleReadingFixture(scenario: PeopleReadingState = state) {
  const character = subject(
    peopleReadingIds.character,
    'wd:Q95074',
    {
      en: 'Sora, the tide cartographer',
      ja: '潮の地図師ソラ',
      'zh-Hant': '潮汐製圖師空',
      'zh-Hans': '潮汐制图师空',
      ko: '조수 지도 제작자 소라',
      de: 'Sora, die Gezeitenkartografin',
      fr: 'Sora, cartographe des marées',
      es: 'Sora, cartógrafa de las mareas',
    },
    'A travelling cartographer in the Tide Archive stories.',
  );
  const person = subject(
    peopleReadingIds.person,
    'schema:Person',
    {
      en: 'Mira Sato',
      ja: '佐藤ミラ',
      'zh-Hant': '佐藤美拉',
      'zh-Hans': '佐藤美拉',
      ko: '사토 미라',
      de: 'Mira Sato',
      fr: 'Mira Sato',
      es: 'Mira Sato',
    },
    'An independent animation director and storyboard artist.',
  );
  const organization = subject(
    peopleReadingIds.organization,
    'schema:Organization',
    {
      en: 'Paper Lantern Studio',
      ja: '灯籠スタジオ',
      'zh-Hant': '紙燈籠工作室',
      'zh-Hans': '纸灯笼工作室',
      ko: '종이등 스튜디오',
      de: 'Papierlaternen-Studio',
      fr: 'Studio Lanterne de papier',
      es: 'Estudio Farol de Papel',
    },
    'An independent animation workshop producing the Tide Archive films.',
  );
  const subjects = new Map<string, SubjectRead>(
    [character, person, organization].map((read) => [read.subject.id, read]),
  );
  const documents: NonNullable<SubjectRead['documents']> = {};
  const profiles = { character, person, organization };
  const biographies: Record<PeopleReadingFamily, string> = {
    character:
      'Sora makes maps of a harbour whose streets change with the tide. In The Harbour Letters, a commission to chart the old ferry route brings her to the Tide Archive. She returns to the harbour in later Tide Archive short films.',
    person:
      'Mira Sato directs independent animated films and develops storyboards with Paper Lantern Studio. Her work follows everyday journeys through changing coastal towns. She also performs voices in the Tide Archive short films under the credited name M. Sato.',
    organization:
      'Paper Lantern Studio is an independent animation workshop. Its film projects bring together directors, illustrators and background artists around stories of coastal life. The archive names Lantern Workshop as its predecessor from 1999. The workshop continues to produce short films alongside its longer projects.',
  };
  for (const [family, read] of Object.entries(profiles) as [PeopleReadingFamily, SubjectRead][]) {
    const index = Object.keys(profiles).indexOf(family);
    read.summary = {
      id: read.subject.id,
      type: read.subject.type,
      types: [read.subject.type, ...release.types[read.subject.type]!.bases],
      label: { value: read.subject.labels.en!, language: 'en' },
      creativeWork: false,
      cover: scenario === 'sparse' ? null : portrait(family),
    };
    read.subject.aliases =
      family === 'person' ? { ja: ['ミラ'] } : family === 'character' ? { en: ['The cartographer'] } : {};
    if (scenario === 'sparse') continue;
    read.subject.sourceRecords = [{ name: 'Tide Archive public catalogue', url: origin, licence: { id: 'CC0-1.0' } }];
    const document = peopleReadingId(80 + index);
    const bio = assertion(90 + index, 'schema:abstract', { document, digest, language: 'en' });
    read.subject.statements['schema:abstract'] = [bio];
    read.subject.statements['schema:url'] = [assertion(95 + index, 'schema:url', `${origin}/${family}`)];
    const biographyDocument: NonNullable<SubjectRead['documents']>[string] = {
      id: document,
      subjectId: read.subject.id,
      candidateId: bio.id,
      revision: 1,
      digest,
      language: 'en',
      source: {
        source: 'people-reading',
        external_id: family,
        record_revision: '1',
        digest,
        converter_revision: '1',
        field_group: 'summary',
        references: [],
      },
      rights: { license: 'CC0-1.0', obligations: [], attribution: 'Tide Archive synthetic profile' },
      availability: 'available',
      body: peopleDocument(80 + index, biographies[family]),
    };
    documents[bio.id] = biographyDocument;
    read.documents = { [bio.id]: biographyDocument };
  }
  const concept = (n: number, en: string, ja: string) => {
    const value = subject(peopleReadingId(n), 'skos:Concept', { en, ja }, '');
    subjects.set(value.subject.id, value);
    return value.subject.id;
  };
  const director = concept(40, 'Animation director', 'アニメーション監督');
  const japanese = concept(41, 'Japanese', '日本語');
  const role = concept(42, 'Voice performance', '声の出演');
  const predecessor = subject(
    peopleReadingId(4),
    'schema:Organization',
    { en: 'Lantern Workshop', ja: '灯籠工房' },
    'An earlier animation workshop.',
  );
  const sibling = subject(
    peopleReadingId(5),
    'wd:Q95074',
    { en: 'Neri, the ferry keeper', ja: '渡し守ネリ' },
    'A ferry keeper in the Tide Archive stories.',
  );
  subjects.set(predecessor.subject.id, predecessor);
  subjects.set(sibling.subject.id, sibling);
  if (scenario !== 'sparse') {
    person.subject.statements['wdt:P106'] = [
      assertion(110, 'wdt:P106', director, [snak('schema:startDate', date(2020))]),
    ];
    person.subject.statements['schema:knowsLanguage'] = [assertion(111, 'schema:knowsLanguage', japanese)];
    person.subject.statements['schema:birthDate'] = [assertion(112, 'schema:birthDate', date(1988))];
    character.subject.statements['schema:height'] = [
      assertion(113, 'schema:height', { amount: '+170', unit: 'http://www.wikidata.org/entity/Q174728' }),
    ];
    character.subject.statements['wdt:P3373'] = [assertion(114, 'wdt:P3373', sibling.subject.id)];
    organization.subject.statements['wdt:P1365'] = [
      assertion(115, 'wdt:P1365', predecessor.subject.id, [snak('schema:startDate', date(1999))]),
    ];
    // A supplied but undisclosed parent must never acquire an invented label or link.
    organization.subject.statements['wdt:P749'] = [assertion(116, 'wdt:P749', peopleReadingId(999))];
  }
  const workTitles = ['The Harbour Letters', 'At the Last Ferry', 'An Atlas for Tomorrow', 'The Quiet Quay'];
  for (let i = 0; i < (scenario === 'sparse' ? 1 : 23); i++) {
    const title = i < workTitles.length ? workTitles[i]! : `Tide Archive short film ${i + 1}`;
    const work = subject(
      peopleReadingId(200 + i),
      'schema:Movie',
      { en: title },
      'An animated story from the Tide Archive.',
    );
    const rows = [
      assertion(1000 + i * 4, 'schema:character', character.subject.id, [snak('wdt:P1932', 'Sora')]),
      assertion(1001 + i * 4, 'schema:director', person.subject.id, [snak('wdt:P1932', 'M. Sato')]),
      assertion(1002 + i * 4, 'schema:productionCompany', organization.subject.id),
      assertion(1003 + i * 4, 'wdt:P725', person.subject.id, [
        snak('wdt:P453', character.subject.id),
        snak('wdt:P3831', role),
      ]),
    ];
    work.subject.statements = Object.fromEntries(rows.map((row) => [row.property.id, [row]]));
    work.summary = {
      id: work.subject.id,
      type: work.subject.type,
      types: [work.subject.type, ...release.types[work.subject.type]!.bases],
      label: { value: title, language: 'en' },
      creativeWork: true,
      cover: null,
    };
    subjects.set(work.subject.id, work);
  }
  for (const read of subjects.values()) {
    const targets = Object.values(read.subject.statements)
      .flat()
      .flatMap((row) => [row, ...row.qualifiers]);
    for (const part of targets) {
      if (
        part.property.data_type !== 'wikibase-item' ||
        part.value.type !== 'value' ||
        typeof part.value.content !== 'string'
      )
        continue;
      const target = subjects.get(part.value.content);
      if (target) read.related[target.subject.id] = { type: target.subject.type, labels: target.subject.labels };
    }
    for (const property of Object.keys(release.properties)) {
      if (!release.properties[property]?.relation) continue;
      const outgoing = read.subject.statements[property]?.length ?? 0;
      const incoming = [...subjects.values()].reduce(
        (count, owner) =>
          count +
          (owner.subject.statements[property] ?? []).filter(
            (row) => row.value.type === 'value' && row.value.content === read.subject.id,
          ).length,
        0,
      );
      if (outgoing || incoming) read.subject.relationCounts[property] = outgoing + incoming;
    }
  }
  return { profiles, subjects, documents, release };
}

function failedRelation(id: string) {
  if (id === peopleReadingIds.character) return 'schema:character';
  if (id === peopleReadingIds.person) return 'schema:director';
  return 'schema:productionCompany';
}

function summary(read: SubjectRead, locale: string): Summary {
  if (read.summary)
    return {
      ...read.summary,
      label: {
        value: pickText(read.subject.labels, locale).text,
        language: pickText(read.subject.labels, locale).lang ?? 'en',
      },
    };
  const label = pickText(read.subject.labels, locale);
  return {
    id: read.subject.id,
    type: read.subject.type,
    types: [read.subject.type],
    label: { value: label.text, language: label.lang ?? 'en' },
    creativeWork: false,
    cover: null,
  };
}

function relationWindow(
  fixture: ReturnType<typeof peopleReadingFixture>,
  id: string,
  property: string,
  inverse: boolean,
  locale: string,
  limit: number,
  cursor?: string,
  qualifier?: string,
) {
  const owners = inverse ? [...fixture.subjects.values()] : [fixture.subjects.get(id)!];
  const rows = owners.flatMap((owner) => {
    const matches = Object.values(owner.subject.statements)
      .flat()
      .filter((row) =>
        qualifier
          ? row.property.id === property &&
            row.qualifiers.some(
              (part) => part.property.id === qualifier && part.value.type === 'value' && part.value.content === id,
            )
          : row.property.id === property && (!inverse || (row.value.type === 'value' && row.value.content === id)),
      );
    return matches.flatMap((row) => {
      const target = inverse
        ? owner.subject.id
        : row.value.type === 'value' && typeof row.value.content === 'string'
          ? row.value.content
          : undefined;
      const current = target ? fixture.subjects.get(target) : undefined;
      return [
        {
          subject: current?.subject.id ?? null,
          target: current?.subject.id ?? null,
          external: null,
          property,
          label: current ? pickText(current.subject.labels, locale).text : null,
          type: current?.subject.type ?? null,
          summary: current ? summary(current, locale) : null,
          statement: inverse ? row.id : row,
          assertion: row,
          related: owner.related,
        },
      ];
    });
  });
  const offset = cursor ? Number(cursor.split(':').at(-1)) : 0;
  return {
    rows: rows.slice(offset, offset + limit),
    count: { value: rows.length, exact: true },
    next: offset + limit < rows.length ? `people:${property}:${offset + limit}` : null,
    freshness,
  };
}

const threadKinds = ['review', 'discussion'] as const;
type ThreadKind = (typeof threadKinds)[number];

function peopleBoard(kind: ThreadKind) {
  return {
    ...communityBoard(kind),
    id: peopleReadingId(kind === 'review' ? 8000 : 8001),
    title: kind === 'review' ? 'Public Tide Archive reviews' : 'Public Tide Archive discussions',
  };
}

/** The subject's fixed suffix keeps its thread stable across sparse/complete fixture populations. */
function peopleThread(kind: ThreadKind, current: SubjectRead) {
  const thread = communityThread(kind, false, { id: current.subject.id, label: current.subject.labels.en! });
  const offset = Number(current.subject.id.slice(-12)) * 2 + (kind === 'review' ? 0 : 1);
  const threadId = peopleReadingId(20000 + offset);
  const boardId = peopleBoard(kind).id;
  return {
    ...thread,
    id: threadId,
    boardId,
    title: 'How do the harbour stories connect?',
    firstPost: {
      ...thread.firstPost,
      id: peopleReadingId(30000 + offset),
      threadId,
      boardId,
      revisionId: peopleReadingId(40000 + offset),
      body: peopleDocument(
        20000 + offset,
        'I am following the supplied work credits while reading the harbour stories.',
        'blocks',
      ),
    },
  };
}

function peopleThreadPage(kind: ThreadKind, current: SubjectRead, scenario: PeopleReadingState, place?: string) {
  return communityThreadPage(
    kind,
    { id: current.subject.id, label: current.subject.labels.en! },
    scenario === 'sparse' ? [] : [peopleThread(kind, current)],
    null,
    place,
  );
}

export function peopleReadingPage(
  id: string,
  locale = 'en',
  view: View = 'overview',
  scenario: PeopleReadingState = state,
  continuation?: PageContinuation,
): SubjectPageData {
  const fixture = peopleReadingFixture(scenario);
  const current = fixture.subjects.get(id)!;
  const target = { type: current.subject.type, bases: release.types[current.subject.type]!.bases };
  const resolved = resolveView(profile, target, view)!;
  const context = { id: PAGE_GLOBAL_CONTEXT, population: { kind: 'global' as const } };
  const plan = planReads(platformRegistry, resolved.document, {
    subject: id,
    context,
    ...(continuation ? { continuation } : {}),
  });
  const reads: SubjectPageData['reads'] = {};
  for (const [key, read] of Object.entries(plan.reads)) {
    if (read.kind === 'subject') {
      reads[key] = { status: 200, body: { ...current, summary: summary(current, locale) } };
    } else if (read.kind === 'relations' || read.kind === 'links') {
      if (scenario === 'relation-failure' && read.property === failedRelation(id)) {
        reads[key] = { status: 503, body: { code: 'dependency_unavailable' } };
        continue;
      }
      const page = relationWindow(fixture, id, read.property, read.kind === 'links', locale, read.limit, read.cursor);
      reads[key] = {
        status: 200,
        body: {
          [read.kind === 'links' ? 'links' : 'relations']: page.rows,
          count: page.count,
          next: page.next,
          freshness,
        },
      };
    } else if (read.kind === 'subjectThreads') {
      reads[key] = {
        status: 200,
        body: peopleThreadPage(read.threadKind, current, scenario, read.place),
      };
    } else if (read.kind === 'collections') {
      reads[key] = { status: 200, body: { collections: [], count: { value: 0, exact: true }, next: null } };
    } else {
      reads[key] = { status: 200, body: { accounts: [], next: null } };
    }
  }
  return {
    subject: id,
    context,
    profile: profileDigest(profile),
    template: { scope: resolved.scope, key: resolved.key },
    document: resolved.document,
    views: definedViews(profile, target),
    reads,
    catalogue: { state: 'released', type: current.subject.type, digest: definitions.digest, definitions: release },
    ...(continuation ? { continuation } : {}),
  };
}

const localeOf = (request: Request) => request.headers.get('accept-language')?.split(',')[0]?.trim() ?? 'en';
export const routes: FakeRoute[] = [
  {
    method: 'POST',
    path: '/v1/pages:read',
    story: async ({ request }) => {
      const input = (await request.json()) as {
        target: { subject?: string; view?: View };
        languages?: string[];
        continuation?: PageContinuation;
      };
      if (!input.target.subject || !peopleReadingFixture().subjects.has(input.target.subject)) return;
      return {
        status: 200,
        ...peopleReadingPage(
          input.target.subject,
          input.languages?.[0] ?? 'en',
          input.target.view,
          state,
          input.continuation,
        ),
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)$/,
    story: ({ request, match }) => {
      const current = peopleReadingFixture().subjects.get(match![1]!);
      if (!current) return;
      return { status: 200, ...current, summary: summary(current, localeOf(request)) };
    },
  },
  ...(['links', 'relations'] as const).map((kind): FakeRoute => ({
    method: 'GET',
    path: new RegExp(`^/v1/subjects/([^/]+)/${kind}$`),
    story: ({ request, match }) => {
      const id = match![1]!;
      const fixture = peopleReadingFixture();
      if (!fixture.subjects.has(id)) return;
      const query = new URL(request.url).searchParams;
      const property = query.get('property')!;
      if (state === 'relation-failure' && property === failedRelation(id))
        return { status: 503, code: 'dependency_unavailable' };
      const page = relationWindow(
        fixture,
        id,
        property,
        kind === 'links',
        localeOf(request),
        Number(query.get('limit') ?? 12),
        query.get('cursor') ?? undefined,
        query.get('qualifier') ?? undefined,
      );
      return { status: 200, [kind]: page.rows, count: page.count, next: page.next, freshness };
    },
  })),
  {
    method: 'GET',
    path: /^\/v1\/documents\/([^/]+)$/,
    story: ({ match }) => {
      const document = Object.values(peopleReadingFixture().documents).find((value) => value.id === match![1]);
      if (document) return { status: 200, document };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/subjects\/([^/]+)\/threads$/,
    story: ({ request, match }) => {
      const current = peopleReadingFixture().subjects.get(match![1]!);
      if (!current) return;
      const query = new URL(request.url).searchParams;
      const kind = query.get('kind');
      if (kind !== 'review' && kind !== 'discussion') return;
      return { status: 200, ...peopleThreadPage(kind, current, state, query.get('place') ?? undefined) };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/boards\/([^/]+)(\/page|\/threads)?$/,
    story: ({ request, match }) => {
      const board = threadKinds.map(peopleBoard).find((row) => row.id === match![1]);
      if (!board) return;
      if (!match![2]) return { status: 200, board };
      const kind = board.purpose === 'reviews' ? 'review' : 'discussion';
      const threads =
        state === 'sparse'
          ? []
          : [...peopleReadingFixture().subjects.values()].map((current) => peopleThread(kind, current));
      const cursor = new URL(request.url).searchParams.get('cursor');
      const offset = cursor ? Number(cursor.split(':').at(-1)) : 0;
      const page = threads.slice(offset, offset + 20);
      const next = offset + 20 < threads.length ? `people-board:${kind}:${offset + 20}` : null;
      if (match![2] === '/threads') return { status: 200, threads: page, next, rankRefreshedAt: null };
      const author = {
        ...communityAuthor,
        state: 'available',
      };
      return {
        status: 200,
        board,
        pinRevision: '0',
        pinnedThreads: [],
        threads: page.map((thread) => ({
          thread,
          target: { kind: 'thread', id: thread.id, boardId: board.id },
          authors: { thread: author, openingPost: author },
          media: { state: 'none', images: [] },
          interaction: {
            target: { kind: 'thread', id: thread.id },
            counts: { state: 'unavailable' },
            viewer: { state: 'not-applicable' },
          },
          comments: { state: 'unavailable' },
          actions: { reply: 'sign-in', react: 'sign-in', share: 'available' },
        })),
        next,
        rankRefreshedAt: null,
        reactionsAsOf: null,
        viewer: { participation: 'sign-in' },
        actions: { createThread: 'sign-in' },
      };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/threads\/([^/]+)(\/reading-page|\/posts)?$/,
    story: ({ match }) => {
      if (state === 'sparse') return;
      const thread = [...peopleReadingFixture().subjects.values()]
        .flatMap((current) => threadKinds.map((kind) => peopleThread(kind, current)))
        .find((row) => row.id === match![1]);
      if (!thread) return;
      if (match![2] === '/posts') return { status: 200, posts: [thread.firstPost], next: null };
      if (!match![2]) return { status: 200, thread };
      return {
        status: 200,
        ...authoredReadingPage(
          thread,
          [],
          [
            {
              id: communityAuthor.id,
              displayName: communityAuthor.displayName,
              handle: communityAuthor.handle,
              avatar: null,
            },
          ],
        ),
      };
    },
  },
  {
    method: 'GET',
    path: '/v1/accounts',
    story: ({ request }) => {
      const agent = new URL(request.url).searchParams.get('agent');
      if (agent && peopleReadingFixture().subjects.has(agent)) return { status: 200, accounts: [], next: null };
    },
  },
  {
    method: 'GET',
    path: '/v1/progressSessions',
    story: ({ request }) => {
      const id = new URL(request.url).searchParams.get('subjectId');
      if (!id || !peopleReadingFixture().subjects.has(id)) return;
      return request.headers.has('authorization')
        ? { status: 200, progressSessions: [], next: null }
        : { status: 401, code: 'unauthorized' };
    },
  },
  {
    method: 'GET',
    path: /^\/v1\/(?:libraryEntries\/([^/]+)|subjects\/([^/]+)\/ratings\/[^/]+\/vote)$/,
    story: ({ request, match }) => {
      const id = (match![1] ?? match![2])!;
      if (!peopleReadingFixture().subjects.has(id)) return;
      return request.headers.has('authorization')
        ? { status: 404, code: 'not_found' }
        : { status: 401, code: 'unauthorized' };
    },
  },
];

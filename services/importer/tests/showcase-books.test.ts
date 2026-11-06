import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchStatement, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { convertBangumi, converter_revision } from '@rezics/conversion/bangumi';
import { bangumiRecordUrl } from '@rezics/conversion/cross-media-entities';
import type { ReviewedSubjectRead } from '../src/import-client.ts';
import type { CrossMediaPort, CrossMediaTables } from '../src/cross-media-seed.ts';
import { crossMediaAliases } from '../src/cross-media-seed.ts';
import { createPublicBulkClient } from '../src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
  type ShowcaseReviewPort,
} from '../src/showcase-publication.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import {
  importShowcaseBooks,
  planShowcaseBooks,
  showcaseBookFamily,
  showcaseBooksToCrossMediaPlan,
} from '../src/showcase-books.ts';
import pinned from '../../kernel/test/imports/showcase-books-source.json';

const globalContext = '00000000-0000-8000-8000-000000000000';
const series = {
  id: 499,
  type: 1,
  name: '文学少女',
  name_cn: '文学少女',
  platform: 1002,
  series: true,
  date: '2006-04-28',
  infobox: '{{Infobox animanga/Novel\r\n|中文名= 文学少女\r\n|作者= 野村美月\r\n|册数= 8+8(番外)\r\n}}',
};
const volume = {
  id: 26,
  type: 1,
  name: '“文学少女”と死にたがりの道化',
  name_cn: '“文学少女”与渴望死亡的小丑',
  platform: 1002,
  series: false,
  date: '2006-04-28',
  infobox:
    '{{Infobox animanga/Novel\r\n|中文名= “文学少女”与渴望死亡的小丑\r\n|出版社= エンターブレイン\r\n|页数= 254\r\n|ISBN= 9784757728066\r\n|作者= 野村美月\r\n}}',
};
const second = {
  id: 27,
  type: 1,
  name: '“文学少女”と飢え渇く幽霊',
  name_cn: '“文学少女”与渴求真爱的幽灵',
  platform: 1002,
  series: false,
  date: '2006-08-30',
  infobox: '{{Infobox animanga/Novel\r\n|ISBN= 9784757729155\r\n|作者= 野村美月\r\n}}',
};
const unrelated = {
  id: 9001,
  type: 1,
  name: '文学少女',
  name_cn: '文学少女',
  platform: 1002,
  series: false,
  date: '2001-01-01',
  infobox: '{{Infobox animanga/Novel\r\n|作者= 他人\r\n}}',
};
const manga = {
  id: 9003,
  type: 1,
  name: '文学少女',
  platform: 1001,
  series: true,
  infobox: '{{Infobox animanga/Manga}}',
};
const author = { id: 6023, name: '野村美月', name_cn: '野村美月', type: 1, career: ['writer'] };
const illustrator = { id: 7001, name: '竹岡美穗', type: 1, career: ['artist'] };
const translator = { id: 7002, name: '他人译', type: 1, career: ['translator'] };
const company = { id: 8001, name: 'エンターブレイン', type: 2 };

function tables(
  extra: {
    relations?: Record<string, unknown>[];
    credits?: Record<string, unknown>[];
    people?: Record<string, unknown>[];
    complete?: boolean;
    secondFamily?: boolean;
  } = {},
): CrossMediaTables {
  const karaSeries = {
    id: 2815,
    type: 1,
    name: '空の境界',
    name_cn: '空之境界',
    platform: 1002,
    series: true,
    infobox:
      '{{Infobox animanga/Novel\r\n|中文名= 空之境界\r\n|作者= 奈須きのこ\r\n|插图= 武内崇\r\n|出版社= 講談社\r\n}}',
  };
  const karaVolumes = [
    {
      id: 5329,
      type: 1,
      name: '空の境界 (上)',
      name_cn: '空之境界 (上)',
      platform: 1002,
      series: false,
      infobox: '{{Infobox animanga/Novel\r\n|中文名= 空之境界 (上)\r\n|页数= 448\r\n|ISBN= 9784061823617\r\n}}',
    },
    {
      id: 10862,
      type: 1,
      name: '空の境界 (下)',
      name_cn: '空之境界 (下)',
      platform: 1002,
      series: false,
      infobox: '{{Infobox animanga/Novel\r\n|中文名= 空之境界 (下)\r\n|页数= 538\r\n|ISBN= 9784061823624\r\n}}',
    },
  ];
  const karaAnime = {
    id: 233,
    type: 2,
    name: '劇場版 空の境界 第一章 俯瞰風景',
    name_cn: '剧场版 空之境界 第一章 俯瞰风景',
    platform: 3,
    series: false,
    infobox: '{{Infobox animanga/Movie}}',
  };
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [
      series,
      volume,
      second,
      unrelated,
      manga,
      ...(extra.secondFamily ? [karaSeries, ...karaVolumes, karaAnime] : []),
    ],
    'bangumi/subject-relations': [
      { subject_id: 26, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 26, relation_type: 1003, order: 0 },
      { subject_id: 27, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 27, relation_type: 1003, order: 2 },
      ...(extra.complete ? [] : [{ subject_id: 499, related_subject_id: 9002, relation_type: 1003, order: 9 }]),
      { subject_id: 26, related_subject_id: 3183, relation_type: 1, order: 0 },
      ...(extra.secondFamily
        ? [
            { subject_id: 5329, related_subject_id: 2815, relation_type: 1002, order: 0 },
            { subject_id: 10862, related_subject_id: 2815, relation_type: 1002, order: 0 },
            { subject_id: 2815, related_subject_id: 5329, relation_type: 1003, order: 1 },
            { subject_id: 2815, related_subject_id: 10862, relation_type: 1003, order: 2 },
            { subject_id: 2815, related_subject_id: 233, relation_type: 1, order: 1 },
            { subject_id: 233, related_subject_id: 2815, relation_type: 1, order: 0 },
          ]
        : []),
      ...(extra.relations ?? []),
    ],
    'bangumi/subject-persons': extra.credits ?? [
      { person_id: 6023, subject_id: 499, position: 2001, appear_eps: '' },
      { person_id: 6023, subject_id: 26, position: 2001, appear_eps: '' },
    ],
    'bangumi/person': extra.people ?? [author],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}

function valueContent(statement: { value: BatchStatement['value'] } | undefined): unknown {
  return statement?.value.type === 'value' ? statement.value.content : undefined;
}

function reviewWorld(journal: ShowcaseJournal) {
  const subjects = new Map<
    string,
    {
      id: string;
      type: string;
      sourceExternalId: string;
      labels: Record<string, string>;
      statements: Record<string, unknown[]>;
    }
  >();
  const sources = new Map<string, string>();
  const receipts = new Map<string, { body: string; result: BatchWriteResult['results'][number] }>();
  const candidates = new Map<
    string,
    { id: string; source: BatchCommand['source']; statement: BatchStatement; head: number | null }
  >();
  const adopted = new Map<string, { head: number; selection: { candidate: string; rank: 'normal' | 'preferred' }[] }>();
  const metadata = sourceRecordMetadataFixture();
  const read = (id: string): ReviewedSubjectRead => {
    const subject = subjects.get(id);
    if (!subject) throw new Error('Missing fixture subject');
    const identity = /^(?:(person|character):)?([0-9]+)$/u.exec(subject.sourceExternalId);
    const property =
      identity?.[1] === 'person' && subject.type === 'schema:Person'
        ? 'wdt:P6298'
        : identity?.[1] === 'character'
          ? 'wdt:P6296'
          : identity
            ? 'wdt:P5732'
            : undefined;
    const statements = property
      ? {
          ...subject.statements,
          [property]: [
            {
              property: { id: property },
              value: { type: 'value', content: identity![2] },
              references: [
                {
                  parts: [
                    {
                      property: { id: 'schema:url' },
                      value: { type: 'value', content: bangumiRecordUrl(subject.sourceExternalId) },
                    },
                  ],
                },
              ],
            },
          ],
        }
      : subject.statements;
    return { subject: { ...subject, statements } } as unknown as ReviewedSubjectRead;
  };
  const basePort = {
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id: string) {
      return read(id);
    },
    async batch(request: BatchWriteRequest): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) => {
          const body = JSON.stringify(command);
          const old = receipts.get(command.key);
          if (old) {
            expect(body).toBe(old.body);
            return structuredClone(old.result);
          }
          let result: BatchWriteResult['results'][number];
          if (command.op === 'create') {
            const sourceKey = `${command.source.source}\0${command.source.external_id}`;
            const id = sources.get(sourceKey) ?? randomUUID();
            sources.set(sourceKey, id);
            subjects.set(id, {
              id,
              type: command.subject.type,
              sourceExternalId: command.source.external_id,
              labels: command.subject.labels,
              statements: {},
            });
            result = { key: command.key, status: 201, value: { id, revision: 1 } };
          } else if (command.op === 'propose') {
            const id = randomUUID();
            candidates.set(id, { id, source: command.source, statement: command.statement, head: null });
            result = { key: command.key, status: 201, value: { candidate: id, revision: 1 } };
          } else result = { key: command.key, status: 200, value: { revision: 1 } };
          receipts.set(command.key, { body, result });
          return structuredClone(result);
        }),
      };
    },
  } as unknown as CrossMediaPort;
  const port = captureShowcaseCommands(basePort, journal);
  const review: ShowcaseReviewPort = {
    readReviewedSubject: async (id) => read(id),
    async reviewedCandidates(id, query) {
      expect(query.context).toBe(globalContext);
      return {
        candidates: [...candidates.values()].filter(
          (candidate) =>
            candidate.source.external_id === subjects.get(id)?.sourceExternalId &&
            candidate.statement.property.id === query.property,
        ),
        next: null,
        adoption: adopted.get(`${id}\0${query.property}`) ?? null,
      } as never;
    },
    async acceptReviewedCandidate(_id, candidateId) {
      return {
        acceptance: { context: globalContext, candidate: candidateId, decision: 'accept', head: 1 },
        revision: 1,
      } as never;
    },
    async adoptReviewedCandidates(id, body) {
      const action = body as {
        property: string;
        selection: { candidate: string; rank: 'normal' | 'preferred' }[];
      };
      const key = `${id}\0${action.property}`;
      const next = { head: (adopted.get(key)?.head ?? 0) + 1, selection: action.selection };
      adopted.set(key, next);
      subjects.get(id)!.statements[action.property] = action.selection.map(
        ({ candidate }) => candidates.get(candidate)!.statement,
      );
      return {
        adoption: { context: globalContext, property: action.property, mode: 'replace', ...next },
        revision: 1,
      } as never;
    },
  };
  const publicClient = createPublicBulkClient({
    origin: 'https://fixture.test',
    fetch: (async (input) => {
      const id = new URL(String(input)).pathname.split('/').at(-1)!;
      return Response.json(read(id));
    }) as typeof fetch,
  });
  return { port, rawPort: basePort, review, publicClient, subjects, receipts };
}

test('fresh book seed publishes current authors and keeps grain, membership and source names', async () => {
  const plan = await planShowcaseBooks({ tables: tables() });
  expect(plan.family).toEqual(showcaseBookFamily);
  expect(plan.selected).toEqual({
    series: ['499'],
    volumes: ['26', '27'],
    editions: [],
    authors: ['person:6023'],
    illustrators: [],
    publishers: [],
    anime: [],
  });
  expect(plan.conversions.map((row) => [row.key, row.grain, row.converterRevision])).toEqual([
    ['499', 'schema:BookSeries', converter_revision],
    ['26', 'schema:Book', converter_revision],
    ['27', 'schema:Book', converter_revision],
  ]);
  expect(
    plan.edges.map((edge) => [edge.holder, edge.property, edge.target, edge.relation?.code, edge.relation?.order]),
  ).toEqual([
    ['26', 'wdt:P179', '499', 1002, 0],
    ['27', 'wdt:P179', '499', 1002, 2],
  ]);
  expect(plan.members.some((row) => row.role === 'missing' && row.key === '9002')).toBe(true);
  expect(JSON.stringify(plan.selected)).not.toContain('9001');
  expect(JSON.stringify(plan.selected)).not.toContain('9003');
  expect(JSON.stringify(plan.selected)).not.toContain('3183');
  const seriesConversion = convertBangumi(
    { external_id: '499', record_revision: null, record: series },
    { source: 'bangumi' },
  );
  const volumeConversion = convertBangumi(
    { external_id: '26', record_revision: null, record: volume },
    { subjectId: '00000000-0000-4000-8000-000000000026', source: 'bangumi' },
  );
  expect(seriesConversion.proposals[0]).toMatchObject({ subject: { type: 'schema:BookSeries' } });
  expect(
    volumeConversion.proposals.some(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:isbn',
    ),
  ).toBe(false);
  expect(volumeConversion.diagnostics).toContainEqual({
    pointer: '/infobox/ISBN',
    code: 'edition_assertion_withheld_on_work',
  });
  expect(seriesConversion.diagnostics).toContainEqual({
    pointer: '/infobox/册数',
    code: 'count_does_not_create_volumes',
  });

  const directory = await mkdtemp(join(tmpdir(), 'showcase-books-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const world = reviewWorld(journal);
    const first = await importShowcaseBooks({
      tables: tables({
        complete: true,
        credits: [{ person_id: 6023, subject_id: 26, position: 2001, appear_eps: '' }],
      }),
      path: join(directory, 'state.sqlite'),
      port: world.port,
      journal,
      review: world.review,
      publicClient: world.publicClient,
    });
    expect(first.identities['499']?.type).toBe('schema:BookSeries');
    expect(first.identities['26']?.type).toBe('schema:Book');
    expect(first.identities['person:6023']?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(first.creditRoles).toEqual([expect.objectContaining({ code: '2001', property: 'schema:author' })]);
    expect(first.creditGaps.some((item) => 'path' in item && item.path === '/subject-persons/26/6023/position')).toBe(
      false,
    );
    const published = await publishShowcase({
      plan: showcaseBooksToCrossMediaPlan(first.planned),
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: world.review,
      publicClient: world.publicClient,
      ...(first.creditVocabularyRequirements ? { vocabularyRequirements: first.creditVocabularyRequirements } : {}),
    });
    const seriesRead = (await world.publicClient.readSubject(first.identities['499']!.id)).subject as {
      type: string;
      labels: Record<string, string>;
    };
    const volumeRead = (await world.publicClient.readSubject(first.identities['26']!.id)).subject as {
      type: string;
      labels: Record<string, string>;
    };
    const personRead = (await world.publicClient.readSubject(first.identities['person:6023']!.id)).subject as {
      type: string;
      labels: Record<string, string>;
    };
    expect(seriesRead.type).toBe('schema:BookSeries');
    expect(volumeRead.type).toBe('schema:Book');
    expect(personRead.type).toBe('schema:Person');
    expect(seriesRead.labels.und).toBe('文学少女');
    expect(seriesRead.labels.zh).toBe('文学少女');
    expect(volumeRead.labels.und).toBe('“文学少女”と死にたがりの道化');
    expect(volumeRead.labels.zh).toBe('“文学少女”与渴望死亡的小丑');
    expect(personRead.labels.und).toBe('野村美月');
    expect(personRead.labels.zh).toBe('野村美月');
    expect(JSON.stringify(volumeRead)).not.toContain('9784757728066');
    const membership = [...world.receipts.values()].filter((row) => {
      const command = JSON.parse(row.body) as BatchCommand;
      return command.op === 'propose' && command.statement.property.id === 'wdt:P179';
    });
    expect(membership).toHaveLength(2);
    expect(
      membership.every((row) => {
        const command = JSON.parse(row.body) as Extract<BatchCommand, { op: 'propose' }>;
        return command.subject === first.identities['26']?.id || command.subject === first.identities['27']?.id;
      }),
    ).toBe(true);
    const authors = [...world.receipts.values()]
      .map((row) => JSON.parse(row.body) as BatchCommand)
      .filter(
        (command): command is Extract<BatchCommand, { op: 'propose' }> =>
          command.op === 'propose' && command.statement.property.id === 'schema:author',
      );
    expect(authors.some((command) => command.subject === first.identities['26']?.id)).toBe(true);
    expect(authors.some((command) => command.subject === first.identities['499']?.id)).toBe(false);
    expect(
      authors.some(
        (command) =>
          valueContent(command.statement) === first.identities['person:6023']?.id &&
          command.statement.qualifiers?.some(
            (qualifier) =>
              qualifier.property.id === 'wdt:P3831' && valueContent(qualifier) === first.creditRoles![0]!.conceptId,
          ),
      ),
    ).toBe(true);
    const again = await importShowcaseBooks({
      tables: tables({
        complete: true,
        credits: [{ person_id: 6023, subject_id: 26, position: 2001, appear_eps: '' }],
      }),
      path: join(directory, 'state.sqlite'),
      port: world.port,
      journal,
      review: world.review,
      publicClient: world.publicClient,
      prior: published,
    });
    expect(again.identities['499']?.id).toBe(first.identities['499']?.id);
    expect(again.identities['26']?.id).toBe(first.identities['26']?.id);
    expect(again.identities['person:6023']?.id).toBe(first.identities['person:6023']?.id);
    expect(again.selected).toEqual(first.selected);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('Kara no Kyoukai creator, publisher and anime identities survive exact journal reopen', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-book-series-'));
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const sourceTables = () =>
    tables({
      complete: true,
      secondFamily: true,
      credits: [
        { person_id: 6023, subject_id: 499, position: 2001, appear_eps: '' },
        { person_id: 6023, subject_id: 26, position: 2001, appear_eps: '' },
        { person_id: 1466, subject_id: 2815, position: 2001, appear_eps: '' },
        { person_id: 1467, subject_id: 2815, position: 2003, appear_eps: '' },
        { person_id: 128, subject_id: 2815, position: 2004, appear_eps: '' },
      ],
      people: [
        author,
        { id: 1466, name: '奈須きのこ', name_cn: null, type: 1, career: [] },
        { id: 1467, name: '武内崇', name_cn: null, type: 1, career: [] },
        { id: 128, name: '講談社', name_cn: null, type: 2 },
      ],
    });
  try {
    const world = reviewWorld(journal);
    const input = {
      tables: sourceTables(),
      path: join(directory, 'state.sqlite'),
      port: world.port,
      journal,
      review: world.review,
      publicClient: world.publicClient,
    };
    const first = await importShowcaseBooks(input);
    expect(first.selected).toMatchObject({
      series: ['499', '2815'],
      anime: ['233'],
      authors: ['person:6023', 'person:1466'],
      illustrators: ['person:1467'],
      publishers: ['person:128'],
    });
    for (const [key, type] of [
      ['2815', 'schema:BookSeries'],
      ['5329', 'schema:Book'],
      ['10862', 'schema:Book'],
      ['person:1466', 'schema:Person'],
      ['person:1467', 'schema:Person'],
      ['person:128', 'schema:Organization'],
    ] as const)
      expect(first.identities[key]?.type).toBe(type);
    expect(first.identities['233']?.id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u);
    const publisherId = first.identities['person:128']!.id;
    const publication = await publishShowcase({
      plan: showcaseBooksToCrossMediaPlan(first.planned),
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: world.review,
      publicClient: world.publicClient,
      ...(first.creditVocabularyRequirements ? { vocabularyRequirements: first.creditVocabularyRequirements } : {}),
    });
    const publisherManifest = publication.manifest.records.find((record) => record.sourceKey === 'person:128');
    expect(publisherManifest?.nativeType).toBe('schema:Organization');
    expect(publisherManifest?.assertions.map((assertion) => assertion.property)).toContain('schema:name');
    expect(
      publication.published
        .find((record) => record.sourceKey === 'person:128')
        ?.assertions.map((assertion) => assertion.property),
    ).toContain('schema:name');
    const publisherRead = (await world.publicClient.readSubject(publisherId)).subject as {
      type: string;
      statements: Record<string, { value?: { content?: unknown } }[]>;
    };
    expect(publisherRead.type).toBe('schema:Organization');
    expect(
      publisherRead.statements['schema:name']?.some(
        (row) => JSON.stringify(row.value?.content) === JSON.stringify({ language: 'und', text: '講談社' }),
      ),
    ).toBe(true);
    const publisherRole = first.creditRoles!.find((role) => role.code === '2004')!;
    expect(publisherRole.property).toBe('schema:publisher');
    const publisherClaims = [...world.receipts.values()]
      .map((row) => JSON.parse(row.body) as BatchCommand)
      .filter(
        (command): command is Extract<BatchCommand, { op: 'propose' }> =>
          command.op === 'propose' && command.statement.property.id === 'schema:publisher',
      );
    expect(
      publisherClaims.some(
        (command) =>
          command.subject === first.identities['2815']?.id &&
          valueContent(command.statement) === first.identities['person:128']?.id &&
          command.statement.qualifiers?.some(
            (qualifier) => qualifier.property.id === 'wdt:P3831' && valueContent(qualifier) === publisherRole.conceptId,
          ),
      ),
    ).toBe(true);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const reopened = await importShowcaseBooks({
      ...input,
      port: captureShowcaseCommands(world.rawPort, journal),
      journal,
      prior: publication,
    });
    expect(reopened.selected).toEqual(first.selected);
    for (const key of [
      '499',
      '26',
      '2815',
      '5329',
      '10862',
      '233',
      'person:6023',
      'person:1466',
      'person:1467',
      'person:128',
    ])
      expect(reopened.identities[key]?.id).toBe(first.identities[key]?.id);
    expect(
      reopened.planned.edges.find((edge) => edge.property === 'rezics:crossMediaCounterpart')?.relation,
    ).toMatchObject({
      sourceSubject: '2815',
      sourceEndpoint: '233',
      code: 1,
    });
    // Only the lower volume row changes; the upper volume must also lose its now-ambiguous position.
    const changed = await importShowcaseBooks({
      ...input,
      port: captureShowcaseCommands(world.rawPort, journal),
      journal,
      prior: publication,
      tables: {
        async *rows(provider, table, limits) {
          for await (const row of sourceTables().rows(provider, table, limits))
            yield table === 'subject-relations' && row.subject_id === 2815 && row.related_subject_id === 10862
              ? { ...row, order: 1 }
              : row;
        },
      },
    });
    for (const key of ['5329', '10862']) {
      expect(changed.identities[key]?.id).toBe(first.identities[key]?.id);
      const original = first.workRelations?.find((edge) => edge.draft.holder === key);
      const refreshed = changed.workRelations?.find((edge) => edge.draft.holder === key);
      expect(refreshed?.status).toBe('proposed');
      expect(refreshed?.command?.key).not.toBe(original?.command?.key);
      const command = refreshed?.command;
      expect(command?.op).toBe('propose');
      if (command?.op === 'propose')
        expect(command.statement.qualifiers?.some((part) => part.property.id === 'schema:position') ?? false).toBe(
          false,
        );
    }
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 120_000);

test('wrong, missing or retracted author evidence withholds only that claim and exact journal replay keeps identities', async () => {
  const planned = await planShowcaseBooks({
    tables: tables({
      credits: [
        { person_id: 6023, subject_id: 499, position: 2001, appear_eps: '' },
        { person_id: 7001, subject_id: 26, position: 2002, appear_eps: '' },
        { person_id: 7002, subject_id: 26, position: 2006, appear_eps: '' },
        { person_id: 8001, subject_id: 27, position: 2001, appear_eps: '' },
        { person_id: 9009, subject_id: 499, position: 2001, appear_eps: '' },
      ],
      people: [author, illustrator, translator, company],
    }),
  });
  expect(planned.selected.authors).toEqual(['person:6023']);
  expect(planned.selected.illustrators).toEqual(['person:7001']);
  expect(planned.selected.publishers).toEqual([]);
  expect(planned.selected.editions).toEqual([]);
  expect(planned.credits.map((draft) => [draft.work, draft.person, draft.roleCode])).toEqual([
    ['499', 'person:6023', 2001],
    ['26', 'person:7001', 2002],
  ]);
  expect(planned.gaps).toContainEqual(
    expect.objectContaining({ reason: 'author identity is not an individual person', property: 'schema:author' }),
  );
  expect(planned.gaps).toContainEqual(
    expect.objectContaining({ reason: 'author identity is missing from the dump', property: 'schema:author' }),
  );

  const directory = await mkdtemp(join(tmpdir(), 'showcase-books-gaps-'));
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const world = reviewWorld(journal);
    const first = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'state.sqlite'),
      port: world.port,
      journal,
      review: world.review,
      publicClient: world.publicClient,
    });
    const published = await publishShowcase({
      plan: showcaseBooksToCrossMediaPlan(first.planned),
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: world.review,
      publicClient: world.publicClient,
      ...(first.creditVocabularyRequirements ? { vocabularyRequirements: first.creditVocabularyRequirements } : {}),
    });
    const role = first.creditRoles![0]!;
    const concept = world.subjects.get(role.conceptId)!;
    concept.statements['schema:sameAs'] = [
      {
        property: { id: 'schema:sameAs' },
        value: { type: 'value', content: 'https://example.test/retracted-author' },
      },
    ];
    const retracted = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'state.sqlite'),
      port: world.port,
      journal,
      review: world.review,
      publicClient: world.publicClient,
      prior: published,
    });
    expect(retracted.identities['499']?.id).toBe(first.identities['499']?.id);
    expect(retracted.identities['26']?.id).toBe(first.identities['26']?.id);
    expect(retracted.identities['person:6023']?.id).toBe(first.identities['person:6023']?.id);
    expect(retracted.creditRoles ?? []).toEqual([]);
    expect(retracted.creditGaps).toContainEqual(expect.objectContaining({ reason: 'missing_concept', code: '2001' }));
    expect(retracted.status).toBe('imported-with-gaps');
    const volumeRead = (await world.publicClient.readSubject(retracted.identities['26']!.id)).subject as {
      type: string;
      labels: Record<string, string>;
      statements: Record<string, readonly BatchStatement[]>;
    };
    expect(volumeRead.type).toBe('schema:Book');
    expect(volumeRead.labels.und).toBe('“文学少女”と死にたがりの道化');
    expect(
      [...world.receipts.values()].some((row) => {
        const command = JSON.parse(row.body) as BatchCommand;
        return (
          command.op === 'propose' &&
          command.statement.property.id === 'wdt:P179' &&
          command.subject === retracted.identities['26']?.id
        );
      }),
    ).toBe(true);
    expect(JSON.stringify(volumeRead)).not.toContain('9784757728066');
    expect(retracted.selected.editions).toEqual([]);
    expect(retracted.planned.members.some((row) => row.role === 'volume' && row.key === '9001')).toBe(false);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

test('pinned real light-novel families publish through the reviewed world and reopen with exact identities', async () => {
  const rows = pinned.rows as Record<string, Record<string, unknown>[]>;
  const directory = await mkdtemp(join(tmpdir(), 'showcase-pinned-books-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const world = reviewWorld(journal);
    const input = {
      tables: {
        async *rows(provider: 'bangumi' | 'vndb', table: string) {
          if (provider === 'bangumi') yield* rows[table] ?? [];
        },
      },
      path: join(directory, 'state.sqlite'),
      port: world.port,
      journal,
      review: world.review,
      publicClient: world.publicClient,
    };
    const first = await importShowcaseBooks(input);
    expect(first.selected).toMatchObject({
      series: ['499', '2815'],
      volumes: expect.arrayContaining(['26', '5329', '10862']),
      authors: ['person:6023', 'person:1466'],
      illustrators: expect.arrayContaining(['person:1467']),
      publishers: expect.arrayContaining(['person:128', 'person:1581']),
      anime: ['233'],
    });
    const publication = await publishShowcase({
      plan: showcaseBooksToCrossMediaPlan(first.planned),
      result: first,
      aliases: crossMediaAliases,
      journal,
      review: world.review,
      publicClient: world.publicClient,
      ...(first.creditVocabularyRequirements ? { vocabularyRequirements: first.creditVocabularyRequirements } : {}),
    });
    const seriesId = first.identities['2815']!.id;
    const animeId = first.identities['233']!.id;
    const read = async (id: string) =>
      (await world.publicClient.readSubject(id)).subject as {
        type: string;
        statements: Record<string, { value?: { content?: unknown } }[]>;
      };
    const contents = (subject: { statements: Record<string, { value?: { content?: unknown } }[]> }, property: string) =>
      (subject.statements[property] ?? []).map((row) => row.value?.content);
    const series2815 = await read(seriesId);
    expect(series2815.type).toBe('schema:BookSeries');
    // A BookSeries admits publisher but not author or illustrator, and the pinned source has no volume credit rows.
    expect(first.creditGaps).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          path: '/subject-persons/499/6023/position',
          reason: 'property_not_admitted',
          property: 'schema:author',
        }),
        expect.objectContaining({
          path: '/subject-persons/499/5839/position',
          reason: 'property_not_admitted',
          property: 'schema:illustrator',
        }),
        expect.objectContaining({
          path: '/subject-persons/2815/1466/position',
          reason: 'property_not_admitted',
          property: 'schema:author',
        }),
        expect.objectContaining({
          path: '/subject-persons/2815/1467/position',
          reason: 'property_not_admitted',
          property: 'schema:illustrator',
        }),
      ]),
    );
    expect(new Set(first.planned.credits.map((draft) => draft.work))).toEqual(new Set(['499', '2815']));
    expect(contents(series2815, 'schema:publisher')).toContain(first.identities['person:128']!.id);
    expect(contents(series2815, 'schema:name')).toContainEqual({ language: 'und', text: 'THE GARDEN OF SINNERS' });
    // The fake world adopts no relation statements, so volume membership is checked as its exact proposals.
    const membership = [...world.receipts.values()]
      .map((row) => JSON.parse(row.body) as BatchCommand)
      .filter(
        (command): command is Extract<BatchCommand, { op: 'propose' }> =>
          command.op === 'propose' && command.statement.property.id === 'wdt:P179',
      );
    for (const key of ['5329', '10862'])
      expect(
        membership.some(
          (command) => command.subject === first.identities[key]!.id && valueContent(command.statement) === seriesId,
        ),
      ).toBe(true);
    const anime = await read(animeId);
    expect(anime.type).toBe('schema:TVSeries');
    expect(contents(anime, 'schema:name')).toContainEqual({ language: 'und', text: '劇場版 空の境界 第一章 俯瞰風景' });
    const counterpart = [...world.receipts.values()]
      .map((row) => JSON.parse(row.body) as BatchCommand)
      .some(
        (command) =>
          command.op === 'propose' &&
          command.statement.property.id === 'rezics:crossMediaCounterpart' &&
          ((command.subject === animeId && valueContent(command.statement) === seriesId) ||
            (command.subject === seriesId && valueContent(command.statement) === animeId)),
      );
    expect(counterpart).toBe(true);

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const reopened = await importShowcaseBooks({
      ...input,
      port: captureShowcaseCommands(world.rawPort, journal),
      journal,
      prior: publication,
    });
    expect(reopened.selected).toEqual(first.selected);
    for (const key of ['499', '2815', '26', '5329', '10862', '233', 'person:1466', 'person:1467', 'person:128'])
      expect(reopened.identities[key]?.id).toBe(first.identities[key]?.id);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 180_000);

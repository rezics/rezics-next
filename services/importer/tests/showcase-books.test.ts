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
  } = {},
): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    'bangumi/subject': [series, volume, second, unrelated, manga],
    'bangumi/subject-relations': [
      { subject_id: 26, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 26, relation_type: 1003, order: 0 },
      { subject_id: 27, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 27, relation_type: 1003, order: 2 },
      ...(extra.complete ? [] : [{ subject_id: 499, related_subject_id: 9002, relation_type: 1003, order: 9 }]),
      { subject_id: 26, related_subject_id: 3183, relation_type: 1, order: 0 },
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
      identity?.[1] === 'person'
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
  return { port, review, publicClient, subjects, receipts };
}

test('fresh Book Girl seed publishes current authors and keeps grain, membership and source names', async () => {
  const plan = await planShowcaseBooks({ tables: tables() });
  expect(plan.family).toEqual(showcaseBookFamily);
  expect(plan.selected).toEqual({
    series: ['499'],
    volumes: ['26', '27'],
    editions: [],
    authors: ['person:6023'],
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
    ['27', 'wdt:P179', '499', 1002, 0],
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
  expect(planned.selected.editions).toEqual([]);
  expect(
    planned.credits.every(
      (draft) => draft.roleCode === 2001 && (draft.person === 'person:6023' || draft.person === 'person:9009'),
    ),
  ).toBe(true);
  expect(planned.gaps).toContainEqual(
    expect.objectContaining({ reason: 'Author identity is not an individual person', property: 'schema:author' }),
  );
  expect(planned.gaps).toContainEqual(
    expect.objectContaining({ reason: 'Author identity is missing from the dump', property: 'schema:author' }),
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

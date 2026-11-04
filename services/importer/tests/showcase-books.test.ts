import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { convertBangumi, converter_revision } from '@rezics/conversion/bangumi';
import type { CrossMediaPort } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import { importShowcaseBooks, planShowcaseBooks, showcaseBookFamily } from '../src/showcase-books.ts';

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
const author = { id: 6023, name: '野村美月', type: 1, career: ['writer'] };

function tables(extraRelations: Record<string, unknown>[] = []) {
  const rows: Record<string, Row[]> = {
    'bangumi/subject': [series, volume, second, unrelated, manga],
    'bangumi/subject-relations': [
      { subject_id: 26, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 26, relation_type: 1003, order: 0 },
      { subject_id: 27, related_subject_id: 499, relation_type: 1002, order: 0 },
      { subject_id: 499, related_subject_id: 27, relation_type: 1003, order: 2 },
      { subject_id: 499, related_subject_id: 9002, relation_type: 1003, order: 9 },
      { subject_id: 26, related_subject_id: 3183, relation_type: 1, order: 0 },
      ...extraRelations,
    ],
    'bangumi/subject-persons': [{ person_id: 6023, subject_id: 499, position: 2001, appear_eps: '' }],
    'bangumi/person': [author],
  };
  return {
    async *rows(provider: 'bangumi' | 'vndb', table: string) {
      yield* rows[`${provider}/${table}`] ?? [];
    },
  };
}
type Row = Record<string, unknown>;

function identityOf(externalId: string) {
  if (externalId.startsWith('person:')) return { property: 'wdt:P6298', value: externalId.slice('person:'.length) };
  if (/^[1-9][0-9]*$/u.test(externalId)) return { property: 'wdt:P5732', value: externalId };
}
function port(commands: BatchCommand[]): CrossMediaPort {
  const subjects = new Map<string, { id: string; type: string; externalId: string }>();
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      commands.push(...request.commands);
      return {
        results: request.commands.map((command) => {
          if (command.op === 'create') {
            const sourceKey = `${command.source.source}\0${command.source.external_id}`;
            const existing = [...subjects.values()].find(
              (row) => `${command.source.source}\0${row.externalId}` === sourceKey,
            );
            const id = existing?.id ?? randomUUID();
            subjects.set(id, { id, type: command.subject.type, externalId: command.source.external_id });
            return { key: command.key, status: 201 as const, value: { id, revision: 1 } };
          }
          return {
            key: command.key,
            status: 201 as const,
            value: command.op === 'propose' ? { candidate: randomUUID(), revision: 1 } : { revision: 1 },
          };
        }),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {
      throw new Error('No statistic in this authored fixture');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      const known = subjects.get(id);
      const identity = known ? identityOf(known.externalId) : undefined;
      return {
        subject: {
          id,
          type: known?.type ?? 'schema:Person',
          statements: identity ? { [identity.property]: [{ value: { type: 'value', content: identity.value } }] } : {},
        },
      } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

test('default planning converts the documented Book Girl family and keeps unrelated or missing volumes out', async () => {
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
  expect(
    volumeConversion.proposals.some(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:datePublished',
    ),
  ).toBe(true);

  const commands: BatchCommand[] = [];
  const shared = port(commands);
  const directory = await mkdtemp(join(tmpdir(), 'showcase-books-'));
  try {
    const recorded: { series: string[]; volumes: string[] }[] = [];
    const first = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'state.sqlite'),
      port: shared,
      manifest: {
        recordBooks(input) {
          recorded.push({ series: [...input.selected.series], volumes: [...input.selected.volumes] });
        },
      },
    });
    expect(first.status).toBe('imported-with-gaps');
    expect(recorded).toEqual([{ series: ['499'], volumes: ['26', '27'] }]);
    expect(first.identities['499']?.type).toBe('schema:BookSeries');
    expect(first.identities['26']?.type).toBe('schema:Book');
    expect(first.identities['27']?.type).toBe('schema:Book');
    expect(first.identities['person:6023']?.id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/u,
    );
    expect(first.creditGaps.some((item) => 'reason' in item && item.reason !== undefined)).toBe(true);
    expect(JSON.stringify(first.selected)).not.toContain('9001');
    const membership = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && command.statement.property.id === 'wdt:P179',
    );
    expect(membership).toHaveLength(2);
    expect(
      membership.every(
        (command) => command.subject === first.identities['26']?.id || command.subject === first.identities['27']?.id,
      ),
    ).toBe(true);
    expect(
      membership.every(
        (command) =>
          command.statement.value.type === 'value' && command.statement.value.content === first.identities['499']?.id,
      ),
    ).toBe(true);
    expect(
      JSON.stringify(
        commands.filter((command) => command.op === 'propose' && command.statement.property.id === 'wdt:P179'),
      ),
    ).not.toContain(first.identities['26'] && `"${first.identities['499']?.id}"` && 'hasPart');
    const again = await importShowcaseBooks({
      tables: tables(),
      path: join(directory, 'state.sqlite'),
      port: shared,
    });
    expect(again.identities['499']?.id).toBe(first.identities['499']?.id);
    expect(again.identities['26']?.id).toBe(first.identities['26']?.id);
    expect(again.identities['person:6023']?.id).toBe(first.identities['person:6023']?.id);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

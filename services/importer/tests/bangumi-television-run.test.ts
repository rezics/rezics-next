import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/bangumi';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import type { SourceRegistration } from '../src/import-contract.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
const completeInfobox = (total: string) =>
  `{{Infobox animanga/TVAnime\n|中文名=发条天文台\n|话数=${total}\n|放送开始=2024年4月7日\n|播放结束=2024年6月23日\n}}`;
const unknownInfobox =
  '{{Infobox animanga/TVAnime\n|话数=*\n|放送开始=2024年4月\n|放送星期=星期五\n|自制字段=weekly slot\n}}';

function record(id: number, infobox: string, date: string) {
  return { id, type: 2, name: `Television ${id}`, name_cn: `动画 ${id}`, infobox, date };
}

function dump(total = '12') {
  return `${JSON.stringify(record(91001, completeInfobox(total), '2024-04-07'))}\n${JSON.stringify(record(91002, unknownInfobox, '2024-04'))}\n`;
}

async function* bytes(text: string) {
  yield new TextEncoder().encode(text);
}

function transport(commands: BatchCommand[]) {
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  const subjects = new Map<string, string>();
  return {
    subjects,
    commands,
    setSourceRecordMetadata: sourceRecordMetadataFixture().setSourceRecordMetadata,
    async readFence() {
      return { fenced: false, securityRevision: null };
    },
    async batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult> {
      return {
        results: request.commands.map((command) => {
          commands.push(structuredClone(command));
          const prior = receipts.get(command.key);
          if (prior) {
            expect(JSON.stringify(command)).toBe(prior.bytes);
            return structuredClone(prior.result);
          }
          if (command.op === 'create') subjects.set(command.source.external_id, randomUUID());
          const result = {
            key: command.key,
            status: 201 as const,
            value:
              command.op === 'create'
                ? { id: subjects.get(command.source.external_id)!, revision: 1 }
                : command.op === 'propose'
                  ? { candidate: randomUUID(), revision: 1 }
                  : { revision: 1 },
          };
          receipts.set(command.key, { bytes: JSON.stringify(command), result });
          return result;
        }),
      };
    },
  };
}

const runProperties = new Set(['schema:datePublished', 'schema:endDate', 'schema:numberOfEpisodes']);

function withoutRunFacts(registration: SourceRegistration): SourceRegistration {
  return {
    ...registration,
    convert(input, context) {
      const result = registration.convert(input, context);
      return {
        ...result,
        proposals: result.proposals.filter(
          (command) => command.op !== 'propose' || !runProperties.has(command.statement.property.id),
        ),
      };
    },
  };
}

function content(command: BatchCommand) {
  return command.op === 'propose' && command.statement.value.type === 'value'
    ? command.statement.value.content
    : undefined;
}

test('operator imports TVAnime original-run fields, keeps unknown totals and schedule text as omissions, and refreshes without changing work identity', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-television-run-'));
  const path = join(directory, 'state.sqlite');
  const commands: BatchCommand[] = [];
  const api = transport(commands);
  const current = createSourceRegistration('bangumi');
  const previous = withoutRunFacts(createSourceRegistration('bangumi', { converterRevision: 'bangumi@7' }));
  expect(converter_revision).toBe('bangumi@15');
  let importer = new Importer({ path, transport: api });
  try {
    expect((await importer.runDump(previous, bytes(dump()))).status).toBe('committed');
    const firstId = api.subjects.get('91001');
    const firstCount = commands.length;
    expect(
      commands.some((command) => command.op === 'propose' && runProperties.has(command.statement.property.id)),
    ).toBe(false);

    await importer.close();
    importer = new Importer({ path, transport: api });
    expect((await importer.runDump(current, bytes(dump()))).status).toBe('committed');
    expect(api.subjects.get('91001')).toBe(firstId);
    expect(api.subjects.get('91002')).toBeDefined();
    expect(JSON.stringify(commands.slice(0, firstCount)).includes('"op":"create"')).toBe(true);
    const run = commands.filter(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' && runProperties.has(command.statement.property.id),
    );
    expect(run.map((command) => [command.source.external_id, command.statement.property.id, content(command)])).toEqual(
      [
        ['91001', 'schema:datePublished', { time: '+2024-04-07T00:00:00Z', precision: 11, calendarmodel: gregorian }],
        ['91001', 'schema:endDate', { time: '+2024-06-23T00:00:00Z', precision: 11, calendarmodel: gregorian }],
        ['91001', 'schema:numberOfEpisodes', { amount: '+12', unit: '1' }],
        ['91002', 'schema:datePublished', { time: '+2024-04-00T00:00:00Z', precision: 10, calendarmodel: gregorian }],
      ],
    );
    expect(run.every((command) => command.source.converter_revision === 'bangumi@15')).toBe(true);
    expect(run.every((command) => command.source.record_revision === 'unversioned')).toBe(true);
    expect(run.every((command) => command.subject === api.subjects.get(command.source.external_id))).toBe(true);

    const unknownId = api.subjects.get('91002');
    expect(unknownId).toBeDefined();
    const bound = current.convert(
      { external_id: '91002', record_revision: null, record: record(91002, unknownInfobox, '2024-04') },
      { source: 'bangumi', subjectId: unknownId! },
    );
    expect(bound.diagnostics).toEqual(
      expect.arrayContaining([
        { pointer: '/date', code: 'unsupported_date_mapping' },
        { pointer: '/infobox/话数', code: 'unknown_episode_total' },
        { pointer: '/infobox/放送星期', code: 'unsupported_schedule_text' },
        { pointer: '/infobox/自制字段', code: 'unsupported_infobox_mapping' },
      ]),
    );
    expect(
      bound.diagnostics.some((item) => item.pointer === '/infobox' && item.code === 'unsupported_infobox_mapping'),
    ).toBe(false);

    const afterUpgrade = commands.length;
    expect((await importer.runDump(current, bytes(dump()))).status).toBe('committed');
    expect(commands).toHaveLength(afterUpgrade);
    expect(api.subjects.get('91001')).toBe(firstId);

    expect((await importer.runDump(current, bytes(dump('13')))).status).toBe('committed');
    expect(api.subjects.get('91001')).toBe(firstId);
    expect(
      commands.some(
        (command) =>
          command.op === 'propose' &&
          command.source.external_id === '91001' &&
          command.statement.property.id === 'schema:numberOfEpisodes' &&
          JSON.stringify(content(command)) === JSON.stringify({ amount: '+13', unit: '1' }),
      ),
    ).toBe(true);
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

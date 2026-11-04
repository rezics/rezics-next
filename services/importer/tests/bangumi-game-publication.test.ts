import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/bangumi';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { Importer } from '../src/importer.ts';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaPort,
} from '../src/cross-media-seed.ts';
import { createSourceRegistration, crossMediaBangumiRevision } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const gregorian = 'http://www.wikidata.org/entity/Q1985727';
const dateProperty = 'schema:datePublished';
const game = (releaseDate: string) => ({
  id: 94001,
  type: 4,
  name: 'Clockwork Orchard',
  date: '1999-12-31',
  infobox: `{{Infobox Game\n|发行日期=${releaseDate}\n|游玩人数=1-3\n}}`,
});

function selectedPlan(record: ReturnType<typeof game>) {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({ source: 'bangumi', key: String(record.id), revision: null, payload: record });
  plan.members.push({
    source: 'bangumi',
    key: String(record.id),
    kind: 'work',
    membership: 'family',
    franchise: 'steins-gate',
  });
  return plan;
}

async function* bytes(record: ReturnType<typeof game>) {
  yield new TextEncoder().encode(`${JSON.stringify(record)}\n`);
}

function port(commands: BatchCommand[]) {
  const metadata = sourceRecordMetadataFixture();
  const ids = new Map<string, string>();
  const types = new Map<string, string>();
  const externalIds = new Map<string, string>();
  const receipts = new Map<string, { bytes: string; result: BatchWriteResult['results'][number] }>();
  async function send(request: BatchWriteRequest): Promise<BatchWriteResult> {
    return {
      results: request.commands.map((command) => {
        commands.push(structuredClone(command));
        const prior = receipts.get(command.key);
        if (prior) {
          expect(JSON.stringify(command)).toBe(prior.bytes);
          return structuredClone(prior.result);
        }
        const owner = `${command.source.source}\0${command.source.external_id}`;
        let result: BatchWriteResult['results'][number];
        if (command.op === 'create') {
          const id = ids.get(owner) ?? randomUUID();
          ids.set(owner, id);
          types.set(id, command.subject.type);
          externalIds.set(id, command.source.external_id);
          result = { key: command.key, status: 201, value: { id, revision: 1 } };
        } else if (command.op === 'propose') {
          result = { key: command.key, status: 201, value: { candidate: randomUUID(), revision: 1 } };
        } else result = { key: command.key, status: 200, value: { revision: 1 } };
        receipts.set(command.key, { bytes: JSON.stringify(command), result });
        return structuredClone(result);
      }),
    };
  }
  const noFence = async () => ({ fenced: false as const, securityRevision: null });
  const fixture = {
    ids,
    batch: send,
    batchWrite: send,
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    readFence: noFence,
    fence: noFence,
    async writeSourceStatistic() {
      throw new Error('Game fixture has no source statistic');
    },
    async clearSourceStatistic() {},
    async readReviewedSubject(id: string) {
      const externalId = externalIds.get(id);
      return {
        subject: {
          id,
          type: types.get(id) ?? 'schema:Thing',
          statements: externalId ? { 'wdt:P5732': [{ value: { type: 'value', content: externalId } }] } : {},
        },
      } as unknown as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
  return fixture satisfies CrossMediaPort & {
    ids: Map<string, string>;
    batchWrite(request: BatchWriteRequest): Promise<BatchWriteResult>;
    readFence(): Promise<{ fenced: false; securityRevision: null }>;
  };
}

test('Bangumi Game publication keeps only the admitted infobox date through ordinary and selected-family registrations', async () => {
  expect(converter_revision).toBe('bangumi@14');
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-publication-'));
  const path = join(directory, 'state.sqlite');
  const commands: BatchCommand[] = [];
  const api = port(commands);
  const alias = crossMediaAliases.bangumi;
  const ordinary = createSourceRegistration('bangumi', { source: alias });
  const qualified = game('Japanese edition 2006-04-15');
  const sourceInput = { external_id: String(qualified.id), record_revision: null, record: qualified };
  const diagnostic = ordinary.convert(sourceInput, { source: alias, subjectId: randomUUID() });
  expect(
    diagnostic.proposals.some((command) => command.op === 'propose' && command.statement.property.id === dateProperty),
  ).toBe(false);
  expect(diagnostic.diagnostics).toContainEqual({
    pointer: '/infobox/发行日期',
    code: 'unsupported_publication_date',
  });
  expect(JSON.stringify(diagnostic.diagnostics)).not.toContain('Japanese edition');

  let importer = new Importer({ path, transport: api });
  try {
    expect((await importer.runDump(ordinary, bytes(qualified))).status).toBe('committed');
    expect(
      commands.some(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:numberOfPlayers',
      ),
    ).toBe(true);
    const subjectId = api.ids.get(`${alias}\0${qualified.id}`);
    expect(subjectId).toBeDefined();
    const oldCommands = commands.map((command) => JSON.stringify(command));
    await importer.close();

    const firstSelected = await seedCrossMedia(selectedPlan(qualified), path, api, undefined, {
      providers: ['bangumi'],
    });
    expect(firstSelected.readings.find((reading) => reading.externalId === '94001')?.subject.subject?.id).toBe(
      subjectId,
    );
    expect(commands.some((command) => command.op === 'propose' && command.statement.property.id === dateProperty)).toBe(
      false,
    );

    const corrected = game('2006-04');
    const refreshed = await seedCrossMedia(selectedPlan(corrected), path, api, undefined, { providers: ['bangumi'] });
    expect(refreshed.readings.find((reading) => reading.externalId === '94001')?.subject.subject?.id).toBe(subjectId);
    const selectedDate = commands.find(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' &&
        command.source.external_id === '94001' &&
        command.statement.property.id === dateProperty,
    );
    expect(selectedDate?.statement.value).toEqual({
      type: 'value',
      content: { time: '+2006-04-00T00:00:00Z', precision: 10, calendarmodel: gregorian },
    });
    expect(selectedDate?.source).toMatchObject({
      source: alias,
      external_id: '94001',
      record_revision: 'unversioned',
      converter_revision: crossMediaBangumiRevision,
    });
    expect(selectedDate?.statement.references).toContainEqual(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({
            property: { id: 'schema:url' },
            value: { type: 'value', content: 'https://bgm.tv/subject/94001' },
          }),
        ]),
      }),
    );
    expect(selectedDate?.source.digest).not.toBe(commands[0]?.source.digest);
    expect(commands.slice(0, oldCommands.length).map((command) => JSON.stringify(command))).toEqual(oldCommands);

    importer = new Importer({ path, transport: api });
    expect((await importer.runDump(ordinary, bytes(corrected))).status).toBe('committed');
    const ordinaryDate = commands.find(
      (command): command is Extract<BatchCommand, { op: 'propose' }> =>
        command.op === 'propose' &&
        command.source.external_id === '94001' &&
        command.source.converter_revision === converter_revision &&
        command.statement.property.id === dateProperty,
    );
    expect(ordinaryDate?.subject).toBe(subjectId);
    expect(ordinaryDate?.statement.value).toEqual(selectedDate?.statement.value);
    expect([...api.ids.keys()].filter((key) => key === `${alias}\0${qualified.id}`)).toHaveLength(1);
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
});

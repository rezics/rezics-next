import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand, BatchWriteRequest, BatchWriteResult } from '@rezics/definitions/bulk';
import { converter_revision } from '@rezics/conversion/bangumi';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { Importer } from '../src/importer.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { crossMediaAliases } from '../src/cross-media-seed.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';
import type { SourceRegistration } from '../src/import-contract.ts';

const gameId = 91041;
const rangeInfobox = '{{Infobox Game\n|中文名=发条观测\n|游玩人数=1-4人\n|website=https://example.invalid/game\n}}';
const modeInfobox =
  '{{Infobox Game\n|中文名=发条观测\n|游玩人数=1人（在线2-4人）\n|website=https://example.invalid/game\n}}';

function record(infobox: string) {
  return { id: gameId, type: 4, name: 'Clockwork Watch', name_cn: '发条观测', infobox };
}

function dump(infobox: string) {
  return `${JSON.stringify(record(infobox))}\n`;
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

function withoutPlayerCounts(registration: SourceRegistration): SourceRegistration {
  return {
    ...registration,
    convert(input, context) {
      const result = registration.convert(input, context);
      return {
        ...result,
        proposals: result.proposals.filter(
          (command) => command.op !== 'propose' || command.statement.property.id !== 'schema:numberOfPlayers',
        ),
      };
    },
  };
}

function playerCommands(commands: readonly BatchCommand[]) {
  return commands.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' && command.statement.property.id === 'schema:numberOfPlayers',
  );
}

test('ordinary and selected-family Game callers propose a stated range, withhold a mode-qualified count, and refresh a corrected same UUID', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-player-count-'));
  const path = join(directory, 'state.sqlite');
  const commands: BatchCommand[] = [];
  const api = transport(commands);
  const current = createSourceRegistration('bangumi');
  const previous = withoutPlayerCounts(createSourceRegistration('bangumi', { converterRevision: 'bangumi@8' }));
  expect(converter_revision).toBe('bangumi@11');
  let importer = new Importer({ path, transport: api });
  try {
    expect((await importer.runDump(previous, bytes(dump(modeInfobox)))).status).toBe('committed');
    const id = api.subjects.get(String(gameId));
    expect(id).toBeDefined();
    expect(playerCommands(commands)).toEqual([]);
    const created = commands.filter((command) => command.op === 'create').length;

    await importer.close();
    importer = new Importer({ path, transport: api });
    expect((await importer.runDump(current, bytes(dump(modeInfobox)))).status).toBe('committed');
    expect(api.subjects.get(String(gameId))).toBe(id);
    expect(playerCommands(commands)).toEqual([]);
    const mode = current.convert(
      { external_id: String(gameId), record_revision: null, record: record(modeInfobox) },
      { source: 'bangumi', subjectId: id! },
    );
    expect(mode.diagnostics).toEqual(
      expect.arrayContaining([
        { pointer: '/infobox/游玩人数', code: 'unsupported_player_count' },
        { pointer: '/infobox/中文名', code: 'unsupported_infobox_mapping' },
      ]),
    );
    expect(mode.diagnostics).not.toContainEqual({
      pointer: '/infobox/website',
      code: 'unsupported_infobox_mapping',
    });
    expect(
      mode.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:url'),
    ).toBe(true);
    expect(JSON.stringify(mode.diagnostics)).not.toContain('在线');
    expect(
      mode.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:name'),
    ).toBe(true);

    expect((await importer.runDump(current, bytes(dump(rangeInfobox)))).status).toBe('committed');
    expect(api.subjects.get(String(gameId))).toBe(id);
    const proposed = playerCommands(commands);
    expect(proposed).toHaveLength(1);
    expect(proposed[0]).toMatchObject({
      subject: id,
      statement: {
        property: { id: 'schema:numberOfPlayers' },
        value: { type: 'value', content: { amount: '+4', unit: '1' } },
        qualifiers: [
          {
            property: { id: 'schema:minValue' },
            value: { type: 'value', content: { amount: '+1', unit: '1' } },
          },
        ],
        references: [
          {
            parts: [
              { property: { id: 'schema:url' }, value: { type: 'value', content: 'https://bgm.tv/subject/91041' } },
            ],
          },
        ],
      },
      source: {
        source: 'bangumi',
        external_id: '91041',
        record_revision: 'unversioned',
        converter_revision: 'bangumi@11',
      },
    });
    expect(JSON.stringify(proposed[0]!.statement.value)).not.toContain('lowerBound');
    expect(commands.filter((command) => command.op === 'create')).toHaveLength(created);

    const afterCorrection = commands.length;
    expect((await importer.runDump(current, bytes(dump(rangeInfobox)))).status).toBe('committed');
    expect(commands).toHaveLength(afterCorrection);
    expect(api.subjects.get(String(gameId))).toBe(id);

    const selected = createSourceRegistration('bangumi', {
      source: crossMediaAliases.bangumi,
      converterRevision: entityRevision,
    });
    const family = selected.convert(
      { external_id: String(gameId), record_revision: null, record: record(rangeInfobox) },
      { source: crossMediaAliases.bangumi, subjectId: id! },
    );
    const familyCount = family.proposals.find(
      (command) => command.op === 'propose' && command.statement.property.id === 'schema:numberOfPlayers',
    );
    expect(familyCount).toMatchObject({
      statement: {
        value: { content: { amount: '+4', unit: '1' } },
        qualifiers: [{ property: { id: 'schema:minValue' }, value: { content: { amount: '+1', unit: '1' } } }],
      },
      source: { source: crossMediaAliases.bangumi, converter_revision: entityRevision },
    });
  } finally {
    await importer.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

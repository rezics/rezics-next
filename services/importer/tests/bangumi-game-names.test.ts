import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { crossMediaBangumiRevision, createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const gameId = '990321';
const neighborId = '990322';
const fixturePath = join(import.meta.dir, 'fixtures', 'bangumi-game-names.jsonl');
const roots = resolve(import.meta.dir, '../../..');

async function records(changed = false): Promise<Record<string, unknown>[]> {
  const rows = (await readFile(fixturePath, 'utf8'))
    .trimEnd()
    .split('\n')
    .map((line) => JSON.parse(line) as Record<string, unknown>);
  if (changed) {
    const game = rows.find((row) => row.id === Number(gameId));
    if (!game || typeof game.infobox !== 'string') throw new Error('Missing game fixture');
    game.infobox = game.infobox.replace('|别名=星海之旅', '|别名=新星海之旅');
  }
  return rows;
}

async function buildPlan(directory: string, changed = false) {
  await writeFile(
    join(directory, 'subject.jsonlines'),
    (await records(changed)).map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  const dump = new CrossMediaDumpFiles(directory, directory);
  const vnIds = ['v101', 'v102', 'v103'];
  const titles = ['STEINS;GATE', 'CLANNAD', 'Fate/stay night'];
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield* dump.rows(provider, table);
      if (provider === 'vndb' && table === 'vn_titles')
        yield* vnIds.map((id, index) => ({ id, lang: 'ja', official: 't', title: titles[index]!, latin: null }));
      if (provider === 'vndb' && table === 'vn') yield* vnIds.map((id) => ({ id, olang: 'ja', alias: null }));
      if (provider === 'vndb' && table === 'entry_meta')
        yield* vnIds.map((id) => ({ id, revision: '1', lastmod: '2026-10-25 00:00:00+00' }));
    },
  };
  return planCrossMediaSeed(tables);
}

function port(sent: BatchCommand[], identities: Map<string, string>, created: string[]): CrossMediaPort {
  const metadata = sourceRecordMetadataFixture();
  return {
    async batch(request) {
      sent.push(...structuredClone(request.commands));
      return {
        results: request.commands.map((command) => ({
          key: command.key,
          status: 201 as const,
          value:
            command.op === 'create'
              ? (() => {
                  const externalId = command.source.external_id;
                  created.push(externalId);
                  const id = identities.get(externalId) ?? randomUUID();
                  identities.set(externalId, id);
                  return { id, revision: 1 };
                })()
              : command.op === 'propose'
                ? { candidate: randomUUID(), revision: 1 }
                : { revision: 1 },
        })),
      };
    },
    setSourceRecordMetadata: metadata.setSourceRecordMetadata,
    async fence() {
      return { fenced: false, securityRevision: null };
    },
    async writeSourceStatistic() {},
    async clearSourceStatistic() {},
    async readReviewedSubject(id) {
      return { subject: { id } } as Awaited<ReturnType<CrossMediaPort['readReviewedSubject']>>;
    },
  };
}

function nameCommands(commands: readonly BatchCommand[]) {
  return commands
    .filter(
      (command) =>
        command.op === 'propose' &&
        command.source.external_id === gameId &&
        ['schema:name', 'schema:alternateName'].includes(command.statement.property.id),
    )
    .sort((left, right) => {
      if (left.op !== 'propose' || right.op !== 'propose') return 0;
      const tuple = (command: typeof left) => {
        if (command.op !== 'propose' || command.statement.value.type !== 'value') return '';
        const content = command.statement.value.content as { language?: string; text?: string };
        return `${command.statement.property.id}\u0000${content.language ?? ''}\u0000${content.text ?? ''}`;
      };
      return tuple(left) < tuple(right) ? -1 : tuple(left) > tuple(right) ? 1 : 0;
    });
}

test('selected-family Game rows use the Bangumi converter and retain only bounded Game names', async () => {
  const sourceDir = await mkdtemp(join(roots, '.temp/bangumi-game-names-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'bangumi-game-names-state-'));
  const state = join(stateDir, 'state.sqlite');
  const sent: BatchCommand[] = [];
  const identities = new Map<string, string>();
  const created: string[] = [];
  const api = port(sent, identities, created);
  const run = (input: Awaited<ReturnType<typeof buildPlan>>) =>
    seedCrossMedia(input, state, api, undefined, { providers: ['bangumi'], mediaDeadlineMs: 0 });
  try {
    const selected = await buildPlan(sourceDir);
    expect(selected.records.bangumi.some((row) => row.key === gameId)).toBe(true);
    expect(selected.records.bangumi.some((row) => row.key === neighborId)).toBe(false);

    const first = await run(selected);
    expect(first.runs.bangumi?.status).toBe('committed');
    const names = nameCommands(sent);
    expect(
      names.map((command) => ({
        property: command.op === 'propose' ? command.statement.property.id : '',
        value:
          command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : null,
      })),
    ).toEqual([
      { property: 'schema:alternateName', value: { language: 'und', text: 'Moon Path' } },
      { property: 'schema:alternateName', value: { language: 'und', text: 'クラナド' } },
      { property: 'schema:alternateName', value: { language: 'und', text: '星海之旅' } },
      { property: 'schema:name', value: { language: 'und', text: 'CLANNAD' } },
      { property: 'schema:name', value: { language: 'zh', text: 'CLANNAD 中文名' } },
      { property: 'schema:name', value: { language: 'zh', text: '古典中文题名' } },
    ]);
    for (const command of names) {
      if (command.op !== 'propose') continue;
      expect(command.source).toMatchObject({
        source: crossMediaAliases.bangumi,
        external_id: gameId,
        record_revision: 'unversioned',
        converter_revision: crossMediaBangumiRevision,
        digest: expect.stringMatching(/^[a-f0-9]{64}$/),
      });
      expect(command.statement.references).toEqual([
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: `https://bgm.tv/subject/${gameId}` },
            },
          ],
        },
      ]);
    }
    expect(names.some((command) => JSON.stringify(command).includes('不予采纳'))).toBe(false);
    expect(sent.some((command) => command.source.external_id === neighborId)).toBe(false);
    const subjectId = identities.get(gameId);

    const unchangedStart = sent.length;
    const unchanged = await run(selected);
    expect(unchanged.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(sent.slice(unchangedStart)).toEqual([]);

    const changedStart = sent.length;
    const changed = await run(await buildPlan(sourceDir, true));
    expect(changed.runs.bangumi?.counts.changed).toBe(1);
    expect(identities.get(gameId)).toBe(subjectId);
    expect(created).toEqual(selected.records.bangumi.map((row) => row.key));
    const refreshedNames = nameCommands(sent.slice(changedStart));
    expect(refreshedNames.every((command) => !names.some((previous) => previous.key === command.key))).toBe(true);
    expect(
      refreshedNames.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.value.type === 'value' &&
          (command.statement.value.content as { text?: string }).text === '新星海之旅',
      ),
    ).toBe(true);

    const registration = createSourceRegistration('bangumi', {
      source: crossMediaAliases.bangumi,
      converterRevision: crossMediaBangumiRevision,
    });
    const game = (await records()).find((row) => row.id === Number(gameId))!;
    if (typeof game.infobox !== 'string') throw new Error('Missing Game infobox');
    const conversion = registration.convert(
      { external_id: gameId, record_revision: null, record: game },
      { source: crossMediaAliases.bangumi, subjectId: subjectId! },
    );
    expect((conversion.normalized as { infobox?: string }).infobox).toBe(game.infobox);
    expect(conversion.diagnostics).toContainEqual({
      pointer: '/infobox/fields/3',
      code: 'unsupported_infobox_name_form',
    });
    expect(JSON.stringify(conversion.diagnostics)).not.toContain('不予采纳');
    expect(conversion.diagnostics!.length).toBeLessThanOrEqual(16);
    expect(registration.converter_revision).toBe(`${bangumiRevision}+${entityRevision}`);

    const wrongTemplate = registration.convert(
      {
        external_id: gameId,
        record_revision: null,
        record: { ...game, infobox: game.infobox.replace('{{Infobox Game', '{{Infobox animanga/TVAnime') },
      },
      { source: crossMediaAliases.bangumi, subjectId: subjectId! },
    );
    expect(
      wrongTemplate.proposals.filter(
        (command) => command.op === 'propose' && command.statement.property.id === 'schema:alternateName',
      ),
    ).toHaveLength(0);
    expect(wrongTemplate.diagnostics).toContainEqual({ pointer: '/infobox', code: 'unsupported_infobox_template' });
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

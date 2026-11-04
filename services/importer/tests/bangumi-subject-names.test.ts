import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import { converter_revision as entityRevision } from '@rezics/conversion/cross-media-entities';
import { converter_revision as bangumiRevision } from '@rezics/conversion/bangumi';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createSourceRegistration } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const targetId = 990301;
const target = (changed = false) => ({
  id: targetId,
  type: 2,
  name: 'CLANNAD',
  name_cn: '中文题名',
  infobox: `{{Infobox animanga/TVAnime
|中文名=中文题名
|中文名=中文题名
|别名=${changed ? 'Recovered title' : 'Mixed scalar alias'}
${changed ? '' : '* Mixed list alias\n'}|别名=CLANNAD After Story
|别名=
* クラナド
* Alternate title
* Alternate title
${changed ? '* Updated title\n' : ''}|自定义字段=PRIVATE_MARKER
|话数=24
}}`,
});
const supportSubjects = [
  { id: 990303, type: 2, name: 'STEINS;GATE' },
  { id: 990304, type: 2, name: 'Fate/stay night' },
];
const neighbor = { id: 990302, type: 1, name: 'Unselected neighbor' };
const roots = resolve(import.meta.dir, '../../..');

async function plan(directory: string, record: object) {
  await writeFile(
    join(directory, 'subject.jsonlines'),
    [record, ...supportSubjects, neighbor].map((row) => JSON.stringify(row)).join('\n') + '\n',
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
        command.source.external_id === String(targetId) &&
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

test('selected-family Bangumi TVAnime imports bounded names through the registered source converter', async () => {
  const sourceDir = await mkdtemp(join(roots, '.temp/bangumi-subject-names-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'bangumi-subject-names-state-'));
  const state = join(stateDir, 'state.sqlite');
  const sent: BatchCommand[] = [];
  const identities = new Map<string, string>();
  const created: string[] = [];
  const api = port(sent, identities, created);
  const run = (input: Awaited<ReturnType<typeof plan>>) =>
    seedCrossMedia(input, state, api, undefined, { providers: ['bangumi'], mediaDeadlineMs: 0 });
  try {
    const selected = await plan(sourceDir, target());
    expect(selected.records.bangumi.map((row) => row.key)).toEqual([
      String(targetId),
      ...supportSubjects.map((row) => String(row.id)),
    ]);
    expect(selected.records.bangumi.some((row) => row.key === String(neighbor.id))).toBe(false);

    const first = await run(selected);
    expect(first.runs.bangumi?.status).toBe('committed');
    const firstNames = nameCommands(sent);
    expect(
      firstNames.map((command) => ({
        property: command.op === 'propose' ? command.statement.property.id : '',
        value:
          command.op === 'propose' && command.statement.value.type === 'value' ? command.statement.value.content : null,
      })),
    ).toEqual([
      { property: 'schema:alternateName', value: { language: 'und', text: 'Alternate title' } },
      { property: 'schema:alternateName', value: { language: 'und', text: 'CLANNAD After Story' } },
      { property: 'schema:alternateName', value: { language: 'und', text: 'クラナド' } },
      { property: 'schema:name', value: { language: 'und', text: 'CLANNAD' } },
      { property: 'schema:name', value: { language: 'zh', text: '中文题名' } },
    ]);
    for (const command of firstNames) {
      if (command.op !== 'propose') continue;
      expect(command.source).toMatchObject({
        source: crossMediaAliases.bangumi,
        external_id: String(targetId),
        record_revision: 'unversioned',
        converter_revision: `${bangumiRevision}+${entityRevision}`,
      });
      expect(command.statement.references).toEqual([
        {
          parts: [
            {
              property: { id: 'schema:url' },
              value: { type: 'value', content: `https://bgm.tv/subject/${targetId}` },
            },
          ],
        },
      ]);
    }
    expect(
      firstNames.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.value.type === 'value' &&
          ['Mixed scalar alias', 'Mixed list alias'].includes(
            (command.statement.value.content as { text?: string }).text ?? '',
          ),
      ),
    ).toBe(false);
    expect(sent.some((command) => command.source.external_id === String(neighbor.id))).toBe(false);
    const acknowledgedSubject = identities.get(String(targetId));

    const unchangedStart = sent.length;
    const unchanged = await run(selected);
    expect(unchanged.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(sent.slice(unchangedStart)).toEqual([]);

    const changedStart = sent.length;
    const changed = await run(await plan(sourceDir, target(true)));
    expect(changed.runs.bangumi?.counts.changed).toBe(1);
    expect(identities.get(String(targetId))).toBe(acknowledgedSubject);
    expect(created).toEqual(selected.records.bangumi.map((row) => row.key));
    const refreshedNames = nameCommands(sent.slice(changedStart));
    expect(refreshedNames.every((command) => !firstNames.some((previous) => previous.key === command.key))).toBe(true);
    expect(
      refreshedNames.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.value.type === 'value' &&
          (command.statement.value.content as { text?: string }).text === 'Updated title',
      ),
    ).toBe(true);
    expect(
      refreshedNames.some(
        (command) =>
          command.op === 'propose' &&
          command.statement.value.type === 'value' &&
          (command.statement.value.content as { text?: string }).text === 'Recovered title',
      ),
    ).toBe(true);

    const registration = createSourceRegistration('bangumi', {
      source: crossMediaAliases.bangumi,
      converterRevision: entityRevision,
    });
    const conversion = registration.convert(
      { external_id: String(targetId), record_revision: null, record: target() },
      { source: crossMediaAliases.bangumi, subjectId: identities.get(String(targetId))! },
    );
    expect(conversion.diagnostics?.map((diagnostic) => diagnostic.code)).toContain('unsupported_infobox_key');
    expect(conversion.diagnostics).toContainEqual({
      pointer: '/infobox/fields/2',
      code: 'unsupported_infobox_name_form',
    });
    expect(JSON.stringify(conversion.diagnostics)).not.toContain('PRIVATE_MARKER');
    expect(conversion.diagnostics!.length).toBeLessThanOrEqual(16);
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

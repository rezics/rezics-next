import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
import {
  CrossMediaDumpFiles,
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../src/cross-media-seed.ts';
import { createSourceRegistration, crossMediaBangumiRevision } from '../src/source-registry.ts';
import { sourceRecordMetadataFixture } from './transport-driver.ts';

const externalId = '990401';
const sourceUrl = `https://bgm.tv/subject/${externalId}`;
const firstUrl = 'https://anime.example.jp/official/?from=bgm#staff';
const secondUrl = 'https://anime.example.jp/en?lang=ja#official';
const invalidList = 'https://anime.example.jp https://another.example.jp';
const supportSubjects = [
  { id: 990403, type: 2, name: 'STEINS;GATE' },
  { id: 990404, type: 2, name: 'Fate/stay night' },
];
const neighbor = { id: 990402, type: 1, name: 'Unselected neighbor' };
const target = (primary = firstUrl) => ({
  id: Number(externalId),
  type: 2,
  name: 'CLANNAD',
  platform: 'TV',
  infobox: `{{Infobox animanga/TVAnime
|官方网站=${primary}
|官方网站=${primary}
|官方网站=${secondUrl}
|官方网站=${invalidList}
|话数=24
}}`,
});
const roots = resolve(import.meta.dir, '../../..');

async function selectedPlan(directory: string, record: object) {
  await writeFile(
    join(directory, 'subject.jsonlines'),
    [record, ...supportSubjects, neighbor].map((row) => JSON.stringify(row)).join('\n') + '\n',
  );
  const dump = new CrossMediaDumpFiles(directory, directory);
  const ids = ['v101', 'v102', 'v103'];
  const titles = ['STEINS;GATE', 'CLANNAD', 'Fate/stay night'];
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') yield* dump.rows(provider, table);
      if (provider === 'vndb' && table === 'vn_titles')
        yield* ids.map((id, index) => ({ id, lang: 'ja', official: 't', title: titles[index]!, latin: null }));
      if (provider === 'vndb' && table === 'vn') yield* ids.map((id) => ({ id, olang: 'ja', alias: null }));
      if (provider === 'vndb' && table === 'entry_meta')
        yield* ids.map((id) => ({ id, revision: '1', lastmod: '2026-10-25 00:00:00+00' }));
    },
  };
  return planCrossMediaSeed(tables);
}

function createPort(sent: BatchCommand[], identities: Map<string, string>, created: string[]): CrossMediaPort {
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
                  const key = command.source.external_id;
                  created.push(key);
                  const id = identities.get(key) ?? randomUUID();
                  identities.set(key, id);
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

function websiteValues(commands: readonly BatchCommand[]) {
  return commands.flatMap((command) =>
    command.op === 'propose' &&
    command.source.external_id === externalId &&
    command.statement.property.id === 'schema:url' &&
    command.statement.value.type === 'value' &&
    typeof command.statement.value.content === 'string'
      ? [{ command, url: command.statement.value.content }]
      : [],
  );
}

test('ordinary and selected-family Bangumi TVAnime imports propose cited literal websites on the same identity', async () => {
  const sourceDir = await mkdtemp(join(roots, '.temp/bangumi-official-websites-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'bangumi-official-websites-state-'));
  const state = join(stateDir, 'state.sqlite');
  const sent: BatchCommand[] = [];
  const identities = new Map<string, string>();
  const created: string[] = [];
  const api = createPort(sent, identities, created);
  try {
    const record = target();
    const ordinary = createSourceRegistration('bangumi');
    const conversion = ordinary.convert(
      { external_id: externalId, record_revision: null, record },
      { source: ordinary.source, subjectId: randomUUID() },
    );
    const ordinarySites = websiteValues(conversion.proposals);
    expect(ordinarySites.map((item) => item.url)).toEqual([firstUrl, secondUrl]);
    expect(conversion.diagnostics).toContainEqual(
      expect.objectContaining({ pointer: '/infobox/fields/3', code: 'unsupported_infobox_website_form' }),
    );
    for (const { command, url } of ordinarySites) {
      expect(url).not.toBe(sourceUrl);
      expect(command.source.converter_revision).toBe('bangumi@14');
      expect(command.op === 'propose' && command.statement.references).toEqual([
        {
          parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }],
        },
      ]);
    }

    const plan = await selectedPlan(sourceDir, record);
    expect(plan.records.bangumi.map((row) => row.key)).toContain(externalId);
    expect(plan.records.bangumi.some((row) => row.key === String(neighbor.id))).toBe(false);
    const run = (selected: Awaited<ReturnType<typeof selectedPlan>>) =>
      seedCrossMedia(selected, state, api, undefined, { providers: ['bangumi'], mediaDeadlineMs: 0 });
    const first = await run(plan);
    expect(first.runs.bangumi?.status).toBe('committed');
    const defaultSites = websiteValues(sent);
    expect(defaultSites.map(({ command, url }) => [command.source.source, url])).toEqual([
      [crossMediaAliases.bangumi, firstUrl],
      [crossMediaAliases.bangumi, secondUrl],
    ]);
    for (const { command, url } of defaultSites) {
      expect(url).not.toBe(sourceUrl);
      expect(command.op).toBe('propose');
      if (command.op !== 'propose') continue;
      expect(command.source).toMatchObject({
        source: crossMediaAliases.bangumi,
        external_id: externalId,
        record_revision: 'unversioned',
        converter_revision: crossMediaBangumiRevision,
      });
      expect(command.statement.references).toEqual([
        { parts: [{ property: { id: 'schema:url' }, value: { type: 'value', content: sourceUrl } }] },
      ]);
    }
    const subjectId = identities.get(externalId);
    expect(subjectId).toBeDefined();
    expect(created.filter((key) => key === externalId)).toHaveLength(1);

    const changedStart = sent.length;
    const changed = await run(
      await selectedPlan(sourceDir, target('https://anime.example.jp/official/v2?lang=ja#staff')),
    );
    expect(changed.runs.bangumi?.counts.changed).toBe(1);
    expect(identities.get(externalId)).toBe(subjectId);
    expect(created.filter((key) => key === externalId)).toHaveLength(1);
    expect(websiteValues(sent.slice(changedStart)).map(({ url }) => url)).toContain(
      'https://anime.example.jp/official/v2?lang=ja#staff',
    );
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

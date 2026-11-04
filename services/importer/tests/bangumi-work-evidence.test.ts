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

const targetId = 990401;
const descriptiveUrl = 'https://catalogue.example/anime/CLANNAD?lang=ja#work';
const changedUrl = 'https://catalogue.example/anime/CLANNAD?lang=en#work';
const repairedUrl = 'https://archive.example/series/CLANNAD?copy=1';
const notice = '© 2007 Key / Visual Arts. All rights reserved.';
const changedNotice = '© 2008 Key / Visual Arts. All rights reserved.';
const badLink = '[[https://untrusted.example/series|Display title]]';
const target = (changed = false) => ({
  id: targetId,
  type: 2,
  name: 'CLANNAD',
  infobox: `{{Infobox animanga/TVAnime
|官方网站=https://official.example/clannad
|链接=
* ${changed ? changedUrl : descriptiveUrl}
|Copyright=${changed ? changedNotice : notice}
|链接=${changed ? repairedUrl : badLink}
}}`,
});
const supportSubjects = [
  { id: 990403, type: 2, name: 'STEINS;GATE' },
  { id: 990404, type: 2, name: 'Fate/stay night' },
];
const neighbor = { id: 990402, type: 1, name: 'Unselected neighbor' };
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

function evidenceCommands(commands: readonly BatchCommand[]) {
  return commands.filter(
    (command): command is Extract<BatchCommand, { op: 'propose' }> =>
      command.op === 'propose' &&
      command.source.external_id === String(targetId) &&
      ['wdt:P973', 'schema:copyrightNotice'].includes(command.statement.property.id),
  );
}

function evidenceValues(commands: readonly BatchCommand[]) {
  return evidenceCommands(commands)
    .map((command) => ({
      property: command.statement.property.id,
      value: command.statement.value.type === 'value' ? command.statement.value.content : null,
    }))
    .sort((left, right) => `${left.property}\u0000${left.value}`.localeCompare(`${right.property}\u0000${right.value}`));
}

test('selected-family Bangumi import proposes only cited TVAnime work evidence and refreshes its source-owned values', async () => {
  const sourceDir = await mkdtemp(join(roots, '.temp/bangumi-work-evidence-'));
  const stateDir = await mkdtemp(join(tmpdir(), 'bangumi-work-evidence-state-'));
  const state = join(stateDir, 'state.sqlite');
  const sent: BatchCommand[] = [];
  const identities = new Map<string, string>();
  const created: string[] = [];
  const api = port(sent, identities, created);
  const run = (input: Awaited<ReturnType<typeof plan>>) =>
    seedCrossMedia(input, state, api, undefined, { providers: ['bangumi'], mediaDeadlineMs: 0 });
  try {
    const selected = await plan(sourceDir, target());
    expect(selected.records.bangumi.some((row) => row.key === String(neighbor.id))).toBe(false);

    const registration = createSourceRegistration('bangumi', {
      source: crossMediaAliases.bangumi,
      converterRevision: crossMediaBangumiRevision,
    });
    const direct = registration.convert(
      { external_id: String(targetId), record_revision: null, record: target() },
      { source: crossMediaAliases.bangumi, subjectId: randomUUID() },
    );
    expect(evidenceValues(direct.proposals)).toEqual([
      { property: 'schema:copyrightNotice', value: notice },
      { property: 'wdt:P973', value: descriptiveUrl },
    ]);
    expect(direct.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:url'))
      .toBe(false);
    expect(direct.proposals.some((command) => command.op === 'propose' && command.statement.property.id === 'schema:sameAs'))
      .toBe(false);
    expect(direct.diagnostics).toContainEqual({ pointer: '/infobox/fields/3', code: 'invalid_descriptive_link' });
    expect(JSON.stringify(direct.diagnostics)).not.toContain(badLink);
    expect(direct.sourceMetadata).toEqual({
      recordUrl: `https://bgm.tv/subject/${targetId}`,
      summary: { language: 'und', takedownEligible: true },
      cover: { role: 'cover', creditLine: '(c) rights holder via Bangumi', takedownEligible: true },
    });
    expect(direct.coverAssets).toEqual([]);
    expect(direct.mediaImportIntents).toEqual([]);
    expect(direct.proposals.some((command) => command.op === 'propose' && ['schema:abstract', 'schema:image'].includes(command.statement.property.id)))
      .toBe(false);

    const first = await run(selected);
    expect(first.runs.bangumi?.status).toBe('committed');
    const firstEvidence = evidenceCommands(sent);
    expect(evidenceValues(firstEvidence)).toEqual([
      { property: 'schema:copyrightNotice', value: notice },
      { property: 'wdt:P973', value: descriptiveUrl },
    ]);
    for (const command of firstEvidence) {
      expect(command.source).toMatchObject({
        source: crossMediaAliases.bangumi,
        external_id: String(targetId),
        record_revision: 'unversioned',
        converter_revision: crossMediaBangumiRevision,
      });
      expect(command.source.digest).toMatch(/^[a-f0-9]{64}$/u);
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
    expect(firstEvidence.every((command) => command.statement.value.type === 'value')).toBe(true);
    expect(sent.some((command) => command.source.external_id === String(neighbor.id))).toBe(false);
    expect(created).toEqual(selected.records.bangumi.map((row) => row.key));

    const unchangedStart = sent.length;
    const unchanged = await run(selected);
    expect(unchanged.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(sent.slice(unchangedStart)).toEqual([]);

    const changedStart = sent.length;
    const changed = await run(await plan(sourceDir, target(true)));
    expect(changed.runs.bangumi?.counts.changed).toBe(1);
    const refreshed = evidenceCommands(sent.slice(changedStart));
    expect(evidenceValues(refreshed)).toEqual([
      { property: 'schema:copyrightNotice', value: changedNotice },
      { property: 'wdt:P973', value: changedUrl },
      { property: 'wdt:P973', value: repairedUrl },
    ]);
    expect(refreshed.every((command) => !firstEvidence.some((previous) => previous.key === command.key))).toBe(true);
    expect(refreshed.every((command) => command.source.digest !== firstEvidence[0]!.source.digest)).toBe(true);
    expect(identities.get(String(targetId))).toBeDefined();
  } finally {
    await rm(sourceDir, { recursive: true, force: true });
    await rm(stateDir, { recursive: true, force: true });
  }
});

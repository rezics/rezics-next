import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const globalContext = '00000000-0000-8000-8000-000000000000';
const gameId = '104';
const rangeInfobox = '{{Infobox Game\n|游玩人数=1-4人\n}}';
const modeInfobox = '{{Infobox Game\n|游玩人数=1人（在线2-4人）\n}}';
const changedInfobox = '{{Infobox Game\n|游玩人数=2-6人\n}}';

function tables(infobox: string): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 101, name: 'STEINS;GATE', type: 2 };
        yield { id: 102, name: 'CLANNAD', type: 2 };
        yield { id: 103, name: 'Fate/stay night', type: 2 };
        yield { id: 104, name: 'STEINS;GATE: Linear Bounded Phenogram', type: 4, infobox };
      }
      if (provider === 'vndb' && table === 'vn_titles') {
        yield { id: 'v1', lang: 'ja', official: 't', title: 'STEINS;GATE', latin: null };
        yield { id: 'v2', lang: 'ja', official: 't', title: 'CLANNAD', latin: null };
        yield { id: 'v3', lang: 'ja', official: 't', title: 'Fate/stay night', latin: null };
      }
      if (provider === 'vndb' && table === 'vn') {
        yield { id: 'v1', olang: 'ja', alias: null };
        yield { id: 'v2', olang: 'ja', alias: null };
        yield { id: 'v3', olang: 'ja', alias: null };
      }
      if (provider === 'vndb' && table === 'entry_meta') {
        yield { id: 'v1', revision: '1', lastmod: '2026-11-01 00:00:00+00' };
        yield { id: 'v2', revision: '1', lastmod: '2026-11-01 00:00:00+00' };
        yield { id: 'v3', revision: '1', lastmod: '2026-11-01 00:00:00+00' };
      }
    },
  };
}

function playerStatement(read: unknown) {
  const subject = (
    read as { subject?: { statements?: Record<string, { value?: { content?: unknown }; qualifiers?: unknown }[]> } }
  ).subject;
  return subject?.statements?.['schema:numberOfPlayers']?.[0];
}

function selectedPlayerCommands(journal: ShowcaseJournal) {
  return journal
    .acknowledgedCommands()
    .filter(
      ({ command }) =>
        command.op === 'propose' &&
        command.source.external_id === gameId &&
        command.statement.property.id === 'schema:numberOfPlayers',
    )
    .map(({ command, commandDigest, candidateId }) => ({
      key: command.key,
      commandDigest,
      candidateId,
      value: command.op === 'propose' ? command.statement.value : undefined,
      qualifiers: command.op === 'propose' ? command.statement.qualifiers : undefined,
    }));
}

test('selected Game player-count range is independently adopted and current, and a facts fence keeps a later range off that UUID', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-player-count-'));
  const importPath = join(directory, 'import.sqlite');
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const editor = await openApiObserver(runtime);
  const publicClient = createPublicBulkClient({
    origin: runtime.origin,
    fetch: async (input) => {
      const url = new URL(String(input));
      return runtime.request(`${url.pathname}${url.search}`);
    },
  });

  async function importSelected(infobox: string) {
    const plan = await planCrossMediaSeed(tables(infobox));
    expect(plan.records.bangumi.some((record) => record.key === gameId)).toBe(true);
    const result = await seedCrossMedia(
      plan,
      importPath,
      captureShowcaseCommands(runtime.importTransport, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'] },
    );
    const reading = result.readings.find((entry) => entry.externalId === gameId);
    const id = (reading?.subject as { subject?: { id?: string } }).subject?.id;
    if (!id) throw new Error('Selected Bangumi Game has no native binding');
    return { plan, result, id };
  }

  try {
    const first = await importSelected(modeInfobox);
    const missing = await runtime.importTransport.reviewedCandidates(first.id, {
      property: 'schema:numberOfPlayers',
      context: globalContext,
      limit: 100,
    });
    expect(missing.candidates.filter((candidate) => candidate.source?.external_id === gameId)).toEqual([]);
    expect(playerStatement(await publicClient.readSubject(first.id))).toBeUndefined();

    const corrected = await importSelected(rangeInfobox);
    expect(corrected.id).toBe(first.id);
    const listing = await runtime.importTransport.reviewedCandidates(first.id, {
      property: 'schema:numberOfPlayers',
      context: globalContext,
      limit: 100,
    });
    const candidate = listing.candidates.find((item) => item.source?.external_id === gameId);
    if (!candidate) throw new Error('Corrected player-count candidate is missing');
    expect(candidate.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: gameId,
      converter_revision: 'cross-media-entities@9+bangumi@10',
    });
    expect(candidate.statement.value).toEqual({ type: 'value', content: { amount: '+4', unit: '1' } });
    expect(candidate.statement.qualifiers).toEqual([
      {
        property: { id: 'schema:minValue' },
        value: { type: 'value', content: { amount: '+1', unit: '1' } },
      },
    ]);
    expect(candidate.statement.references).toContainEqual(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({ value: { type: 'value', content: 'https://bgm.tv/subject/104' } }),
        ]),
      }),
    );
    expect(playerStatement(await publicClient.readSubject(first.id))).toBeUndefined();
    expect(
      (
        await publishShowcase({
          plan: corrected.plan,
          result: corrected.result,
          aliases: crossMediaAliases,
          journal,
          review: runtime.importTransport,
          publicClient,
        })
      ).status,
    ).toBe('incomplete');
    const acknowledged = selectedPlayerCommands(journal);
    expect(acknowledged).toHaveLength(1);
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));

    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    await publishShowcase({
      plan: corrected.plan,
      result: corrected.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    const adopted = await runtime.importTransport.reviewedCandidates(first.id, {
      property: 'schema:numberOfPlayers',
      context: globalContext,
      limit: 100,
    });
    expect(adopted.adoption?.selection?.map((entry) => entry.candidate)).toContain(candidate.id);
    const current = playerStatement(await publicClient.readSubject(first.id));
    expect(current?.value?.content).toEqual({ amount: '+4', unit: '1' });
    expect(current?.qualifiers).toContainEqual({
      property: { id: 'schema:minValue' },
      value: { type: 'value', content: { amount: '+1', unit: '1' } },
    });

    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId: gameId,
      fieldGroup: 'facts',
      reason: 'Current Bangumi game facts fence',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const changed = await importSelected(changedInfobox);
    expect(changed.id).toBe(first.id);
    await publishShowcase({
      plan: changed.plan,
      result: changed.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(playerStatement(await publicClient.readSubject(first.id))?.value?.content).toEqual({
      amount: '+4',
      unit: '1',
    });
    expect(selectedPlayerCommands(journal)).toEqual(acknowledged);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);

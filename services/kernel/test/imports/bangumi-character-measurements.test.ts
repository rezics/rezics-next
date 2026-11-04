import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchCommand } from '@rezics/definitions/bulk';
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
const characterId = 'character:200';
const heightUnit = 'http://www.wikidata.org/entity/Q174728';
const weightUnit = 'http://www.wikidata.org/entity/Q11570';

function tables(infobox: string): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 101, name: 'STEINS;GATE', type: 2 };
        yield { id: 102, name: 'CLANNAD', type: 2 };
        yield { id: 103, name: 'Fate/stay night', type: 2 };
      }
      if (provider === 'bangumi' && table === 'subject-characters')
        yield { subject_id: 101, character_id: 200, type: 1, order: 1 };
      if (provider === 'bangumi' && table === 'character') {
        yield {
          id: 200,
          name: 'Rintaro Okabe',
          name_cn: '岡部倫太郎',
          type: 1,
          summary: 'A scientist.',
          infobox,
        };
        yield {
          id: 201,
          name: 'Rintaro Okabe',
          name_cn: '岡部倫太郎',
          type: 1,
          summary: 'A scientist.',
          infobox: '{{Infobox Crt\n|身高=172cm\n|体重=56kg\n}}',
        };
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

function values(read: unknown, property: string): unknown[] {
  const subject = (read as { subject?: { statements?: Record<string, { value?: { content?: unknown } }[]> } }).subject;
  return (subject?.statements?.[property] ?? []).map((statement) => statement.value?.content);
}

function selectedCharacterCommands(journal: ShowcaseJournal) {
  return journal
    .acknowledgedCommands()
    .filter(
      ({ command }) =>
        command.op === 'propose' &&
        command.source.external_id === characterId &&
        ['schema:height', 'schema:weight'].includes(command.statement.property.id),
    )
    .map(({ command, commandDigest, candidateId }) => ({
      key: command.key,
      commandDigest,
      candidateId,
      value: command.op === 'propose' ? command.statement.value : undefined,
    }));
}

test('default Bangumi seed publicly adopts selected character quantities and does not resend a changed fenced fact', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-character-profile-'));
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

  async function importSelected(sourceInfobox: string) {
    const plan = await planCrossMediaSeed(tables(sourceInfobox));
    const characters = plan.entities.bangumi.filter((record) => record.key.startsWith('character:'));
    expect(characters.map((record) => record.key)).toEqual([characterId]);
    const result = await seedCrossMedia(
      plan,
      importPath,
      captureShowcaseCommands(runtime.importTransport, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'] },
    );
    const reading = result.readings.find((entry) => entry.externalId === characterId);
    const id = (reading?.subject as { subject?: { id?: string } }).subject?.id;
    if (!id) throw new Error('Selected Bangumi Character has no native binding');
    return { plan, result, id };
  }

  try {
    const first = await importSelected('{{Infobox Crt\n|血型=A\n|身高=172cm\n|体重=56kg\n}}');
    expect(first.result.readings.find((entry) => entry.externalId === characterId)?.subject.subject?.id).toBe(first.id);
    expect(first.result.readings.some((entry) => entry.externalId === 'character:201')).toBe(false);
    const initialHeight = await runtime.importTransport.reviewedCandidates(first.id, {
      property: 'schema:height',
      context: globalContext,
      limit: 100,
    });
    const initialWeight = await runtime.importTransport.reviewedCandidates(first.id, {
      property: 'schema:weight',
      context: globalContext,
      limit: 100,
    });
    const heightCandidate = initialHeight.candidates.find((candidate) => candidate.source?.external_id === characterId);
    const weightCandidate = initialWeight.candidates.find((candidate) => candidate.source?.external_id === characterId);
    if (!heightCandidate || !weightCandidate) throw new Error('Selected physical candidates are missing');
    expect(heightCandidate.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: characterId,
      converter_revision: 'cross-media-entities@9',
    });
    expect(heightCandidate.statement.references).toContainEqual(
      expect.objectContaining({
        parts: expect.arrayContaining([
          expect.objectContaining({ value: { type: 'value', content: 'https://bgm.tv/character/200' } }),
        ]),
      }),
    );
    expect(values(await publicClient.readSubject(first.id), 'schema:height')).toEqual([]);
    expect(values(await publicClient.readSubject(first.id), 'schema:weight')).toEqual([]);

    expect(
      (
        await publishShowcase({
          plan: first.plan,
          result: first.result,
          aliases: crossMediaAliases,
          journal,
          review: runtime.importTransport,
          publicClient,
        })
      ).status,
    ).toBe('incomplete');
    const acknowledged = selectedCharacterCommands(journal);
    expect(acknowledged).toHaveLength(2);
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
      plan: first.plan,
      result: first.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    for (const [property, candidate] of [
      ['schema:height', heightCandidate],
      ['schema:weight', weightCandidate],
    ] as const) {
      const adopted = await runtime.importTransport.reviewedCandidates(first.id, {
        property,
        context: globalContext,
        limit: 100,
      });
      expect(adopted.adoption?.selection?.map((entry) => entry.candidate)).toContain(candidate.id);
    }
    expect(values(await publicClient.readSubject(first.id), 'schema:height')).toContainEqual({
      amount: '+172',
      unit: heightUnit,
    });
    expect(values(await publicClient.readSubject(first.id), 'schema:weight')).toContainEqual({
      amount: '+56',
      unit: weightUnit,
    });

    const sameState = await importSelected('{{Infobox Crt\n|血型=A\n|身高=172cm\n|体重=56kg\n}}');
    expect(sameState.id).toBe(first.id);
    expect(selectedCharacterCommands(journal)).toEqual(acknowledged);

    const fence = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId: characterId,
      fieldGroup: 'facts',
      reason: 'Current Bangumi character facts fence',
    });
    expect(fence.status, JSON.stringify(fence.body)).toBe(200);
    const changed = await importSelected('{{Infobox Crt\n|血型=A\n|身高=173cm\n|体重=56kg\n}}');
    expect(changed.id).toBe(first.id);
    await publishShowcase({
      plan: changed.plan,
      result: changed.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(values(await publicClient.readSubject(first.id), 'schema:height')).not.toContainEqual({
      amount: '+173',
      unit: heightUnit,
    });
    expect(selectedCharacterCommands(journal)).toEqual(acknowledged);
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

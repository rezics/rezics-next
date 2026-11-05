import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { BatchStatement } from '@rezics/definitions/bulk';
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
const characterExternalId = 'character:12393';
const performerExternalId = 'person:25284';
const sourceAliases = [
  '[第二中文名|]',
  '[英文名|Chris Makise]',
  '[日文名|牧瀬 紅莉栖]',
  '[纯假名|まきせ くりす]',
  '[罗马字|Makise Kurisu]',
  '[昵称|天才少女，THE ZOMBIE/复苏者，克里斯蒂娜，天才，天才变态少女，放荡天才变态少女，助手，变态，セレブ・セブンティーン/Celeb Seventeen/土豪十七，セレセブ/Celeb Sev/土七，最爱实验妹， 蒙古斑少女，@Channeler，Dr.Pepperian，克里斯蒂娜博士]',
  '[重要绰号|克里斯蒂娜/クリスティーナ/Christina]',
  '[网名|栗悟饭和龟波功（栗悟飯と亀波功）（网名）]',
];
const officialCharacter = JSON.parse(
  readFileSync(new URL('../../../../specs/fixtures/imports/bangumi/character-api-names.json', import.meta.url), 'utf8'),
) as Record<string, unknown>;

function tables(aliases = sourceAliases): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    subject: [{ id: 10380, type: 2, name: 'STEINS;GATE' }],
    'subject-characters': [{ subject_id: 10380, character_id: 12393, type: 1, order: 0 }],
    'person-characters': [{ subject_id: 10380, person_id: 25284, character_id: 12393 }],
    character: [
      {
        id: 12393,
        name: '牧瀬紅莉栖',
        name_cn: null,
        type: null,
        summary: 'A source summary.',
        infobox: ['{{Infobox Crt', '|简体中文名= 牧濑红莉栖', '|别名={', ...aliases, '}', '|性别= 女', '}}'].join(
          '\r\n',
        ),
      },
    ],
    person: [{ id: 25284, name: 'Miyano Mamoru', name_cn: '宮野真守', type: 1 }],
  };
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi') yield* rows[table] ?? [];
    },
  };
}

function parsedCharacterTables(character: Record<string, unknown> = officialCharacter): CrossMediaTables {
  const rows: Record<string, Record<string, unknown>[]> = {
    subject: [{ id: 10380, type: 2, name: 'STEINS;GATE' }],
    'subject-characters': [{ subject_id: 10380, character_id: character.id, type: 1, order: 0 }],
    character: [character],
  };
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi') yield* rows[table] ?? [];
    },
  };
}

function idOf(row: { subject: unknown }) {
  const value = row.subject as { subject?: { id?: string }; id?: string };
  return value.subject?.id ?? value.id;
}

function valueContent(statement: BatchStatement) {
  return statement.value.type === 'value' ? statement.value.content : undefined;
}

test('default selected Bangumi character names publish, retain adoption, and refresh within one source identity', async () => {
  const previousTmpdir = process.env.TMPDIR;
  process.env.TMPDIR = tmpdir();
  const runtime = await (async () => {
    try {
      return await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
    } finally {
      if (previousTmpdir === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = previousTmpdir;
    }
  })();
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-character-names-native-'));
  let journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  try {
    const editor = await openApiObserver(runtime);
    for (const accountId of [runtime.identity.bulk.accountId, runtime.identity.governance.accountId]) {
      const grant = await editor.http('/v1/grants', {
        resource: { route: 0, id: globalContext },
        subject: { kind: 'account', id: accountId },
        actions: ['context:accept', 'context:adopt'],
        valid: '(,)',
      });
      expect(grant.status).toBe(201);
    }
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    const state = join(directory, 'import.sqlite');
    async function run(input: CrossMediaTables) {
      const plan = await planCrossMediaSeed(input);
      const result = await seedCrossMedia(
        plan,
        state,
        captureShowcaseCommands(runtime.importTransport, journal),
        { origin: runtime.origin },
        { providers: ['bangumi'] },
      );
      return { plan, result };
    }
    async function publish(value: Awaited<ReturnType<typeof run>>) {
      return publishShowcase({
        plan: value.plan,
        result: value.result,
        aliases: crossMediaAliases,
        journal,
        review: runtime.importTransport,
        publicClient,
      });
    }
    const capturedApiNameCommands = () =>
      journal
        .acknowledgedCommands()
        .filter(
          ({ command }) =>
            command.source.external_id === 'character:1' &&
            command.op === 'propose' &&
            ['schema:name', 'schema:alternateName'].includes(command.statement.property.id),
        );
    const first = await run(tables());
    const character = first.result.readings.find((row) => row.externalId === characterExternalId);
    const performer = first.result.readings.find((row) => row.externalId === performerExternalId);
    expect(character && performer).toBeTruthy();
    const characterId = idOf(character!);
    const performerId = idOf(performer!);
    expect(characterId && performerId).toBeTruthy();
    const selectedCharacter = first.plan.entities.bangumi.find((record) => record.key === characterExternalId);
    expect((selectedCharacter?.payload as { infobox?: unknown } | undefined)?.infobox).toContain(
      '[英文名|Chris Makise]',
    );
    const publication = await publish(first);
    expect(['published', 'incomplete']).toContain(publication.status);
    const acknowledgedCount = journal.acknowledgedCommands().length;
    const read = async () => {
      const value = await publicClient.readSubject(characterId!);
      return value.subject as {
        id: string;
        type: string;
        statements: Record<string, BatchStatement[]>;
      };
    };
    const adopted = await read();
    expect(adopted.type).toBe('wd:Q95074');
    expect(adopted.statements['schema:name']?.map(valueContent)).toEqual(
      expect.arrayContaining([
        { language: 'zh-Hans', text: '牧濑红莉栖' },
        { language: 'und', text: '牧瀬紅莉栖' },
      ]),
    );
    expect(adopted.statements['schema:alternateName']?.map(valueContent)).toEqual(
      expect.arrayContaining([
        { language: 'en', text: 'Chris Makise' },
        { language: 'ja', text: '牧瀬 紅莉栖' },
        { language: 'ja', text: 'まきせ くりす' },
        { language: 'und-Latn', text: 'Makise Kurisu' },
        { language: 'und', text: 'THE ZOMBIE/复苏者' },
        { language: 'und', text: '助手' },
      ]),
    );

    const sourced = await editor.http(
      `/v1/subjects/${characterId}/candidates?${new URLSearchParams({
        property: 'schema:name',
        context: globalContext,
        limit: '100',
      })}`,
    );
    expect(sourced.status).toBe(200);
    const sourcedBody = sourced.body as {
      candidates: {
        statement: { references?: { parts: { property: { id: string }; value: { content: unknown } }[] }[] };
      }[];
    };
    const citation = sourcedBody.candidates.find((candidate) => candidate.statement.references?.length)?.statement
      .references;
    expect(citation?.[0]?.parts).toContainEqual({
      property: { id: 'schema:url' },
      value: { type: 'value', content: 'https://bgm.tv/character/12393' },
    });
    const alternate = await editor.http(`/v1/subjects/${characterId}/candidates`, {
      statement: {
        property: { id: 'schema:alternateName' },
        value: { type: 'value', content: { language: 'fr', text: 'La Red' } },
        references: citation?.[0]?.parts
          ? [{ parts: citation[0].parts.map((part) => ({ property: part.property, value: part.value })) }]
          : [],
      },
    });
    expect(alternate.status).toBe(201);
    const independent = (alternate.body as { candidate: string }).candidate;
    const alternateListing = await editor.http(
      `/v1/subjects/${characterId}/candidates?${new URLSearchParams({
        property: 'schema:alternateName',
        context: globalContext,
        limit: '100',
      })}`,
    );
    const candidate = (
      alternateListing.body as {
        candidates: { id: string; head: number; retracted: number | null }[];
      }
    ).candidates.find((item) => item.id === independent);
    expect(candidate).toBeTruthy();
    const accepted = await editor.http(`/v1/subjects/${characterId}/candidates/${independent}:accept`, {
      context: globalContext,
      expected_head: candidate!.head,
    });
    expect(accepted.status).toBe(200);
    const adoption = await editor.http(`/v1/subjects/${characterId}:adopt`, {
      context: globalContext,
      property: 'schema:alternateName',
      mode: 'replace',
      expected_head: (alternateListing.body as { adoption: { head: number } | null }).adoption?.head ?? null,
      selection: [{ candidate: independent, rank: 'normal' }],
    });
    expect(adoption.status).toBe(200);

    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const repeated = await run(tables());
    expect(repeated.result.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(journal.acknowledgedCommands()).toHaveLength(acknowledgedCount);
    expect(idOf(repeated.result.readings.find((row) => row.externalId === characterExternalId)!)).toBe(characterId);
    expect(idOf(repeated.result.readings.find((row) => row.externalId === performerExternalId)!)).toBe(performerId);

    const changed = await run(tables(sourceAliases.map((row) => row.replace('，助手，', '，'))));
    expect(changed.result.runs.bangumi?.counts.changed).toBeGreaterThan(0);
    expect(changed.plan.characterAppearances).toEqual(first.plan.characterAppearances);
    expect(changed.plan.credits.map((credit) => [credit.kind, credit.person, credit.character])).toEqual(
      first.plan.credits.map((credit) => [credit.kind, credit.person, credit.character]),
    );
    expect(idOf(changed.result.readings.find((row) => row.externalId === characterExternalId)!)).toBe(characterId);
    expect(idOf(changed.result.readings.find((row) => row.externalId === performerExternalId)!)).toBe(performerId);
    await publish(changed);
    const refreshed = await read();
    const alternates = refreshed.statements['schema:alternateName']?.map(valueContent) ?? [];
    expect(alternates).not.toContainEqual({ language: 'und', text: '助手' });
    expect(alternates).toContainEqual({ language: 'fr', text: 'La Red' });
    expect(alternates).toContainEqual({ language: 'en', text: 'Chris Makise' });

    const apiFirst = await run(parsedCharacterTables());
    expect(apiFirst.plan.entities.bangumi.find((record) => record.key === 'character:1')?.payload).toEqual(
      officialCharacter,
    );
    const apiCharacterId = idOf(apiFirst.result.readings.find((row) => row.externalId === 'character:1')!);
    expect(apiCharacterId).toBeTruthy();
    await publish(apiFirst);
    const apiPublic = (await publicClient.readSubject(apiCharacterId!)).subject as {
      id: string;
      type: string;
      statements: Record<string, BatchStatement[]>;
    };
    expect(apiPublic).toMatchObject({ id: apiCharacterId, type: 'wd:Q95074' });
    expect(apiPublic.statements['schema:name']?.map(valueContent)).toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'ルルーシュ・ランペルージ' },
        { language: 'zh-Hans', text: '鲁路修·兰佩路基' },
      ]),
    );
    expect(apiPublic.statements['schema:alternateName']?.map(valueContent)).toEqual(
      expect.arrayContaining([
        { language: 'en', text: 'Lelouch Lamperouge' },
        { language: 'zh', text: '鲁路修·冯·布里塔尼亚' },
        { language: 'ja', text: 'ルルーシュ・ヴィ・ブリタニア' },
      ]),
    );
    expect(apiPublic.statements['schema:alternateName']?.map(valueContent)).not.toEqual(
      expect.arrayContaining([
        { language: 'und', text: 'L.L.' },
        { language: 'en', text: 'Lelouch Vie Britannia' },
      ]),
    );
    const sealedDigests = capturedApiNameCommands().map(({ command, commandDigest }) => [command.key, commandDigest]);
    expect(sealedDigests).toHaveLength(5);
    journal.close();
    journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
    const apiReplay = await run(parsedCharacterTables());
    expect(apiReplay.result.runs.bangumi?.counts.unchanged).toBeGreaterThan(0);
    expect(idOf(apiReplay.result.readings.find((row) => row.externalId === 'character:1')!)).toBe(apiCharacterId);
    expect(capturedApiNameCommands().map(({ command, commandDigest }) => [command.key, commandDigest])).toEqual(
      sealedDigests,
    );
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

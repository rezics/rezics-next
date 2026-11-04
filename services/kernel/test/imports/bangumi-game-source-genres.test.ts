import { expect, test } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { converter_revision as entityRevision } from '../../../../packages/conversion/src/cross-media-entities.ts';
import {
  bangumiGameSourceGenreScheme,
} from '../../../../packages/conversion/src/bangumi-game-source-genres.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import { parseBangumiGameGenreBindings } from '../../../importer/src/showcase-bangumi-game-genres.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

// Authored fixture values model the pinned Game template; they are not observations from a real source dump.
const globalContext = '00000000-0000-8000-8000-000000000000';
const gameKey = '104';
const genreLiteral = '视觉小说,冒险/探索';
const schemeSourceUri = bangumiGameSourceGenreScheme;
const genreSourceUri = 'https://example.test/bangumi/genre/visual-novel-adventure';
const infobox = `{{Infobox Game\n|游戏类型=${genreLiteral}\n|游玩人数=1-4人\n}}`;

function tables(): CrossMediaTables {
  return {
    async *rows(provider, table) {
      if (provider === 'bangumi' && table === 'subject') {
        yield { id: 101, name: 'STEINS;GATE', type: 2 };
        yield { id: 102, name: 'CLANNAD', type: 2 };
        yield { id: 103, name: 'Fate/stay night', type: 2 };
        yield { id: 104, name: 'Authored Game', type: 4, infobox };
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
      if (provider === 'vndb' && table === 'entry_meta')
        for (const id of ['v1', 'v2', 'v3']) yield { id, revision: '1', lastmod: '2026-11-01 00:00:00+00' };
    },
  };
}

test('selected Game genre binding is reviewed and adopted separately, read publicly, and recovered after an unavailable binding without changing its UUID or sealed intent', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'bangumi-game-source-genres-'));
  const importPath = join(directory, 'import.sqlite');
  const showcasePath = join(directory, 'showcase.sqlite');
  const origin = 'https://kernel.import.test';
  let journal = new ShowcaseJournal(showcasePath);
  let intentDb: Database | undefined;
  const editor = await openApiObserver(runtime);
  const publicClient = createPublicBulkClient({
    origin,
    fetch: (async (input) => {
      const url = new URL(String(input));
      return runtime.request(`${url.pathname}${url.search}`);
    }) as typeof fetch,
  });

  async function createNative(type: 'skos:ConceptScheme' | 'skos:Concept', key: string) {
    const result = await runtime.importTransport.batch({
      commands: [
        {
          op: 'create',
          key: `authored-game-genre-create-${key}`,
          source: {
            source: 'authored-game-genre-vocabulary',
            external_id: key,
            record_revision: 'authored-1',
            digest: 'a'.repeat(64),
            converter_revision: 'authored-game-genre-fixture@1',
            field_group: 'facts',
          },
          subject: { type, labels: { en: `Authored ${key}` } },
        },
      ],
    });
    const row = result.results[0];
    if (!row || row.status !== 201 || !('value' in row) || !('id' in row.value))
      throw new Error(`Missing authored ${type}`);
    return row.value.id;
  }

  async function proposeNative(id: string, key: string, property: string, value: string) {
    const result = await runtime.importTransport.batch({
      commands: [
        {
          op: 'propose',
          key: `authored-game-genre-propose-${key}`,
          source: {
            source: 'authored-game-genre-vocabulary',
            external_id: key,
            record_revision: 'authored-1',
            digest: 'b'.repeat(64),
            converter_revision: 'authored-game-genre-fixture@1',
            field_group: 'facts',
          },
          subject: id,
          statement: {
            property: { id: property },
            value: { type: 'value', content: value },
            references: [
              {
                parts: [
                  {
                    property: { id: 'schema:url' },
                    value: { type: 'value', content: `https://example.test/authored/${key}` },
                  },
                ],
              },
            ],
          },
        },
      ],
    });
    expect(result.results[0]?.status).toBe(201);
  }

  async function acceptAndAdopt(id: string, key: string, property: string, value: string) {
    const listing = await runtime.importTransport.reviewedCandidates(id, {
      property,
      target: value,
      context: globalContext,
      limit: 100,
    });
    const candidate = listing.candidates.find(
      (item) => 'statement' in item && item.statement.value.type === 'value' && item.statement.value.content === value,
    );
    if (!candidate || !('statement' in candidate)) throw new Error(`Missing authored ${property} candidate`);
    const accepted = await runtime.importTransport.acceptReviewedCandidate(
      id,
      candidate.id,
      { context: globalContext, expected_head: candidate.head ?? null },
      `authored-game-genre-accept-${key}`,
    );
    expect(accepted.acceptance.candidate).toBe(candidate.id);
    await runtime.importTransport.adoptReviewedCandidates(
      id,
      {
        context: globalContext,
        property,
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: candidate.id, rank: 'normal' }],
      },
      `authored-game-genre-adopt-${key}`,
    );
  }

  try {
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: globalContext },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);

    const schemeId = await createNative('skos:ConceptScheme', 'genre-scheme');
    const conceptId = await createNative('skos:Concept', 'visual-novel-adventure');
    await proposeNative(schemeId, 'genre-scheme-url', 'schema:url', schemeSourceUri);
    await proposeNative(conceptId, 'genre-concept-url', 'schema:url', genreSourceUri);
    await proposeNative(conceptId, 'genre-concept-scheme', 'skos:inScheme', schemeId);
    await acceptAndAdopt(schemeId, 'genre-scheme-url', 'schema:url', schemeSourceUri);
    await acceptAndAdopt(conceptId, 'genre-concept-url', 'schema:url', genreSourceUri);
    await acceptAndAdopt(conceptId, 'genre-concept-scheme', 'skos:inScheme', schemeId);

    const profile = parseBangumiGameGenreBindings({
      schemeId,
      schemeUri: schemeSourceUri,
      concepts: [{ literal: genreLiteral, id: conceptId, sourceUri: genreSourceUri }],
    });
    let unavailableConceptReads = 1;
    const port = {
      ...runtime.importTransport,
      async readReviewedSubject(id: string, signal?: AbortSignal) {
        if (id === conceptId && unavailableConceptReads > 0) {
          unavailableConceptReads--;
          throw new TypeError('temporary authored Concept read outage');
        }
        return runtime.importTransport.readReviewedSubject(id, signal);
      },
    };

    async function importSelected() {
      const plan = await planCrossMediaSeed(tables());
      expect(plan.records.bangumi.some((row) => row.key === gameKey)).toBe(true);
      const result = await seedCrossMedia(
        plan,
        importPath,
        captureShowcaseCommands(port, journal),
        { origin },
        {
          providers: ['bangumi'],
          bangumiGenrePort: port,
          bangumiGameGenreBindings: profile,
        },
      );
      const reading = result.readings.find((row) => row.source === 'bangumi' && row.externalId === gameKey);
      const id = (reading?.subject as { subject?: { id?: string } } | undefined)?.subject?.id;
      if (!id) throw new Error('Selected Bangumi Game has no acknowledged native UUID');
      return { plan, result, id };
    }

    const first = await importSelected();
    expect(first.result.bangumiGameGenrePublication?.diagnostics).toContainEqual({
      sourceKey: gameKey,
      path: '/infobox/游戏类型/0',
      code: 'binding-unavailable',
    });
    expect(first.result.bangumiGameGenrePublication?.candidateIds).toEqual([]);
    const createBefore = journal
      .acknowledgedCommands()
      .find(({ command }) => command.op === 'create' && command.source.external_id === gameKey);
    if (!createBefore) throw new Error('Game creation was not acknowledged');
    const firstPublication = await publishShowcase({
      plan: first.plan,
      result: first.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(firstPublication.manifest.records.find((row) => row.sourceKey === gameKey)?.subjectId).toBe(first.id);
    expect(firstPublication.manifest.records.find((row) => row.sourceKey === gameKey)?.assertions).not.toContainEqual(
      expect.objectContaining({ property: 'schema:genre' }),
    );
    const firstPublicRead = (await publicClient.readSubject(first.id)) as {
      subject?: { statements?: Record<string, unknown[]> };
    };
    expect(firstPublicRead.subject?.statements?.['schema:numberOfPlayers']).toBeDefined();
    intentDb = new Database(showcasePath, { strict: true });
    const originalIntent = intentDb
      .query<{ intent_json: string }, [string]>('SELECT intent_json FROM showcase_intent WHERE intent_digest=?')
      .get(firstPublication.manifest.digest)?.intent_json;
    expect(originalIntent).toBeDefined();

    const corrected = await importSelected();
    expect(corrected.id).toBe(first.id);
    const createAfter = journal
      .acknowledgedCommands()
      .find(({ command }) => command.op === 'create' && command.source.external_id === gameKey);
    expect(createAfter?.commandDigest).toBe(createBefore.commandDigest);
    expect(createAfter?.command.key).toBe(createBefore.command.key);
    expect(corrected.result.bangumiGameGenrePublication?.candidateIds).toHaveLength(1);
    const originalGenreCandidateId = corrected.result.bangumiGameGenrePublication!.candidateIds[0]!;

    unavailableConceptReads = 1;
    const outage = await importSelected();
    expect(outage.id).toBe(first.id);
    expect(outage.result.bangumiGameGenrePublication?.diagnostics).toContainEqual({
      sourceKey: gameKey,
      path: '/infobox/游戏类型/0',
      code: 'binding-unavailable',
    });
    expect(outage.result.bangumiGameGenrePublication?.candidateIds).toEqual([]);
    const retained = await runtime.importTransport.reviewedCandidates(outage.id, {
      property: 'schema:genre',
      target: conceptId,
      context: globalContext,
      limit: 100,
    });
    expect(retained.candidates.map((row) => row.id)).toContain(originalGenreCandidateId);
    expect(
      journal
        .acknowledgedCommands()
        .filter(({ command }) => command.op === 'propose' && command.statement.property.id === 'schema:genre'),
    ).toHaveLength(1);
    const unavailablePublicRead = await publicClient.readSubject(outage.id);
    expect(
      (unavailablePublicRead as { subject?: { statements?: Record<string, unknown[]> } }).subject?.statements?.[
        'schema:genre'
      ],
    ).toBeUndefined();
    expect(
      (unavailablePublicRead as { subject?: { statements?: Record<string, unknown[]> } }).subject?.statements?.[
        'schema:numberOfPlayers'
      ],
    ).toBeDefined();

    const recovered = await importSelected();
    expect(recovered.id).toBe(first.id);
    expect(recovered.result.bangumiGameGenrePublication?.candidateIds).toContain(originalGenreCandidateId);
    const listing = await runtime.importTransport.reviewedCandidates(recovered.id, {
      property: 'schema:genre',
      target: conceptId,
      context: globalContext,
      limit: 100,
    });
    const genreCandidate = listing.candidates.find(
      (candidate) =>
        'statement' in candidate &&
        candidate.source !== null &&
        'external_id' in candidate.source &&
        candidate.source.external_id === gameKey,
    );
    if (!genreCandidate || !('statement' in genreCandidate)) throw new Error('Current genre candidate is missing');
    expect(genreCandidate.id).toBe(originalGenreCandidateId);
    expect(genreCandidate.statement.property.id).toBe('schema:genre');
    expect(genreCandidate.statement.value).toEqual({ type: 'value', content: conceptId });
    expect(JSON.stringify(genreCandidate.statement.references)).toContain('https://bgm.tv/subject/104');
    expect(genreCandidate.source).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: gameKey,
      converter_revision: entityRevision,
    });

    const accepted = await runtime.importTransport.acceptReviewedCandidate(
      recovered.id,
      genreCandidate.id,
      { context: globalContext, expected_head: genreCandidate.head ?? null },
      'local-game-genre-review',
    );
    expect(accepted.acceptance.candidate).toBe(genreCandidate.id);
    const adopted = await runtime.importTransport.adoptReviewedCandidates(
      recovered.id,
      {
        context: globalContext,
        property: 'schema:genre',
        mode: 'replace',
        expected_head: listing.adoption?.head ?? null,
        selection: [{ candidate: genreCandidate.id, rank: 'normal' }],
      },
      'local-game-genre-adoption',
    );
    expect(adopted.adoption.selection?.map((row) => row.candidate)).toContain(genreCandidate.id);
    const current = await publicClient.readSubject(recovered.id);
    const publicGenre = (current as { subject?: { statements?: Record<string, { value?: { content?: unknown }; references?: unknown }[]> } })
      .subject?.statements?.['schema:genre']?.find((row) => row.value?.content === conceptId);
    expect(publicGenre).toBeDefined();
    expect(publicGenre?.references).toContainEqual(genreCandidate.statement.references![0]);

    const finalPublication = await publishShowcase({
      plan: recovered.plan,
      result: recovered.result,
      aliases: crossMediaAliases,
      journal,
      review: runtime.importTransport,
      publicClient,
    });
    expect(finalPublication.published.find((row) => row.sourceKey === gameKey)?.assertions).toContainEqual(
      expect.objectContaining({ property: 'schema:genre', candidateId: genreCandidate.id }),
    );
    expect(
      intentDb
        .query<{ intent_json: string }, [string]>('SELECT intent_json FROM showcase_intent WHERE intent_digest=?')
        .get(firstPublication.manifest.digest)?.intent_json,
    ).toBe(originalIntent);
    expect(intentDb.query('SELECT intent_digest FROM showcase_intent').all()).toHaveLength(2);
  } finally {
    intentDb?.close();
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 600_000);

import { expect, test } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
import { developmentShowcaseSelection } from '../../../../scripts/datasets/cross-media-seed.ts';
import { createPublicBulkClient } from '../../../importer/src/public-bulk-client.ts';
import {
  crossMediaAliases,
  planCrossMediaSeed,
  seedCrossMedia,
  type CrossMediaPort,
  type CrossMediaTables,
} from '../../../importer/src/cross-media-seed.ts';
import { acquireBangumiCoverSources } from '../../../importer/src/showcase-media.ts';
import {
  captureShowcaseCommands,
  publishShowcase,
  ShowcaseJournal,
} from '../../../importer/src/showcase-publication.ts';
import { GLOBAL_CONTEXT } from '../../src/semantic/definitions.ts';
import { openApiObserver } from './api-observer.ts';
import { openApiRuntime } from './api-runtime.ts';

const sourceUrl = 'https://lain.bgm.tv/pic/cover/l/12/34/native-10380.png';
const characterSourceUrl = 'https://lain.bgm.tv/pic/crt/l/46/52/11546_crt_FlzuU.jpg';

test('default finite Bangumi selection imports a direct Character image through native review and fencing', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-media-native-'));
  const statePath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const mediaIds = new Map<string, string>();
  const requestBodies = new Map<string, string>();
  const requestKeys = new Map<string, string>();
  const characterAttempts: { body: string; key: string; mediaId: string }[] = [];
  let mediaRequests = 0;
  let statusReads = 0;
  let loseCharacterResponse = true;
  const batchCalls: string[][] = [];
  const signal = new AbortController().signal;
  const tables: CrossMediaTables = {
    async *rows(provider, table) {
      if (provider !== 'bangumi') return;
      if (table === 'subject') {
        yield { id: 10380, name: 'STEINS;GATE', name_cn: '命运石之门', type: 2 };
        yield { id: 84148, name: 'STEINS;GATE', name_cn: '命运石之门', type: 1 };
        yield { id: 51, name: 'CLANNAD -クラナド-', name_cn: 'CLANNAD', type: 2 };
      }
      if (table === 'subject-characters')
        yield { subject_id: 10380, character_id: 11546, type: 1, order: 0 };
      if (table === 'character') yield { id: 11546, name: 'アルパカ', type: 1 };
    },
  };
  try {
    const rawPlan = await planCrossMediaSeed(tables, { selection: developmentShowcaseSelection });
    expect(
      rawPlan.members
        .filter((member) => member.source === 'bangumi' && member.kind === 'work' && member.membership === 'family')
        .map((member) => member.key)
        .sort(),
    ).toEqual(developmentShowcaseSelection.bangumi.map(String).sort());
    expect(rawPlan.characterAppearances).toHaveLength(1);
    expect(rawPlan.characterAppearances![0]).toMatchObject({ subjectId: '10380', characterId: 11546 });
    const bytes = new Uint8Array(
      await sharp({ create: { width: 40, height: 56, channels: 3, background: '#176aa0' } })
        .png()
        .toBuffer(),
    );
    await runtime.mediaBoundary.source(sourceUrl, undefined, bytes);
    await runtime.mediaBoundary.source(characterSourceUrl, undefined, bytes);
    const apiReads: string[] = [];
    const sourceFetch: typeof fetch = async (input) => {
      const endpoint = String(input);
      apiReads.push(endpoint);
      if (endpoint === 'https://api.bgm.tv/v0/characters/11546')
        return new Response(
          JSON.stringify({
            id: 11546,
            name: 'アルパカ',
            type: 1,
            images: {
              large: characterSourceUrl,
              medium: 'https://lain.bgm.tv/r/400/pic/crt/l/46/52/11546_crt_FlzuU.jpg',
              small: 'https://lain.bgm.tv/r/100/pic/crt/l/46/52/11546_crt_FlzuU.jpg',
              grid: 'https://lain.bgm.tv/pic/crt/g/46/52/11546_crt_FlzuU.jpg',
            },
          }),
          { status: 200, headers: { etag: '"native-character-11546"' } },
        );
      const subjectId = Number(endpoint.slice('https://api.bgm.tv/v0/subjects/'.length));
      const row = rawPlan.records.bangumi.find((candidate) => candidate.key === String(subjectId))!;
      const images =
        subjectId === 10380
          ? { large: sourceUrl, common: sourceUrl, medium: sourceUrl, small: sourceUrl, grid: sourceUrl }
          : null;
      return new Response(
        JSON.stringify({ id: subjectId, type: row.payload.type, name: row.payload.name, images }),
        { status: 200, headers: { etag: `"native-subject-${subjectId}"` } },
      );
    };
    const sourcePlan = await acquireBangumiCoverSources(rawPlan, {
      journal,
      sleep: async () => {},
      fetch: sourceFetch,
    });
    expect(apiReads).toContain('https://api.bgm.tv/v0/characters/11546');
    expect(sourcePlan.coverSources?.find((source) => source.externalId === 'character:11546')).toMatchObject({
      endpoint: 'https://api.bgm.tv/v0/characters/11546',
      sourceStatus: 'available',
      sourceUrl: characterSourceUrl,
    });
    const batch = runtime.importTransport.batch.bind(runtime.importTransport);
    const mediaPort = {
      ...runtime.importTransport,
      async batch(request: BatchWriteRequest, requestSignal?: AbortSignal) {
        batchCalls.push(request.commands.map((command: BatchCommand) => command.key));
        return batch(request, requestSignal);
      },
      async requestMedia(body: string, key: string, requestSignal?: AbortSignal) {
        mediaRequests += 1;
        const receipt = await runtime.importTransport.requestMedia(body, key, requestSignal);
        const request = JSON.parse(body) as { provenance: { external_id: string } };
        mediaIds.set(request.provenance.external_id, receipt.body.media.id);
        requestBodies.set(request.provenance.external_id, body);
        requestKeys.set(request.provenance.external_id, key);
        if (request.provenance.external_id === 'character:11546') {
          characterAttempts.push({ body, key, mediaId: receipt.body.media.id });
          if (loseCharacterResponse) {
            loseCharacterResponse = false;
            throw new Error('simulated lost media import response');
          }
        }
        return receipt;
      },
      async mediaStatus(id: string, requestSignal?: AbortSignal) {
        statusReads += 1;
        return runtime.importTransport.mediaStatus(id, requestSignal);
      },
    } as unknown as CrossMediaPort;
    const firstPort = captureShowcaseCommands(mediaPort, journal);
    await expect(
      seedCrossMedia(sourcePlan, statePath, firstPort, { origin: runtime.origin }, { providers: ['bangumi'], mediaDeadlineMs: 0 }),
    ).rejects.toThrow('simulated lost media import response');
    expect(mediaRequests).toBe(2);
    const characterId = mediaIds.get('character:11546')!;
    const characterRequest = JSON.parse(requestBodies.get('character:11546')!) as {
      sourceUrl: string;
      credit: { rightsHolder: string; via: { name: string; url: string }; license: string };
      provenance: { source: string; external_id: string; field_group: string };
    };
    expect(characterRequest).toMatchObject({
      sourceUrl: characterSourceUrl,
      credit: {
        rightsHolder: '(c) rights holder',
        via: { name: 'Bangumi', url: 'https://bgm.tv/character/11546' },
        license: 'LicenseRef-unknown',
      },
      provenance: {
        source: crossMediaAliases.bangumi,
        external_id: 'character:11546',
        field_group: 'cover',
      },
    });
    const originalCharacterBody = requestBodies.get('character:11546');
    const originalCharacterKey = requestKeys.get('character:11546');
    expect(statusReads).toBe(0);

    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const recoveredPlan = await acquireBangumiCoverSources(rawPlan, { journal, fetch: sourceFetch, sleep: async () => {} });
    const recovered = await seedCrossMedia(
      recoveredPlan,
      statePath,
      captureShowcaseCommands(mediaPort, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'], mediaDeadlineMs: 0 },
    );
    expect(recovered.mediaOutcomes.find((outcome) => outcome.externalId === '10380')?.status).toBe('pending');
    expect(recovered.mediaOutcomes.find((outcome) => outcome.externalId === 'character:11546')?.status).toBe('pending');
    expect(characterAttempts).toHaveLength(2);
    expect(characterAttempts[1]).toEqual({
      body: originalCharacterBody,
      key: originalCharacterKey,
      mediaId: characterId,
    });
    expect(mediaRequests).toBe(3);
    expect(statusReads).toBe(1);

    await runtime.mediaBoundary.drain({ mediaIds: [...mediaIds.values()], maxJobs: 16, signal });
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const resumedPlan = await acquireBangumiCoverSources(rawPlan, { journal, fetch: sourceFetch, sleep: async () => {} });
    const resumed = await seedCrossMedia(
      resumedPlan,
      statePath,
      captureShowcaseCommands(mediaPort, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'], mediaDeadlineMs: 0 },
    );
    const workOutcome = resumed.mediaOutcomes.find((outcome) => outcome.externalId === '10380')!;
    const characterOutcome = resumed.mediaOutcomes.find((outcome) => outcome.externalId === 'character:11546')!;
    expect(workOutcome).toMatchObject({ status: 'available', sourceUrl, mediaId: mediaIds.get('10380') });
    expect(characterOutcome).toMatchObject({
      status: 'available',
      sourceUrl: characterSourceUrl,
      mediaId: characterId,
      containerId: expect.any(String),
    });
    expect(mediaRequests).toBe(3);
    expect(statusReads).toBe(3);
    expect(requestBodies.get('character:11546')).toBe(originalCharacterBody);
    expect(requestKeys.get('character:11546')).toBe(originalCharacterKey);
    const workSubjectId = workOutcome.containerId!;
    const characterSubjectId = characterOutcome.containerId!;
    const storedMedia = new Map<string, Awaited<ReturnType<typeof runtime.mediaBoundary.observe>>>();
    for (const [externalId, id] of mediaIds) {
      const stored = await runtime.mediaBoundary.observe(id);
      expect(stored.row.id).toBe(id);
      expect(stored.variants.length).toBeGreaterThan(0);
      storedMedia.set(externalId, stored);
    }

    const editor = await openApiObserver(runtime);
    const grant = await editor.http('/v1/grants', {
      resource: { route: 0, id: GLOBAL_CONTEXT },
      subject: { kind: 'account', id: runtime.identity.bulk.accountId },
      actions: ['context:accept', 'context:adopt'],
      valid: '(,)',
    });
    expect(grant.status).toBe(201);
    const publicClient = createPublicBulkClient({
      origin: runtime.origin,
      fetch: async (input) => {
        const url = new URL(String(input));
        return runtime.request(`${url.pathname}${url.search}`);
      },
    });
    const publication = await publishShowcase({
      plan: resumedPlan,
      result: resumed,
      aliases: crossMediaAliases,
      journal,
      review: mediaPort,
      publicClient,
    });
    expect(publication.status).toBe('published');
    const workMediaRecord = publication.manifest.media.find((record) => record.sourceKey === '10380')!;
    const characterMediaRecord = publication.manifest.media.find(
      (record) => record.sourceKey === 'character:11546',
    )!;
    expect(workMediaRecord).toMatchObject({
      status: 'available',
      mediaId: mediaIds.get('10380'),
      containerId: workSubjectId,
      readHandoff: { subjectId: workSubjectId, property: 'schema:image', value: mediaIds.get('10380') },
    });
    expect(characterMediaRecord).toMatchObject({
      status: 'available',
      mediaId: characterId,
      containerId: characterSubjectId,
      readHandoff: { subjectId: characterSubjectId, property: 'schema:image', value: characterId },
    });
    expect(workMediaRecord.candidateId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(characterMediaRecord.candidateId).toMatch(/^[0-9a-f-]{36}$/iu);
    expect(publication.published.find((record) => record.subjectId === characterSubjectId)?.assertions).toContainEqual(
      expect.objectContaining({ property: 'schema:image', candidateId: characterMediaRecord.candidateId }),
    );
    const imagePage = await runtime.importTransport.reviewedCandidates(characterSubjectId, {
      property: 'schema:image',
      context: GLOBAL_CONTEXT,
      limit: 100,
    });
    expect(imagePage.adoption?.selection?.some((item) => item.candidate === characterMediaRecord.candidateId)).toBe(
      true,
    );
    for (const [subjectId, externalId] of [
      [workSubjectId, '10380'],
      [characterSubjectId, 'character:11546'],
    ] as const) {
      const publicRead = await publicClient.readSubject(subjectId);
      const statements = (publicRead.subject as { statements: Record<string, { value: { content: unknown } }[]> })
        .statements;
      expect(statements['schema:image']?.some((row) => row.value.content === mediaIds.get(externalId))).toBe(true);
      expect((publicRead as { summary?: { cover?: unknown } }).summary?.cover).toBeTruthy();
      if (externalId === 'character:11546')
        expect(JSON.stringify(statements['schema:name'])).toContain('アルパカ');
      if (subjectId === workSubjectId)
        expect(statements['schema:character']?.some((row) => row.value.content === characterSubjectId)).toBe(true);
      const variant = storedMedia.get(externalId)!.variants[0]!;
      expect(
        (
          await runtime.request(
            `/v1/media/${mediaIds.get(externalId)}:authorizeDownload?variant=${variant.format}-${variant.width}`,
          )
        ).status,
      ).toBe(200);
    }

    const takedown = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId: 'character:11546',
      fieldGroup: 'cover',
      reason: 'Cover rights complaint',
    });
    expect(takedown.status).toBe(200);
    const suppressed = await publicClient.readSubject(characterSubjectId);
    expect((suppressed as { summary?: { cover?: unknown } }).summary?.cover).toBeNull();
    expect(
      (
        await runtime.request(
          `/v1/media/${characterId}:authorizeDownload?variant=${storedMedia.get('character:11546')!.variants[0]!.format}-${storedMedia.get('character:11546')!.variants[0]!.width}`,
        )
      )
        .status,
    ).toBe(404);

    batchCalls.length = 0;
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const fencedPlan = await acquireBangumiCoverSources(rawPlan, { journal, fetch: sourceFetch, sleep: async () => {} });
    const unchanged = await seedCrossMedia(
      fencedPlan,
      statePath,
      captureShowcaseCommands(mediaPort, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'], mediaDeadlineMs: 0 },
    );
    expect(unchanged.mediaOutcomes.find((outcome) => outcome.externalId === 'character:11546')?.status).toBe(
      'fenced',
    );
    expect(batchCalls).toEqual([]);
    expect(mediaRequests).toBe(3);
    expect(statusReads).toBe(3);
    const replay = await publishShowcase({
      plan: fencedPlan,
      result: unchanged,
      aliases: crossMediaAliases,
      journal,
      review: mediaPort,
      publicClient,
    });
    expect(
      replay.manifest.media.find((record) => record.sourceKey === 'character:11546'),
    ).toMatchObject({ status: 'fenced', gap: 'cover-fenced' });
    expect(replay.manifest.media.find((record) => record.sourceKey === 'character:11546')?.mediaId).toBeUndefined();
    expect(replay.manifest.media.find((record) => record.sourceKey === '10380')?.status).toBe('available');
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
}, 30_000);

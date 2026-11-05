import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import type { BatchCommand, BatchWriteRequest } from '@rezics/definitions/bulk';
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

const sourceUrl = 'https://lain.bgm.tv/pic/cover/l/12/34/native-101.png';
const personImageUrl = 'https://lain.bgm.tv/pic/crt/l/native-29.png';
const organizationImageUrl = 'https://lain.bgm.tv/pic/crt/l/native-27.png';

test('synthetic selected Person and Organization images use the common authorized media and publication path', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-media-native-'));
  const statePath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  const mediaIds = new Map<string, string>();
  let mediaRequests = 0;
  let statusReads = 0;
  const batchCalls: string[][] = [];
  const signal = new AbortController().signal;
  try {
    const tables: CrossMediaTables = {
      async *rows(provider, table) {
        if (provider === 'bangumi' && table === 'subject') yield { id: 101, name: 'STEINS;GATE', type: 2 };
      },
    };
    const rawPlan = await planCrossMediaSeed(tables);
    // Synthetic detail derivative: the selected source keys are real finite-closure observations,
    // while this native fixture does not claim to reproduce their upstream selection.
    rawPlan.entities.bangumi.push(
      {
        source: 'bangumi',
        key: 'person:29',
        revision: null,
        payload: { id: 29, type: 1, name: '鶴岡陽太', career: [{ name: 'retained career' }] },
      },
      {
        source: 'bangumi',
        key: 'person:27',
        revision: null,
        payload: { id: 27, type: 2, name: 'TBS', career: [{ name: 'retained career' }] },
      },
    );
    rawPlan.creatorImageKeys = ['person:29', 'person:27'];
    rawPlan.members.push(
      { source: 'bangumi', key: 'person:29', kind: 'person', membership: 'family' },
      { source: 'bangumi', key: 'person:27', kind: 'organization', membership: 'family' },
    );
    const bytes = new Uint8Array(
      await sharp({ create: { width: 40, height: 56, channels: 3, background: '#176aa0' } })
        .png()
        .toBuffer(),
    );
    await runtime.mediaBoundary.source(sourceUrl, undefined, bytes);
    await runtime.mediaBoundary.source(personImageUrl, undefined, bytes);
    await runtime.mediaBoundary.source(organizationImageUrl, undefined, bytes);
    const sourcePlan = await acquireBangumiCoverSources(rawPlan, {
      journal,
      sleep: async () => {},
      fetch: async (input) => {
        const url = new URL(String(input));
        if (url.pathname.startsWith('/v0/persons/')) {
          const id = Number(url.pathname.split('/').at(-1));
          const creator = id === 29
            ? { name: '鶴岡陽太', type: 1, image: personImageUrl }
            : { name: 'TBS', type: 2, image: organizationImageUrl };
          return new Response(
            JSON.stringify({
              id,
              type: creator.type,
              name: creator.name,
              career: [{ name: 'retained career' }],
              images: { large: creator.image, medium: creator.image, small: creator.image, grid: creator.image },
            }),
            { status: 200, headers: { etag: `"native-person-${id}"`, 'content-type': 'application/json' } },
          );
        }
        return new Response(
          JSON.stringify({
            id: 101,
            type: 2,
            name: 'STEINS;GATE',
            images: { large: sourceUrl, common: sourceUrl, medium: sourceUrl, small: sourceUrl, grid: sourceUrl },
          }),
          { status: 200, headers: { etag: '"native-subject-101"', 'content-type': 'application/json' } },
        );
      },
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
        return receipt;
      },
      async mediaStatus(id: string, requestSignal?: AbortSignal) {
        statusReads += 1;
        return runtime.importTransport.mediaStatus(id, requestSignal);
      },
    } as unknown as CrossMediaPort;
    const firstPort = captureShowcaseCommands(mediaPort, journal);
    const initial = await seedCrossMedia(
      sourcePlan,
      statePath,
      firstPort,
      { origin: runtime.origin },
      {
        providers: ['bangumi'],
        mediaDeadlineMs: 0,
      },
    );
    expect(initial.mediaOutcomes.map((outcome) => [outcome.externalId, outcome.status])).toEqual([
      ['101', 'pending'],
      ['person:29', 'pending'],
      ['person:27', 'pending'],
    ]);
    expect(mediaRequests).toBe(3);
    expect(statusReads).toBe(0);
    const initialSubjects = new Map(initial.mediaOutcomes.map((outcome) => [outcome.externalId, outcome.containerId]));

    await runtime.mediaBoundary.drain({ mediaIds: [...mediaIds.values()], maxJobs: 16, signal });
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const resumed = await seedCrossMedia(
      sourcePlan,
      statePath,
      captureShowcaseCommands(mediaPort, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'], mediaDeadlineMs: 0 },
    );
    const outcomes = new Map(resumed.mediaOutcomes.map((outcome) => [outcome.externalId, outcome]));
    expect(outcomes.get('101')).toMatchObject({ status: 'available', sourceUrl, mediaId: mediaIds.get('101') });
    expect(outcomes.get('person:29')).toMatchObject({
      status: 'available',
      sourceUrl: personImageUrl,
      mediaId: mediaIds.get('person:29'),
    });
    expect(outcomes.get('person:27')).toMatchObject({
      status: 'available',
      sourceUrl: organizationImageUrl,
      mediaId: mediaIds.get('person:27'),
    });
    for (const [key, outcome] of outcomes) expect(outcome.containerId).toBe(initialSubjects.get(key));
    expect(mediaRequests).toBe(3);
    expect(statusReads).toBe(3);
    const subjects = new Map([...outcomes].map(([key, outcome]) => [key, outcome.containerId!]));
    const storedMedia = new Map<string, Awaited<ReturnType<typeof runtime.mediaBoundary.observe>>>();
    for (const [key, outcome] of outcomes) {
      const stored = await runtime.mediaBoundary.observe(outcome.mediaId!);
      expect(stored.variants.length).toBeGreaterThan(0);
      storedMedia.set(key, stored);
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
      plan: sourcePlan,
      result: resumed,
      aliases: crossMediaAliases,
      journal,
      review: mediaPort,
      publicClient,
    });
    expect(publication.status).toBe('published');
    const mediaRecords = new Map(publication.manifest.media.map((record) => [record.sourceKey, record]));
    for (const key of ['101', 'person:29', 'person:27']) {
      const mediaRecord = mediaRecords.get(key)!;
      const mediaId = mediaIds.get(key)!;
      const subjectId = subjects.get(key)!;
      expect(mediaRecord).toMatchObject({
        status: 'available',
        mediaId,
        containerId: subjectId,
        readHandoff: { subjectId, property: 'schema:image', value: mediaId },
      });
      expect(mediaRecord.candidateId).toMatch(/^[0-9a-f-]{36}$/iu);
      expect(publication.published.find((record) => record.subjectId === subjectId)?.assertions).toContainEqual(
        expect.objectContaining({ property: 'schema:image', candidateId: mediaRecord.candidateId }),
      );
      const imagePage = await runtime.importTransport.reviewedCandidates(subjectId, {
        property: 'schema:image',
        context: GLOBAL_CONTEXT,
        limit: 100,
      });
      expect(imagePage.adoption?.selection?.some((item) => item.candidate === mediaRecord.candidateId)).toBe(true);
      const publicRead = await publicClient.readSubject(subjectId);
      const statements = (publicRead.subject as { statements: Record<string, { value: { content: unknown } }[]> })
        .statements;
      expect(statements['schema:image']?.some((row) => row.value.content === mediaId)).toBe(true);
      expect((publicRead as { summary?: { cover?: unknown } }).summary?.cover).toBeTruthy();
      const variant = storedMedia.get(key)!.variants[0]!;
      expect(
        (await runtime.request(`/v1/media/${mediaId}:authorizeDownload?variant=${variant.format}-${variant.width}`))
          .status,
      ).toBe(200);
    }
    const organizationRead = await publicClient.readSubject(subjects.get('person:27')!);
    const organizationStatements = (organizationRead.subject as {
      statements: Record<string, unknown[]>;
    }).statements;
    expect(organizationStatements['wdt:P6298']).toBeUndefined();

    const takedown = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId: 'person:29',
      fieldGroup: 'cover',
      reason: 'Cover rights complaint',
    });
    expect(takedown.status).toBe(200);
    const personSubjectId = subjects.get('person:29')!;
    const personMediaId = mediaIds.get('person:29')!;
    const personVariant = storedMedia.get('person:29')!.variants[0]!;
    const suppressed = await publicClient.readSubject(personSubjectId);
    expect((suppressed as { summary?: { cover?: unknown } }).summary?.cover).toBeNull();
    expect(
      (await runtime.request(
        `/v1/media/${personMediaId}:authorizeDownload?variant=${personVariant.format}-${personVariant.width}`,
      ))
        .status,
    ).toBe(404);

    batchCalls.length = 0;
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const unchanged = await seedCrossMedia(
      sourcePlan,
      statePath,
      captureShowcaseCommands(mediaPort, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'], mediaDeadlineMs: 0 },
    );
    expect(unchanged.mediaOutcomes.find((outcome) => outcome.externalId === 'person:29')?.status).toBe('fenced');
    expect(unchanged.mediaOutcomes.find((outcome) => outcome.externalId === '101')?.status).toBe('available');
    expect(unchanged.mediaOutcomes.find((outcome) => outcome.externalId === 'person:27')?.status).toBe('available');
    expect(batchCalls).toEqual([]);
    expect(mediaRequests).toBe(3);
    expect(statusReads).toBe(3);
    const replay = await publishShowcase({
      plan: sourcePlan,
      result: unchanged,
      aliases: crossMediaAliases,
      journal,
      review: mediaPort,
      publicClient,
    });
    expect(replay.manifest.media.find((record) => record.sourceKey === 'person:29')).toMatchObject({
      status: 'fenced',
      gap: 'cover-fenced',
    });
    expect(replay.manifest.media.find((record) => record.sourceKey === 'person:29')?.mediaId).toBeUndefined();
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

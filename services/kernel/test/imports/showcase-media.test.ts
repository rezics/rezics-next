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

test('default selected cover reaches authorized media work, exact publication and current fenced public reads', async () => {
  const runtime = await openApiRuntime({ batchRecords: 8, maxFields: 64, maxRecordBytes: 65_536 });
  const directory = await mkdtemp(join(tmpdir(), 'showcase-media-native-'));
  const statePath = join(directory, 'import.sqlite');
  const journalPath = join(directory, 'showcase.sqlite');
  let journal = new ShowcaseJournal(journalPath);
  let mediaId: string | undefined;
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
    const bytes = new Uint8Array(
      await sharp({ create: { width: 40, height: 56, channels: 3, background: '#176aa0' } })
        .png()
        .toBuffer(),
    );
    await runtime.mediaBoundary.source(sourceUrl, undefined, bytes);
    const sourcePlan = await acquireBangumiCoverSources(rawPlan, {
      journal,
      sleep: async () => {},
      fetch: async () =>
        new Response(
          JSON.stringify({
            id: 101,
            type: 2,
            name: 'STEINS;GATE',
            images: { large: sourceUrl, common: sourceUrl, medium: sourceUrl, small: sourceUrl, grid: sourceUrl },
          }),
          { status: 200, headers: { etag: '"native-subject-101"', 'content-type': 'application/json' } },
        ),
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
        mediaId = receipt.body.media.id;
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
    expect(initial.mediaOutcomes[0]?.status).toBe('pending');
    expect(mediaRequests).toBe(1);
    expect(statusReads).toBe(0);

    await runtime.mediaBoundary.drain({ mediaIds: [mediaId!], maxJobs: 16, signal });
    journal.close();
    journal = new ShowcaseJournal(journalPath);
    const resumed = await seedCrossMedia(
      sourcePlan,
      statePath,
      captureShowcaseCommands(mediaPort, journal),
      { origin: runtime.origin },
      { providers: ['bangumi'], mediaDeadlineMs: 0 },
    );
    const outcome = resumed.mediaOutcomes[0]!;
    expect(outcome).toMatchObject({ status: 'available', sourceUrl, mediaId });
    expect(mediaRequests).toBe(1);
    expect(statusReads).toBe(1);
    const subjectId = outcome.containerId!;
    const stored = await runtime.mediaBoundary.observe(mediaId!);
    expect(stored.row.id).toBe(mediaId);
    expect(stored.variants.length).toBeGreaterThan(0);

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
    const mediaRecord = publication.manifest.media[0]!;
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
    const cover = (publicRead as { summary?: { cover?: unknown } }).summary?.cover;
    expect(cover).toBeTruthy();
    const variant = stored.variants[0]!;
    expect(
      (await runtime.request(`/v1/media/${mediaId}:authorizeDownload?variant=${variant.format}-${variant.width}`))
        .status,
    ).toBe(200);

    const takedown = await editor.http('/v1/sourceFences:takedown', {
      source: crossMediaAliases.bangumi,
      externalId: '101',
      fieldGroup: 'cover',
      reason: 'Cover rights complaint',
    });
    expect(takedown.status).toBe(200);
    const suppressed = await publicClient.readSubject(subjectId);
    expect((suppressed as { summary?: { cover?: unknown } }).summary?.cover).toBeNull();
    expect(
      (await runtime.request(`/v1/media/${mediaId}:authorizeDownload?variant=${variant.format}-${variant.width}`))
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
    expect(unchanged.mediaOutcomes[0]?.status).toBe('fenced');
    expect(batchCalls).toEqual([]);
    expect(mediaRequests).toBe(1);
    expect(statusReads).toBe(1);
    const replay = await publishShowcase({
      plan: sourcePlan,
      result: unchanged,
      aliases: crossMediaAliases,
      journal,
      review: mediaPort,
      publicClient,
    });
    expect(replay.manifest.media[0]).toMatchObject({ status: 'fenced', gap: 'cover-fenced' });
    expect(replay.manifest.media[0]?.mediaId).toBeUndefined();
  } finally {
    journal.close();
    await runtime.close();
    await rm(directory, { recursive: true, force: true });
  }
});

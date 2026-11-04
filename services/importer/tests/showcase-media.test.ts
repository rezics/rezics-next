import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { MediaImportRequest, MediaImportStatus } from '@rezics/definitions/media-import';
import {
  crossMediaAliases,
  emptyCrossMediaPlan,
  seedCrossMedia,
  type CrossMediaPlan,
  type CrossMediaPort,
} from '../src/cross-media-seed.ts';
import { acquireBangumiCoverSources } from '../src/showcase-media.ts';
import { ImportTransportError } from '../src/import-client.ts';
import { captureShowcaseCommands, ShowcaseJournal } from '../src/showcase-publication.ts';

const sourceUrl = 'https://lain.bgm.tv/pic/cover/l/12/34/101.jpg';
const apiSubject = {
  id: 101,
  type: 2,
  name: 'STEINS;GATE',
  images: {
    large: sourceUrl,
    common: sourceUrl,
    medium: sourceUrl,
    small: sourceUrl,
    grid: sourceUrl,
  },
};

function selectedPlan(): CrossMediaPlan {
  const plan = emptyCrossMediaPlan();
  plan.records.bangumi.push({
    source: 'bangumi',
    key: '101',
    revision: null,
    payload: { id: 101, type: 2, name: 'STEINS;GATE' },
  });
  plan.members.push({ source: 'bangumi', key: '101', kind: 'work', membership: 'family', franchise: 'steins-gate' });
  plan.franchises['steins-gate'].bangumi.push('101');
  return plan;
}

test('default selected Bangumi media intent resumes its journalled reservation to actual availability', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-media-'));
  const sourcePlan = selectedPlan();
  const statePath = join(directory, 'import.sqlite');
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const subjectId = randomUUID();
  const mediaId = randomUUID();
  let sourceReads = 0;
  let reservations = 0;
  let statusReads = 0;
  let terminal: 'reserved' | 'available' = 'reserved';
  let sealedBody = '';
  let sealedKey = '';
  let mediaRequest: MediaImportRequest | undefined;
  let refusal: ImportTransportError | undefined = new ImportTransportError(
    503,
    undefined,
    'dependency_unavailable',
    true,
  );
  try {
    const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
      expect(String(input)).toBe('https://api.bgm.tv/v0/subjects/101');
      expect(init?.method).toBe('GET');
      expect(init?.redirect).toBe('error');
      expect(init?.credentials).toBe('omit');
      expect(new Headers(init?.headers).get('authorization')).toBeNull();
      sourceReads += 1;
      return new Response(JSON.stringify(apiSubject), {
        status: 200,
        headers: { etag: '"subject-101-v1"', 'content-type': 'application/json' },
      });
    }) as typeof globalThis.fetch;
    const firstPlan = await acquireBangumiCoverSources(sourcePlan, { journal, fetch, sleep: async () => {} });
    const resumedPlan = await acquireBangumiCoverSources(sourcePlan, { journal, fetch, sleep: async () => {} });
    expect(firstPlan.records.bangumi[0]!.payload).toMatchObject({ images: { large: sourceUrl } });
    expect(resumedPlan.coverSources).toEqual(firstPlan.coverSources);
    expect(sourceReads).toBe(1);

    const fake = {
      async batch(request: {
        commands: readonly {
          key: string;
          op: string;
          source: { external_id: string };
          subject?: { type: string; labels: Record<string, string> };
        }[];
      }) {
        return {
          results: request.commands.map((command) => {
            if (command.op === 'create')
              return { key: command.key, status: 201 as const, value: { id: subjectId, revision: 1 } };
            if (command.op === 'propose')
              return { key: command.key, status: 201 as const, value: { candidate: randomUUID(), revision: 1 } };
            return { key: command.key, status: 200 as const, value: { revision: 1 } };
          }),
        };
      },
      async setSourceRecordMetadata(input: { command: { metadata: unknown } }) {
        return { effect: 'filled', metadata_revision: 1, record: input.command.metadata };
      },
      async fence() {
        return { fenced: false, securityRevision: null };
      },
      async writeSourceStatistic() {},
      async clearSourceStatistic() {},
      async readReviewedSubject(id: string) {
        return { subject: { id, type: 'wd:Q20631656', labels: { en: 'STEINS;GATE' }, statements: {} } };
      },
      async requestMedia(bytes: string, key: string) {
        sealedBody = bytes;
        sealedKey = key;
        mediaRequest = JSON.parse(bytes) as MediaImportRequest;
        if (refusal) throw refusal;
        reservations += 1;
        return {
          status: 202,
          body: { media: { id: mediaId, containerId: subjectId, purpose: 'cover', state: 'reserved' } },
        };
      },
      async mediaStatus(id: string) {
        statusReads += 1;
        expect(id).toBe(mediaId);
        const request = mediaRequest!;
        const media: MediaImportStatus['media'] =
          terminal === 'available'
            ? {
                id,
                containerId: subjectId,
                purpose: 'cover',
                state: 'available',
                byteCount: 32,
                mediaType: 'image/png',
                sha256: 'a'.repeat(64),
                credit: request.credit,
                provenance: request.provenance,
              }
            : {
                id,
                containerId: subjectId,
                purpose: 'cover',
                state: 'reserved',
                byteCount: null,
                mediaType: null,
                sha256: null,
                credit: request.credit,
                provenance: request.provenance,
              };
        const body: MediaImportStatus = { media };
        return { status: 200, body };
      },
    } as unknown as CrossMediaPort;
    const port = captureShowcaseCommands(fake, journal);
    const run = () =>
      seedCrossMedia(
        firstPlan,
        statePath,
        port,
        { origin: 'https://fixture.test' },
        {
          providers: ['bangumi'],
          mediaDeadlineMs: 0,
        },
      );
    const unavailable = await run();
    expect(unavailable.mediaOutcomes[0]).toMatchObject({ status: 'pending', containerId: subjectId });
    expect(unavailable.mediaOutcomes[0]?.mediaId).toBeUndefined();
    expect(reservations).toBe(0);
    expect(statusReads).toBe(0);
    refusal = new ImportTransportError(403, undefined, 'forbidden');
    await expect(run()).rejects.toThrow('Cross-media bangumi import failed');
    refusal = new ImportTransportError(429, undefined, 'rate_limited', true);
    expect((await run()).mediaOutcomes[0]).toMatchObject({ status: 'pending' });
    expect(reservations).toBe(0);
    refusal = undefined;
    const initial = await seedCrossMedia(
      firstPlan,
      statePath,
      port,
      { origin: 'https://fixture.test' },
      {
        providers: ['bangumi'],
        mediaDeadlineMs: 0,
      },
    );
    expect(initial.mediaOutcomes[0]).toMatchObject({ status: 'pending', containerId: subjectId, sourceUrl });
    expect(mediaRequest).toMatchObject({ containerId: subjectId, sourceUrl });
    expect(mediaRequest!.provenance).toMatchObject({
      source: crossMediaAliases.bangumi,
      external_id: '101',
      record_revision: 'unversioned',
      field_group: 'cover',
    });
    expect(statusReads).toBe(1);

    terminal = 'available';
    const resumed = await seedCrossMedia(
      resumedPlan,
      statePath,
      port,
      { origin: 'https://fixture.test' },
      {
        providers: ['bangumi'],
        mediaDeadlineMs: 0,
      },
    );
    expect(resumed.mediaOutcomes[0]).toMatchObject({ status: 'available', containerId: subjectId, mediaId });
    expect(reservations).toBe(1);
    expect(statusReads).toBe(2);
    expect(sealedBody).toBe(JSON.stringify(mediaRequest));
    expect(sealedKey).toBeTruthy();
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

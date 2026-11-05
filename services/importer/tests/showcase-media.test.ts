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
    expect(sourceReads).toBe(2);

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
        reservations += 1;
        sealedBody = bytes;
        sealedKey = key;
        mediaRequest = JSON.parse(bytes) as MediaImportRequest;
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
}, 15_000);

test('direct selected Character images use CharacterDetail evidence and preserve changed receipts', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-character-media-'));
  const plan = selectedPlan();
  const journal = new ShowcaseJournal(join(directory, 'showcase.sqlite'));
  const firstImage = 'https://lain.bgm.tv/pic/crt/l/46/52/11546_crt_FlzuU.jpg';
  const changedImage = `${firstImage}?r=2`;
  let characterReads = 0;
  plan.entities.bangumi.push(
    {
      source: 'bangumi',
      key: 'character:11546',
      revision: null,
      payload: { id: 11546, name: 'アルパカ', type: 1 },
    },
    {
      source: 'bangumi',
      key: 'character:99999',
      revision: null,
      payload: { id: 99999, name: 'unselected', type: 1, images: { large: 'https://lain.bgm.tv/unselected.jpg' } },
    },
  );
  plan.characterAppearances = [{ subjectId: '101', characterId: 11546, sourceIndex: 0, roleCode: 1 }];
  try {
    const fetch = (async (input: RequestInfo | URL) => {
      const endpoint = String(input);
      if (endpoint === 'https://api.bgm.tv/v0/subjects/101')
        return new Response(JSON.stringify(apiSubject), { status: 200, headers: { etag: '"subject-101"' } });
      expect(endpoint).toBe('https://api.bgm.tv/v0/characters/11546');
      characterReads += 1;
      const image = characterReads === 1 ? firstImage : changedImage;
      const images =
        characterReads < 3
          ? { large: image, medium: image, small: image, grid: image }
          : { large: image, medium: image, small: image };
      return new Response(
        JSON.stringify({ id: 11546, name: 'アルパカ', type: 1, images }),
        { status: 200, headers: { etag: `"character-11546-${characterReads}"` } },
      );
    }) as typeof globalThis.fetch;
    const first = await acquireBangumiCoverSources(plan, { journal, fetch, sleep: async () => {} });
    const firstReceipt = first.coverSources!.find((source) => source.externalId === 'character:11546')!;
    expect(firstReceipt).toMatchObject({
      endpoint: 'https://api.bgm.tv/v0/characters/11546',
      sourceStatus: 'available',
      sourceUrl: firstImage,
    });
    expect(first.entities.bangumi.find((row) => row.key === 'character:11546')?.payload).toMatchObject({
      images: { large: firstImage },
    });
    expect(first.entities.bangumi.find((row) => row.key === 'character:99999')?.payload).not.toHaveProperty('images');

    const changed = await acquireBangumiCoverSources(plan, { journal, fetch, sleep: async () => {} });
    const changedReceipt = changed.coverSources!.find((source) => source.externalId === 'character:11546')!;
    expect(changedReceipt).toMatchObject({ sourceStatus: 'available', sourceUrl: changedImage });
    expect(journal.sealCoverSource(firstReceipt)).toEqual(firstReceipt);

    const malformed = await acquireBangumiCoverSources(plan, { journal, fetch, sleep: async () => {} });
    const malformedReceipt = malformed.coverSources!.find((source) => source.externalId === 'character:11546')!;
    expect(malformedReceipt).toMatchObject({
      endpoint: 'https://api.bgm.tv/v0/characters/11546',
      sourceStatus: 'unavailable',
      code: 'source-payload-invalid',
      responseDigest: expect.stringMatching(/^[0-9a-f]{64}$/u),
    });
    expect(malformed.entities.bangumi.find((row) => row.key === 'character:11546')?.payload).not.toHaveProperty(
      'images',
    );
    expect(journal.coverSource('bangumi_cross_media', 'character:11546', firstReceipt.archiveDigest)).toEqual(
      malformedReceipt,
    );
    expect(journal.sealCoverSource(changedReceipt)).toEqual(changedReceipt);
    expect(characterReads).toBe(3);
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

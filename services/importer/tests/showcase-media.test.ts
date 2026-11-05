import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Database } from 'bun:sqlite';
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
import type { ShowcaseManifest } from '../src/showcase-manifest.ts';
import { createSelectedFamilySourceRegistration } from '../src/source-registry.ts';

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
    expect(unavailable.mediaOutcomes[0]).toMatchObject({ status: 'unavailable', containerId: subjectId });
    expect(unavailable.runs.bangumi?.status).toBe('committed');
    expect(unavailable.mediaOutcomes[0]?.mediaId).toBeUndefined();
    expect(reservations).toBe(0);
    expect(statusReads).toBe(0);
    refusal = new ImportTransportError(403, undefined, 'forbidden');
    await expect(run()).rejects.toThrow('Cross-media bangumi import failed');
    refusal = new ImportTransportError(429, undefined, 'rate_limited', true);
    expect((await run()).mediaOutcomes[0]).toMatchObject({ status: 'unavailable' });
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
}, { timeout: 15_000 });

test('selected creator details distinguish source states and refresh without changing identities', async () => {
  const directory = await mkdtemp(join(tmpdir(), 'showcase-creator-media-'));
  const journalPath = join(directory, 'showcase.sqlite');
  const journal = new ShowcaseJournal(journalPath);
  const plan = emptyCrossMediaPlan();
  const rows = [
    ['person:29', 1, '鶴岡陽太'],
    ['person:27', 2, 'TBS'],
    ['person:30', 1, 'Absent image'],
    ['person:31', 1, 'Invalid image'],
    ['person:32', 1, 'Type mismatch'],
    ['person:33', 1, 'Unavailable detail'],
  ] as const;
  for (const [key, type, name] of rows)
    plan.entities.bangumi.push({
      source: 'bangumi',
      key,
      revision: null,
      payload: { id: Number(key.slice('person:'.length)), type, name, career: [{ name: 'retained' }] },
    });
  plan.creatorImageKeys = rows.map(([key]) => key);
  const initialUrl = (id: number) => `https://lain.bgm.tv/pic/crt/l/${id}.jpg`;
  const changedUrl = 'https://lain.bgm.tv/pic/crt/l/29-v2.jpg';
  let version = 1;
  let sourceReads = 0;
  const fetch = (async (input: RequestInfo | URL, init?: RequestInit) => {
    const url = new URL(String(input));
    const id = Number(url.pathname.split('/').at(-1));
    expect(url.origin).toBe('https://api.bgm.tv');
    expect(url.pathname).toBe(`/v0/persons/${id}`);
    expect(init?.method).toBe('GET');
    expect(init?.redirect).toBe('error');
    expect(init?.credentials).toBe('omit');
    expect(new Headers(init?.headers).get('authorization')).toBeNull();
    sourceReads += 1;
    if (id === 33) return new Response('unavailable', { status: 503 });
    const type = id === 32 ? 2 : id === 27 ? 2 : 1;
    const image = id === 29 && version === 2 ? changedUrl : initialUrl(id);
    const images =
      id === 30
        ? null
        : {
            large: id === 31 ? 'https://untrusted.example/person.jpg' : image,
            medium: image,
            small: image,
            grid: image,
          };
    return new Response(JSON.stringify({ id, type, name: `creator-${id}`, images }), {
      status: 200,
      headers: { etag: `"creator-${id}-v${version}"`, 'content-type': 'application/json' },
    });
  }) as typeof globalThis.fetch;
  const asManifest = (
    digest: string,
    sources: NonNullable<CrossMediaPlan['creatorImageSources']>,
    statusOverrides: Record<string, string> = {},
  ): ShowcaseManifest =>
    ({
      version: 1,
      digest,
      records: [],
      vocabulary: [],
      media: sources.map((source) => ({
        sourceAlias: source.sourceAlias,
        sourceKey: source.externalId,
        sourceUri: source.endpoint,
        sourceRevision: source.sourceRevision,
        archiveDigest: source.archiveDigest,
        ...(source.responseDigest ? { responseDigest: source.responseDigest } : {}),
        ...(source.sourceUrl ? { sourceUrl: source.sourceUrl } : {}),
        status: (statusOverrides[source.externalId] ?? source.sourceStatus) as ShowcaseManifest['media'][number]['status'],
        containerId: null,
      })),
      tagWeightObservations: [],
      tagWeightRefreshes: [],
      omissions: [],
    }) as ShowcaseManifest;
  try {
    const first = await acquireBangumiCoverSources(plan, { journal, fetch, sleep: async () => {} });
    const byKey = new Map(first.creatorImageSources?.map((source) => [source.externalId, source]));
    expect(Object.fromEntries([...byKey].map(([key, source]) => [key, source.sourceStatus]))).toEqual({
      'person:29': 'available',
      'person:27': 'available',
      'person:30': 'absent',
      'person:31': 'invalid',
      'person:32': 'invalid',
      'person:33': 'unavailable',
    });
    expect(first.entities.bangumi.find((row) => row.key === 'person:29')?.payload).toMatchObject({
      images: { large: initialUrl(29) },
      career: [{ name: 'retained' }],
    });
    expect(first.entities.bangumi.find((row) => row.key === 'person:31')?.payload).not.toHaveProperty('images');

    const registration = createSelectedFamilySourceRegistration('bangumi', crossMediaAliases.bangumi);
    for (const [key, nativeType] of [['person:29', 'schema:Person'], ['person:27', 'schema:Organization']] as const) {
      const row = first.entities.bangumi.find((candidate) => candidate.key === key)!;
      const image = key === 'person:29' ? initialUrl(29) : initialUrl(27);
      const converted = registration.convert(
        { external_id: key, record_revision: 'unversioned', record: row.payload },
        { source: crossMediaAliases.bangumi, subjectId: randomUUID(), mediaIds: { [image]: randomUUID() } },
      );
      const properties = converted.proposals
        .filter((command) => command.op === 'propose')
        .map((command) => command.statement.property.id);
      expect(properties).toContain('schema:image');
      expect(properties.includes('wdt:P6298')).toBe(nativeType === 'schema:Person');
      expect(converted.mediaImportIntents?.[0]?.credit).toMatchObject({
        rightsHolder: '(c) rights holder',
        via: { name: 'Bangumi', url: `https://bgm.tv/person/${key.slice('person:'.length)}` },
        license: 'LicenseRef-unknown',
      });
    }

    journal.sealIntent(asManifest('a'.repeat(64), first.creatorImageSources!));
    const firstPerson = byKey.get('person:29')!;
    version = 2;
    const refreshed = await acquireBangumiCoverSources(plan, { journal, fetch, sleep: async () => {} });
    const refreshedPerson = refreshed.creatorImageSources!.find((source) => source.externalId === 'person:29')!;
    expect(refreshedPerson).toMatchObject({ sourceUrl: changedUrl, archiveDigest: firstPerson.archiveDigest });
    expect(refreshedPerson.responseDigest).not.toBe(firstPerson.responseDigest);
    expect(sourceReads).toBe(20);

    journal.sealIntent(
      asManifest('b'.repeat(64), refreshed.creatorImageSources!, {
        'person:29': 'unknown',
        'person:27': 'pending',
        'person:30': 'pending',
        'person:31': 'pending',
        'person:32': 'pending',
        'person:33': 'pending',
      }),
    );
    expect(journal.latestMediaStatus(crossMediaAliases.bangumi, 'person:29')).toBe('unknown');
    const resumed = await acquireBangumiCoverSources(plan, {
      journal,
      sleep: async () => {},
      fetch: (async (input: RequestInfo | URL) => {
        expect(new URL(String(input)).pathname).toBe('/v0/persons/33');
        sourceReads += 1;
        return new Response('unavailable', { status: 503 });
      }) as typeof globalThis.fetch,
    });
    expect(resumed.creatorImageSources!.find((source) => source.externalId === 'person:29')).toEqual(refreshedPerson);
    expect(sourceReads).toBe(25);

    const database = new Database(journalPath);
    try {
      const count = database
        .query<{ count: number }, []>(
          "SELECT COUNT(*) AS count FROM showcase_cover_source WHERE external_id='person:29'",
        )
        .get()!.count;
      expect(count).toBe(2);
    } finally {
      database.close();
    }
  } finally {
    journal.close();
    await rm(directory, { recursive: true, force: true });
  }
});

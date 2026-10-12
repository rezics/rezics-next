import { afterAll, expect, spyOn, test } from 'bun:test';
import { createHash, randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { SourceIntakeStore } from '../../../services/main/src/modules/source/intake.ts';
import {
  mainSelectionDigest,
  selectMainDefault,
} from '../../../services/main/src/modules/work/select-main.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { requestUseRenditions } from '../../../services/main/src/modules/media-rendition/request.ts';
import type { DiscoveryRow } from '../../../services/main/src/modules/discovery/contract.ts';
import { startMediaStack, type MediaStack } from './media-support.ts';
import { requireQa } from './recommendation-support.ts';
import { cloneQaOwnerDatabases } from '../support/databases.ts';

const ID = 'https://rezics.com/id/';
const sha = (value: Uint8Array | string) => createHash('sha256').update(value).digest('hex');
let started: Promise<MediaStack> | undefined;
const stack = () =>
  (started ??= (async () => {
    const owners = await cloneQaOwnerDatabases(
      requireQa(),
      ['access', 'content', 'relay'],
      'privileged',
    );
    try {
      const fixture = await startMediaStack('source-cover-read', { ownerUrls: owners.urls });
      return {
        ...fixture,
        stop: async () => {
          try {
            await fixture.stop();
          } finally {
            await owners.close();
          }
        },
      };
    } catch (error) {
      await owners.close();
      throw error;
    }
  })());
afterAll(async () => {
  if (started) await (await started).stop();
});

async function json<T = Record<string, unknown>>(response: Response, expected = 200): Promise<T> {
  const body = await response.text();
  expect(response.status, body).toBe(expected);
  return JSON.parse(body) as T;
}

async function image() {
  const color = randomUUID().replaceAll('-', '');
  return sharp({
    create: {
      width: 320,
      height: 180,
      channels: 4,
      background: {
        r: Number.parseInt(color.slice(0, 2), 16),
        g: Number.parseInt(color.slice(2, 4), 16),
        b: Number.parseInt(color.slice(4, 6), 16),
        alpha: 1,
      },
    },
  })
    .png()
    .toBuffer();
}

async function importEvidence(f: MediaStack, principalId: string, work: string, bytes: Buffer) {
  const externalId = `subject-${randomUUID()}`;
  const source = {
    provider: 'bangumi',
    namespace: 'subject',
    externalId,
    sourceRevision: `snapshot-${randomUUID()}`,
    component: null as string | null,
    datasetSnapshotDigest: sha(`dataset:${externalId}`),
    recordDigest: sha(`record:${externalId}`),
    fieldLocator: '/images/common',
    displayName: 'Bangumi',
    href: `https://bgm.tv/subject/${externalId}`,
  };
  const image = {
    captureUrl: `https://lain.bgm.tv/pic/cover/${externalId}.png`,
    captureDigest: sha(bytes),
    byteLength: bytes.length,
    mediaType: 'image/png' as const,
  };
  const envelope = {
    profile: 'source-cover-evidence-v1',
    source,
    image,
    holderEvidence: { name: 'Evidence Holder', fieldLocator: '/rightsHolder' },
  };
  const raw = Buffer.from(JSON.stringify(envelope));
  const saved = await new SourceIntakeStore(f.contentPool).submit(
    principalId,
    `cover-evidence-${randomUUID()}`,
    {
      provider: source.provider,
      namespace: source.namespace,
      externalId,
      sourceRevision: source.sourceRevision,
      mediaType: 'application/json',
      retention: 'retained',
      rawBytesBase64: raw.toString('base64'),
      coverage: { scope: 'cover-evidence', complete: false, omittedFields: ['description'] },
      rightsEvidence: { basis: 'unknown', note: '' },
    },
  );
  return {
    importedCover: {
      format: 'media-imported-cover-v1',
      targetWork: work,
      source: {
        record: saved.observation.record,
        component: null,
        observation: saved.observation.observation,
        ...source,
        observationDigest: saved.observation.byteDigest,
      },
      image,
      originalDigest: sha(bytes),
      holderEvidence: envelope.holderEvidence,
    },
    expectedCredit: {
      kind: 'copyright',
      text: 'Evidence Holder',
      holder: 'Evidence Holder',
      source: { name: 'Bangumi', href: source.href },
      permittedRole: 'cover',
    },
  };
}

test('SOURCE-COVER-READ carries revision-pinned copyright credit through public cover descriptors', async () => {
  const f = await stack();
  const owner = await f.member('source-cover-read-owner');
  const phrase = `coverread${randomUUID().replaceAll('-', '')}`;
  const created = await f.catalogueWork(owner.actor, `${phrase} Work`);
  const source = await f.contribution(created.work, owner.actor, 'en', `${phrase} body CC BY-SA`);
  const input = {
    context: { kind: 'main-version-default' as const, id: created.mainVersion },
    work: created.work,
    contribution: source.contribution,
    publicationDecision: source.decision,
    expectedSelectionHead: null,
    selectionBasis: 'main-maintainer' as const,
    actingSubject: owner.actor,
  };
  const publication = await selectMainDefault(
    f.env,
    f.admission(
      owner.actor,
      `publication:select:${created.mainVersion}`,
      'publication.select',
      mainSelectionDigest(input),
    ),
    input,
  );
  expect(publication.outcome).toBe('succeeded');

  const bytes = await image();
  const evidence = await importEvidence(f, owner.principalId, created.work, bytes);
  const reserved = await json<{ asset: string; upload: string }>(
    await owner.send('POST', '/v1/media/uploads', {
      profile: 'media-image-upload-v1',
      asset: null,
      mediaType: 'image/png',
      byteLength: bytes.length,
      sha256: sha(bytes),
      disclosure: 'public',
      actingSubject: owner.actor,
      importedCover: evidence.importedCover,
    }),
    201,
  );
  const activated = await json<{ representation: string; revision: string }>(
    await f.call('PUT', `/v1/media/uploads/${reserved.upload}/bytes`, {
      token: owner.token,
      raw: bytes,
    }),
    201,
  );
  await owner.grant(`media:avatar:${created.work}`, 'media.avatar');
  const selected = await json<{ selection: string }>(
    await owner.send('PUT', `/v1/resources/${created.work.slice(ID.length)}/avatar`, {
      profile: 'resource-avatar-selection-v1',
      expectedSelection: null,
      asset: reserved.asset,
      actingSubject: owner.actor,
    }),
    201,
  );
  const expectedCredit = evidence.expectedCredit;

  const workRead = await json<{ revision: string; cover: { kind: string; selection?: string; use?: string; coverCredit?: unknown } }>(
    await f.call('GET', `/v1/works/${created.work.slice(ID.length)}`),
  );
  expect(workRead.cover).toMatchObject({ kind: 'image', coverCredit: expectedCredit });
  expect(workRead.cover.selection).toBe(selected.selection);
  const use = workRead.cover.use!;
  expect(use).toBeString();
  const retainedCover = await f.contentPool.query<{ use: string; asset: string; revision: string }>(
    `SELECT u.id::text AS use,u.asset_id::text AS asset,u.asset_revision_id::text AS revision
      FROM media.selection_revision s JOIN media.use u ON u.id=s.use_id WHERE s.id=$1`,
    [selected.selection],
  );
  expect(retainedCover.rows).toEqual([{ use, asset: reserved.asset, revision: activated.revision }]);

  const avatarReads = spyOn(f.store, 'avatarRows');
  try {
    const summary = await json<{
      summaries: Array<{ avatar: { kind: string; coverCredit?: unknown } }>;
      cost: { mediaQueries: number };
    }>(
      await f.call('POST', '/v1/resources/summaries', {
        body: {
          profile: 'resource-summary-batch-v1',
          resources: [created.work],
        },
      }),
    );
    expect(summary.summaries[0]?.avatar).toMatchObject({
      kind: 'image',
      coverCredit: expectedCredit,
    });
    // The public cost contract hides owner counters. Still prove that actual
    // avatar hydration is one bounded Media read instead of per-item reads.
    expect(summary.cost.mediaQueries).toBe(0);
    expect(avatarReads).toHaveBeenCalledTimes(1);
  } finally { avatarReads.mockRestore(); }

  const quick = await json<{
    items: Array<{ work: string; cover: { kind: string; coverCredit?: unknown } }>;
  }>(await f.call('GET', `/v1/search/typeahead?prefix=${encodeURIComponent(phrase)}`));
  expect(quick.items).toContainEqual(
    expect.objectContaining({
      work: created.work,
      cover: expect.objectContaining({ kind: 'image', coverCredit: expectedCredit }),
    }),
  );

  const search = await json<{
    results: Array<{ work: string; cover: { kind: string; coverCredit?: unknown } }>;
  }>(
    await f.call('POST', '/v1/queries/page', {
      body: {
        profile: 'public-main-title-body-page-v1',
        titleTerm: `${phrase} Work`,
        bodyTerm: `${phrase} body`,
        language: 'en',
        pageSize: 20,
      },
    }),
  );
  expect(search.results).toContainEqual(
    expect.objectContaining({
      work: created.work,
      cover: expect.objectContaining({ kind: 'image', coverCredit: expectedCredit }),
    }),
  );

  const projection = f.composition.dependencies.discovery!;
  const originalActive = projection.active;
  const originalPage = projection.page;
  const generation = randomUUID();
  const row: DiscoveryRow = {
    work: created.work,
    order_key: '1',
    payload: {
      revision: workRead.revision,
      mainVersion: created.mainVersion,
      types: [],
      primaryCredits: [],
      classifications: [],
      rating: null,
      classification: null,
    },
  };
  projection.active = async (_basis, position) =>
    ({
      generation_id: generation,
      stale: false,
      source_epoch: position.dataEpoch,
      source_sequence: position.sequence,
    }) as unknown as Awaited<ReturnType<typeof originalActive>>;
  projection.page = async () => [row];
  try {
    const discovery = await json<{
      items: Array<{ id: string; cover: { kind: string; coverCredit?: unknown } }>;
    }>(await f.call('GET', '/v1/works?limit=20'));
    expect(discovery.items).toContainEqual(
      expect.objectContaining({
        id: created.work,
        cover: expect.objectContaining({ kind: 'image', coverCredit: expectedCredit }),
      }),
    );
  } finally {
    projection.active = originalActive;
    projection.page = originalPage;
  }

  const originalMetadata = await json<{ items: Array<{ status: string; coverCredit?: unknown }> }>(
    await f.call('POST', '/v1/media/metadata', {
      body: { items: [{ representation: activated.representation, use }] },
    }),
  );
  expect(originalMetadata.items[0]).toMatchObject({
    status: 'available',
    coverCredit: expectedCredit,
  });
  const originalDescriptor = await json<{ coverCredit?: unknown }>(
    await f.call('GET', `/v1/media/representations/${activated.representation}?use=${use}`),
  );
  expect(originalDescriptor.coverCredit).toEqual(expectedCredit);

  await requestUseRenditions(f.store.renditions, f.objects, use);
  const worker = new MediaRenditionWorker(
    f.store.renditions,
    new LocalImageTransformer(),
    f.objects,
  );
  for (let step = 0; step < 8; step++) {
    if ((await f.store.renditions.candidatesBatch([use])).get(use)?.length) break;
    await worker.tick();
  }
  const thumbnail = (await f.store.renditions.candidatesBatch([use])).get(use)?.[0];
  expect(thumbnail).toBeDefined();
  const thumbnailUrl = new URL(thumbnail!.url, 'http://main.local');
  const renditionId = thumbnailUrl.pathname.match(/\/representations\/([0-9a-f-]+)/)?.[1];
  expect(renditionId).toBeDefined();
  const thumbnailDescriptor = await json<{ coverCredit?: unknown }>(
    await f.call('GET', `/v1/media/representations/${renditionId}?use=${use}`),
  );
  expect(thumbnailDescriptor.coverCredit).toEqual(expectedCredit);
}, 180_000);

import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { mkdirSync, rmSync } from 'node:fs';
import sharp from 'sharp';
import { startMediaStack, type MediaStack, sha } from './media-support.ts';
import { LocalImageTransformer } from '../../../services/main/src/modules/media-rendition/transform.ts';
import { MediaRenditionWorker } from '../../../services/main/src/modules/media-rendition/worker.ts';
import { discloseExportPlan } from '../../../services/main/src/modules/export/readers.ts';
import { planExport } from '../../../services/main/src/modules/export/planner.ts';
import { disclosureViewer } from '../../../services/main/src/modules/disclosure/viewer.ts';
import { ANONYMOUS_VIEWER } from '../../../services/main/src/modules/suitability/policy.ts';
import { LocalRequiredSafetyMatcher } from '../../../services/main/src/modules/media-screen/required-matcher.ts';
import { RequiredMediaMatchWorker } from '../../../services/main/src/modules/media-screen/required-match-worker.ts';

const ID = 'https://rezics.com/id/';
let started: Promise<MediaStack> | undefined;
let outageStack: Promise<MediaStack> | undefined;
const directory = `.temp/media-matcher-${randomUUID()}`;
const corpus = `${directory}/corpus.json`;
const stack = () => (started ??= startMediaStack('media-visibility'));
afterAll(async () => {
  if (started) await (await started).stop();
  if (outageStack) await (await outageStack).stop();
  rmSync(directory, { recursive: true, force: true });
});
async function status(response: Response, expected: number) {
  if (response.status !== expected)
    throw new Error(`expected ${expected}, got ${response.status}: ${await response.text()}`);
  return response;
}
async function image() {
  return new Uint8Array(
    await sharp({
      create: {
        width: 1280,
        height: 720,
        channels: 4,
        background: { r: 20, g: 50, b: 80, alpha: 0.5 },
      },
    })
      .png()
      .toBuffer(),
  );
}

test('private draft cover audience applies to bare originals, renditions, caches, showcase, summaries and export', async () => {
  const fixture = await stack();
  const { member, privateWork, publicWork, call, store, objects, contentPool, accessPool, main } =
    fixture;
  const author = await member('draft-cover-author');
  const outsider = await member('draft-cover-outsider');
  const draft = await privateWork(author.actor);
  await author.grant(`work:read:${draft.work}`, 'work.read');
  await author.grant(`media:avatar:${draft.work}`, 'media.avatar');
  const asset = await author.upload(await image());
  const path = `/v1/resources/${draft.work.slice(ID.length)}/showcase/art`;
  const selection = await (
    await status(
      await author.send('PUT', path, {
        profile: 'work-showcase-selection-v1',
        expectedSelection: null,
        asset: asset.asset,
        role: 'background-landscape',
        crop: 'xywh=percent:0,0,100,100',
        actingSubject: author.actor,
      }),
      201,
    )
  ).json();
  const worker = new MediaRenditionWorker(store.renditions, new LocalImageTransformer(), objects);
  const use = (
    await contentPool.query('SELECT use_id FROM media.selection_revision WHERE id=$1', [
      selection.selection,
    ])
  ).rows[0].use_id;
  for (
    let attempt = 0;
    attempt < 24 && !(await store.renditions.candidatesBatch([use])).get(use)?.length;
    attempt++
  )
    await worker.tick();
  const candidates = (await store.renditions.candidatesBatch([use])).get(use)!;
  expect(candidates.length).toBeGreaterThan(0);
  const rendition = candidates[0]!.url.split('/')[4]!;
  const raw = `/v1/media/representations/${asset.representation}/bytes`;
  const renditionRaw = `/v1/media/representations/${rendition}/bytes`;
  for (const url of [raw, `${raw}?use=${use}`, renditionRaw, candidates[0]!.url]) {
    await status(await call('GET', url), 404);
    await status(await outsider.read(url), 404);
    const allowed = await status(await author.read(url), 200);
    expect(allowed.headers.get('cache-control')).toBe('private, no-store');
    const etag = allowed.headers.get('etag')!;
    await status(
      await main.handle(
        new Request(`http://main.local${url}`, { headers: { 'if-none-match': etag } }),
      ),
      404,
    );
    await status(
      await main.handle(
        new Request(`http://main.local${url}`, {
          headers: {
            authorization: `Bearer ${outsider.token}`,
            'if-none-match': etag,
          },
        }),
      ),
      404,
    );
  }
  for (const reader of [undefined, outsider, author]) {
    const response = await status(
      await call('POST', '/v1/resources/showcase', {
        token: reader?.token,
        body: {
          profile: 'work-showcase-batch-v1',
          targets: [draft.work],
          ...(reader ? { actingSubject: reader.actor } : {}),
        },
      }),
      200,
    );
    const result = await response.json();
    expect(result.items[0].images?.length ?? 0).toBe(reader === author ? 1 : 0);
  }
  const grant = await outsider.grant(`work:read:${draft.work}`, 'work.read');
  expect((await status(await outsider.read(raw), 200)).headers.get('cache-control')).toBe(
    'private, no-store',
  );
  await accessPool.query(
    'UPDATE access.permission_grant SET active=false,generation=generation+1 WHERE id=$1',
    [grant],
  );
  await status(await outsider.read(raw), 404);
  // Even a second, public occurrence cannot widen this asset's private draft audience.
  const published = await publicWork(author.actor);
  await author.grant(`media:avatar:${published.work}`, 'media.avatar');
  await status(
    await author.send('PUT', `/v1/resources/${published.work.slice(ID.length)}/avatar`, {
      profile: 'resource-avatar-selection-v1',
      expectedSelection: null,
      asset: asset.asset,
      crop: null,
      actingSubject: author.actor,
    }),
    201,
  );
  const anonymousSummary = await (
    await status(await call('GET', `/v1/resources/${published.work.slice(ID.length)}`), 200)
  ).json();
  expect(anonymousSummary.avatar.kind).toBe('fallback');
  const authorSummary = await (
    await status(await author.read(`/v1/resources/${published.work.slice(ID.length)}`), 200)
  ).json();
  expect(authorSummary.avatar.kind).toBe('image');
  const plan = await planExport(
    {
      targetProfile: 'media-asset-v1',
      useScope: 'full',
      residuals: [],
      members: [
        {
          sourceOwner: 'object',
          sourceNamespace: 'media',
          sourceGrain: 'value',
          exactRef: `${ID}${asset.asset}`,
          contentRevisionId: null,
          refDigest: sha('cover'),
          ownerDataEpoch: fixture.env.lineage.dataEpoch,
          ownerSequence: '1',
          sourcePosition: null,
          targetGrain: 'Image',
          mapping: 'exact',
          data: { work: published.work, sha256: sha('cover') },
        },
      ],
    },
    async () => [],
  );
  const denied = await discloseExportPlan(fixture.env, plan, ANONYMOUS_VIEWER);
  expect(denied.members[0]!.data).toEqual({ omitted: 'disclosure_restricted' });
  const allowed = await discloseExportPlan(
    fixture.env,
    plan,
    disclosureViewer(author.principal, author.actor),
  );
  expect(allowed.members[0]!.data).toEqual(plan.members[0]!.data);
});

test('saved image NSFW correction uses the existing command, receipt and predecessor; stale and denied attempts have no effect', async () => {
  const { member, contentPool, call } = await stack();
  const author = await member('label-author');
  const denied = await member('label-denied');
  await author.grant(`media:owner:${author.actor}`, 'media.labels');
  const asset = await author.upload(await image());
  const read = async () =>
    await (
      await status(await author.read(`/v1/media/representations/${asset.representation}`), 200)
    ).json();
  const unlabelled = await read();
  const path = `/v1/media/representations/${asset.representation}/labels`;
  await status(
    await author.send('POST', path, {
      actingSubject: author.actor,
      field: 'nsfw',
      value: 'nsfw',
      mode: 'edit',
      expectedValueHead: unlabelled.controls.nsfw.valueHead,
      basis: unlabelled.controls.nsfw.basis,
    }),
    201,
  );
  const initial = await read();
  expect(initial.nsfw).toBe('nsfw');
  const command = {
    actingSubject: author.actor,
    field: 'nsfw',
    value: 'sfw',
    mode: 'edit',
    expectedValueHead: initial.controls.nsfw.valueHead,
    basis: initial.controls.nsfw.basis,
  };
  const key = `label-${randomUUID()}`;
  const corrected = await (await status(await author.send('POST', path, command, key), 201)).json();
  expect((await read()).nsfw).toBe('sfw');
  expect(
    (
      await (
        await status(await call('GET', `/v1/media/representations/${asset.representation}`), 200)
      ).json()
    ).nsfw,
  ).toBe('sfw');
  expect(corrected.revision).toBe((await read()).controls.nsfw.valueHead);
  await status(await author.send('POST', path, command, key), 200);
  await status(await author.send('POST', path, { ...command, value: 'nsfw' }), 409);
  const current = await read();
  await status(
    await denied.send('POST', path, {
      ...command,
      actingSubject: denied.actor,
      expectedValueHead: current.controls.nsfw.valueHead,
      basis: current.controls.nsfw.basis,
      value: 'nsfw',
    }),
    403,
  );
  expect((await read()).nsfw).toBe('sfw');
  const revisions = (
    await contentPool.query(
      `SELECT r.outcome FROM content.receipt r
    JOIN content.outbox o ON o.operation_id=r.operation_id WHERE r.action='media.field.change'
      AND o.payload->>'representation'=$1`,
      [asset.representation],
    )
  ).rows;
  expect(revisions.filter((row) => row.outcome === 'succeeded')).toHaveLength(2);
  expect(
    (
      await contentPool.query(`SELECT outcome FROM content.receipt WHERE action='media.field.change'
    AND outcome='stale_head'`)
    ).rowCount,
  ).toBeGreaterThan(0);
});

test('required matcher provider outage keeps uploads privately usable and pending; recovery after exhausted leases admits public delivery', async () => {
  mkdirSync(directory, { recursive: true });
  await Bun.write(corpus, '[]');
  const provider = new LocalRequiredSafetyMatcher(corpus);
  outageStack = startMediaStack('required-media-matcher', {
    requiredMatcher: provider,
    matchUploads: false,
  });
  const fixture = await outageStack;
  const { member, store, objects, call, contentPool } = fixture;
  const author = await member('matcher-author');
  const outsider = await member('matcher-outsider');
  rmSync(corpus);
  const asset = await author.upload(await image());
  const worker = new RequiredMediaMatchWorker(store.matching, provider, objects, 20, 40);
  await worker.tick(asset.representation);
  const pending = await store.readUpload(asset.upload);
  expect(pending?.clearance).toBe('screening');
  expect(pending?.clearanceReason).toBe('required-matcher-pending');
  const url = `/v1/media/representations/${asset.representation}/bytes`;
  await status(await call('GET', url), 404);
  await status(await outsider.read(url), 404);
  expect((await status(await author.read(url), 200)).headers.get('cache-control')).toBe(
    'private, no-store',
  );
  // Sixteen real failed corpus reads do not strand recovery permanently.
  for (let attempt = 1; attempt < 16; attempt++) {
    await Bun.sleep(45);
    await worker.tick(asset.representation);
  }
  await Bun.write(corpus, '[]');
  await Bun.sleep(45);
  await worker.tick(asset.representation);
  expect((await store.readUpload(asset.upload))?.clearance).toBe('cleared');
  expect((await status(await call('GET', url), 200)).headers.get('cache-control')).toBe(
    'public, no-cache',
  );
  expect(
    (
      await contentPool.query(
        `SELECT status FROM media.transform_job WHERE source_id=$1
    AND profile='required-image-match-v1' ORDER BY created_at`,
        [asset.representation],
      )
    ).rows.map((row) => row.status),
  ).toEqual(['cancelled', 'succeeded']);
  expect(
    (
      await contentPool.query('SELECT job_id FROM media.screen_result WHERE source_id=$1', [
        asset.representation,
      ])
    ).rowCount,
  ).toBe(0);
  const restored = await author.upload(await image());
  const obsolete = (await store.matching.leaseNext(40, restored.representation))!;
  const change = async (lifecycle: 'active' | 'deleted') => {
    const state = (await store.readAsset(restored.asset))!;
    await status(
      await author.send('POST', `/v1/media/assets/${restored.asset}/state`, {
        profile: 'media-asset-state-v1',
        expectedState: state.state,
        disclosure: 'public',
        lifecycle,
        actingSubject: author.actor,
      }),
      201,
    );
  };
  await change('deleted');
  await change('active');
  expect(await store.matching.settle(obsolete, 'clear')).toBe(false);
  const restoredUrl = `/v1/media/representations/${restored.representation}/bytes`;
  await status(await call('GET', restoredUrl), 404);
  await status(await author.read(restoredUrl), 200);
  await Bun.sleep(45);
  await worker.tick(restored.representation);
  await status(await call('GET', restoredUrl), 200);
});

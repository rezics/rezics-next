import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import sharp from 'sharp';
import { cloneQaOwnerDatabases } from '../../../tests/qa/support/databases.ts';
import { startMediaStack, sha, type MediaStack } from '../../../tests/qa/integration/media-support.ts';
import { ObjectNotFound } from '../src/infrastructure/immutable-objects.ts';
import { readErasure } from '../src/modules/erasure/journal.ts';
import { assetNamespace } from '../src/modules/media/store.ts';

test('production erasure composition inventories and deletes eligible private Media bytes', async () => {
  const started = performance.now();
  const runId = Bun.env.REZICS_QA_RUN_ID;
  if (!runId) throw new Error('Media composition requires the admitted isolated QA integration stack');
  const databases = await cloneQaOwnerDatabases(runId, ['access', 'content', 'relay'], 'owner');
  let stack: MediaStack | undefined;
  try {
    stack = await startMediaStack('erasure-media-composition', { ownerUrls: databases.urls });
    const owner = await stack.member('media-erasure-owner');
    const bytes = await sharp({ create: { width: 16, height: 16, channels: 3,
      background: { r: 40, g: 90, b: 150 } } }).png().toBuffer();
    const upload = await owner.upload(bytes, 'private');
    const resourceId = `https://rezics.com/id/${upload.asset}`;
    await owner.grant(`erasure:${resourceId}`, 'erasure.request');
    // Independent clients observe both retained namespaces. The erasure dependency
    // remains the one composeMain constructs, with no fixture factory injection.
    const assetObjects = stack.objects(assetNamespace(upload.asset));
    const quarantineObjects = stack.objects(`media-quarantine/${upload.upload}/`);
    const digest = sha(bytes);
    await assetObjects.probe(digest);
    await quarantineObjects.probe(digest);
    const siblingObjects = stack.objects(assetNamespace(randomUUID()));
    await siblingObjects.put(bytes);
    const preparationSeconds = (performance.now() - started) / 1000;
    console.log(`Media composition preparation: ${preparationSeconds.toFixed(2)}s`);
    expect(preparationSeconds).toBeLessThan(600);

    const key = randomUUID();
    const body = { profile: 'content-revision-erasure-v1', actingSubject: owner.actor,
      resourceId, revisionIds: [upload.revision] };
    const response = await owner.send('POST', '/v1/erasures', body, key);
    const answer = await response.json();
    console.log(`POST /v1/erasures ${response.status}: ${JSON.stringify(answer)}`);
    expect(response.status, JSON.stringify(answer)).toBe(200);
    expect(answer).toMatchObject({ profile: 'erasure-v1', suppression: 'suppressed',
      destruction: 'retained', verifiedAt: null, replayed: false });
    const targets = [
      { kind: 'content_revision', ref: upload.revision },
      { kind: 'object', ref: `media-asset:v1:${upload.asset}:sha256:${digest}` },
      { kind: 'object', ref: `media-quarantine:v1:${upload.upload}:sha256:${digest}` },
    ];
    for (const target of targets) expect(answer.targets).toContainEqual(expect.objectContaining({
      ...target, completionState: 'completed', completedAt: expect.any(String),
    }));
    await expect(assetObjects.probe(digest)).rejects.toBeInstanceOf(ObjectNotFound);
    await expect(quarantineObjects.probe(digest)).rejects.toBeInstanceOf(ObjectNotFound);
    expect(await siblingObjects.get(digest)).toEqual(new Uint8Array(bytes));

    const journal = await readErasure(stack.composition.erasureRelayPool!, answer.erasureId);
    expect(journal.targets.every(target => target.completionState === 'completed')).toBe(true);
    expect(journal.dispositions.length).toBeGreaterThan(0);
    expect(journal.verifiedAt).toBeNull();
    const read = await owner.send('GET', `/v1/erasures/${answer.erasureId}`);
    expect(read.status).toBe(200);
    expect(await read.json()).toMatchObject({ erasureId: answer.erasureId,
      erasureEpoch: answer.erasureEpoch, targets: answer.targets, destruction: 'retained', verifiedAt: null });
    const replay = await owner.send('POST', '/v1/erasures', body, key);
    expect(replay.status).toBe(200);
    expect(await replay.json()).toMatchObject({ erasureId: answer.erasureId,
      erasureEpoch: answer.erasureEpoch, replayed: true, targets: answer.targets });
  } finally {
    try { await stack?.stop(); }
    finally { await databases.close(); }
  }
}, 120_000);

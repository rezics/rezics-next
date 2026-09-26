import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('media-publication');
afterAll(async () => { if (started) await (await started).stop(); });

const ID = 'https://rezics.com/id/';

test('BOOK09: an image-only publication activates exact RustFS images without a fabricated text document', async () => {
  const { member, privateWork, contentPool, accessPool, content, fuseki, objects } = await stack();
  const author = await member('author');
  const reader = await member('reader');
  const work = await privateWork(author.actor, `Picture book ${randomUUID()}`);
  const first = png(320, 200);
  const second = png(200, 320);
  const pictures = [await author.upload(first, 'public'), await author.upload(second, 'public')];
  const secret = await author.upload(png(10, 10), 'private');
  const variantId = `urn:rezics:variant:${randomUUID()}`;
  const request = { profile: 'media-set-v1', resourceId: work.work, variantId, expectedHead: null,
    assets: pictures.map(picture => picture.asset), actingSubject: author.actor };

  // Authority: the ordinary Content draft grant governs the image-only body too.
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [`content:draft:${work.work}`]);
  const denied = await author.send('POST', '/v1/media/publications', request);
  expect(denied.status).toBe(403);
  expect((await contentPool.query("SELECT 1 FROM media.use WHERE target = $1", [work.work])).rowCount).toBe(0);
  await author.grant(`content:draft:${work.work}`, 'content.draft');
  expect((await author.send('POST', '/v1/media/publications', { ...request, assets: [] })).status).toBe(400);
  const hidden = await author.send('POST', '/v1/media/publications', { ...request, assets: [secret.asset] });
  expect(hidden.status).toBe(404);

  const key = `images-${randomUUID()}`;
  const saved = await author.send('POST', '/v1/media/publications', request, key);
  expect(saved.status).toBe(201);
  const body = await saved.json() as { revisionId: string; byteDigest: string;
    sourcePosition: { dataEpoch: string }; body: { profile: string; items: Array<{ use: string;
      asset: string; assetRevision: string; representation: string; sha256: string }> } };
  expect(body.body.profile).toBe('media-set-v1');
  expect(body.body.items.map(item => [item.asset, item.assetRevision, item.representation, item.sha256]))
    .toEqual(pictures.map((picture, index) => [`${ID}${picture.asset}`, picture.revision,
      picture.representation, sha([first, second][index]!)]));
  const replay = await author.send('POST', '/v1/media/publications', request, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ revisionId: body.revisionId, replayed: true });
  const uses = await contentPool.query<{ id: string; role: string; asset_revision_id: string }>(
    'SELECT id, role, asset_revision_id FROM media.use WHERE target = $1 ORDER BY id', [work.work]);
  expect(uses.rows.map(row => row.id).sort()).toEqual(body.body.items.map(item => item.use).sort());
  expect(uses.rows.every(row => row.role === 'publication-item')).toBe(true);

  // No fabricated text: the variant's only revision is the media set, with no text body or language.
  const revisions = await contentPool.query<{ id: string; model: string; body: Record<string, unknown> }>(
    'SELECT id, model, body FROM content.revision WHERE variant_id = $1', [variantId]);
  expect(revisions.rows).toHaveLength(1);
  expect(revisions.rows[0]).toMatchObject({ id: body.revisionId, model: 'media-set-v1' });
  expect(revisions.rows[0]!.body).not.toHaveProperty('body');
  const variant = await contentPool.query('SELECT language_kind, direction FROM content.variant WHERE id = $1',
    [variantId]);
  expect(variant.rows[0]).toEqual({ language_kind: 'zxx', direction: 'none' });

  // The exact revision is activated through the existing Content publication command.
  await author.grant(`content:publish:${variantId}`, 'content.publish');
  const published = await author.send('POST', '/v1/content-publications', { profile: 'content-publication-v1',
    preparationId: `images-${randomUUID()}`, revisionId: body.revisionId, expectedDigest: body.byteDigest,
    expectedContentEpoch: body.sourcePosition.dataEpoch, resourceId: work.work, variantId,
    expectedPublicationHead: null, actingSubject: author.actor });
  expect(published.status).toBe(201);
  const publication = await published.json() as { status: string; decision: string };
  expect(publication.status).toBe('active');
  const decision = await fuseki.query(`PREFIX rv: <https://rezics.com/vocab/> SELECT ?model ?revision WHERE {
    GRAPH <urn:rezics:graph:revisions> { <${publication.decision}> rv:contentModel ?model ;
      rv:contentRevision ?revision } }`);
  expect(decision.results?.bindings[0]?.model?.value).toBe('media-set-v1');
  expect(decision.results?.bindings[0]?.revision?.value).toBe(`urn:rezics:content:revision:${body.revisionId}`);
  const exact = (await content.readExactBatch([body.revisionId], async ids => new Set(ids)))[0];
  expect(exact).toMatchObject({ status: 'available', reference: { model: 'media-set-v1', byteDigest: body.byteDigest } });

  // Readers receive each exact item from RustFS; without Work authority they receive nothing.
  const itemUrl = (index: number) => `/v1/media/uses/${body.body.items[index]!.use}`;
  expect((await reader.read(itemUrl(0))).status).toBe(404);
  await reader.grant(`work:read:${work.work}`, 'work.read');
  for (const [index, bytes] of [first, second].entries()) {
    const delivered = await reader.read(itemUrl(index));
    expect(delivered.status).toBe(200);
    expect(sha(new Uint8Array(await delivered.arrayBuffer()))).toBe(sha(bytes));
    expect(sha(await objects(`media/asset/${pictures[index]!.asset}/`).get(sha(bytes)))).toBe(sha(bytes));
  }

  // A later asset change does not move the published basis: the item keeps its exact revision.
  const replaced = await author.upload(png(640, 480), 'public', pictures[0]!.asset);
  expect(replaced.revision).not.toBe(pictures[0]!.revision);
  const pinned = await contentPool.query('SELECT asset_revision_id FROM media.use WHERE id = $1',
    [body.body.items[0]!.use]);
  expect(pinned.rows[0].asset_revision_id).toBe(pictures[0]!.revision);
  const still = await reader.read(itemUrl(0));
  expect(sha(new Uint8Array(await still.arrayBuffer()))).toBe(sha(first));
}, 180_000);

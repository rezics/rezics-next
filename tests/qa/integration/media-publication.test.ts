import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';
import { grantRecordedPlatformUse } from '../fixtures/platform-grant.ts';
import { pollScopeId } from '../../../services/main/src/modules/vote/schema.ts';

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
  await author.grant(`content:publish:${work.work}`, 'content.publish');
  await author.grant(`work:read:${work.work}`, 'work.read');
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

test('BOOK09: a poll-only publication uses the poll owner without creating a text document', async () => {
  const { member, accessPool, contentPool } = await stack();
  const author = await member('poll-author');
  const stranger = await member('poll-stranger');
  await grantRecordedPlatformUse(accessPool, author.principalId, ['institutional-voting']);
  await grantRecordedPlatformUse(accessPool, stranger.principalId, ['institutional-voting']);
  const poll = `${ID}${randomUUID()}`;
  const body = `${ID}${randomUUID()}`;
  const holder = `${ID}${randomUUID()}`;
  const scope = pollScopeId(poll);
  const representationId = randomUUID();
  const grantId = randomUUID();
  await accessPool.query('INSERT INTO access.scope_gate (id) VALUES ($1)', [scope]);
  await accessPool.query("INSERT INTO access.authority_subject (id, kind) VALUES ($1, 'agent'), ($2, 'agent')",
    [body, holder]);
  await accessPool.query(`INSERT INTO access.representation
    (id, principal_id, subject_id, action, valid_until)
    VALUES ($1, $2, $3, 'governance.poll.administer', now() + interval '1 hour')`,
  [representationId, author.principalId, author.actor]);
  await accessPool.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1, $2, $3, $4, 'governance.poll.administer', now() + interval '1 hour')`,
  [grantId, body, author.actor, scope]);

  const request = { profile: 'poll-prepare-v1', poll, body, actingSubject: author.actor,
    representationId, grantId,
    charter: { ruleRevision: `${ID}${randomUUID()}`, unitScale: 1, countingUnit: 'weight',
      admittedSeatClasses: ['organization'], allocation: true, quorumThreshold: 1,
      abstention: 'counts', passNumerator: 1, passDenominator: 2, invalidation: 'none' },
    question: { text: 'Approve this proposal?', language: 'en' },
    options: [{ key: 'yes', role: 'approve', label: 'Approve' },
      { key: 'no', role: 'reject', label: 'Reject' }],
    entitlements: [{ holder, seatClass: 'organization', units: 100 }] };

  // The poll owner enforces its own admission; no Content text draft is part of this body.
  const denied = await stranger.send('POST', '/v1/polls', request);
  if (denied.status !== 403) throw new Error(`poll denial returned ${denied.status}: ${await denied.text()}`);
  const key = `poll-only-${randomUUID()}`;
  const created = await author.send('POST', '/v1/polls', request, key);
  expect(created.status).toBe(201);
  const prepared = await created.json() as { poll: string; revision: string; replayed: boolean };
  expect(prepared).toMatchObject({ poll, replayed: false });
  const replay = await author.send('POST', '/v1/polls', request, key);
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ poll, revision: prepared.revision, replayed: true });

  const opened = await author.send('POST', `/v1/polls/${poll.slice(ID.length)}/openings`, {
    profile: 'poll-opening-v1', actingSubject: author.actor, representationId, grantId });
  expect(opened.status).toBe(201);
  const snapshot = await author.read(`/v1/polls/${poll.slice(ID.length)}`);
  expect(snapshot.status).toBe(200);
  expect(await snapshot.json()).toMatchObject({ profile: 'poll-snapshot-v1', poll, state: 'open',
    options: [{ key: 'no' }, { key: 'yes' }] });

  const contentRows = await contentPool.query<{ variants: number; revisions: number }>(`
    SELECT count(DISTINCT v.id)::int AS variants, count(r.id)::int AS revisions
    FROM content.variant v LEFT JOIN content.revision r ON r.variant_id = v.id
    WHERE v.resource_id = $1`, [poll]);
  expect(contentRows.rows[0]).toEqual({ variants: 0, revisions: 0 });
}, 180_000);

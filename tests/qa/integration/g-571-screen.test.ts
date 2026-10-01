import { readZoneBannerMedia } from '../../../services/main/src/modules/zone/publication.ts';
import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { png, sha, startMediaStack, type MediaStack } from './media-support.ts';
import { benign, clearQueued, flagged, realmMediaFixture, screening } from './g-571-screen-support.ts';
import { GLOBAL_CONTEXT } from '../../../services/main/src/modules/governance/store.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../../../services/main/src/modules/media/store.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('g-571-screen', { autoClearUploads: false });
afterAll(async () => { if (started) await (await started).stop(); });
const context = DEFAULT_MEDIA_CONTEXT;

test('G571: benign upload reports screening, clears once, and is then delivered; replaced avatar retains cleared predecessor', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('benign');
  const outsider = await s.member('status-outsider');
  const work = await s.publicWork(owner.actor);
  const target = work.work.slice('https://rezics.com/id/'.length);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const image = await owner.upload(png(40, 40));
  expect(image).toMatchObject({ status: 'activated', clearance: 'screening', reason: null, clearanceReason: null });
  const uploadStatus = () => owner.read(`/v1/media/uploads/${image.upload}`);
  expect(await (await uploadStatus()).json()).toMatchObject({ status: 'activated', clearance: 'screening' });
  expect((await outsider.read(`/v1/media/uploads/${image.upload}`)).status).toBe(404);
  const select = async (asset: string | null, expectedSelection: string | null) => {
    const response = await owner.send('PUT', `/v1/resources/${target}/avatar`, {
      profile: 'resource-avatar-selection-v1', asset, expectedSelection, actingSubject: owner.actor });
    expect(response.status).toBe(201);
    return (await response.json() as { selection: string }).selection;
  };
  expect((await s.store.avatarRows([work.work], context)).rows.size).toBe(0);
  const first = await select(image.asset, null);
  const summary = async () => (await (await s.call('POST', '/v1/resources/summaries', { body: {
    profile: 'resource-summary-batch-v1', resources: [work.work], context, language: 'en' } })).json() as { summaries: Array<{ avatar: { kind: string; selection?: string } }> }).summaries[0]!.avatar;
  expect((await summary()).kind).toBe('fallback');
  expect((await s.call('GET', `/v1/media/avatars/${first}`)).status).toBe(404);
  await owner.grant(`work:read:${work.work}`, 'work.read');
  await outsider.grant(`work:read:${work.work}`, 'work.read');
  const preview = `/v1/media/assets/${image.asset}/bytes?${new URLSearchParams({ target: work.work, actingSubject: owner.actor })}`;
  const ownerPreview = await s.call('GET', preview, { token: owner.token });
  expect(ownerPreview.status).toBe(200);
  await ownerPreview.arrayBuffer();
  const foreignPreview = preview.replace(encodeURIComponent(owner.actor), encodeURIComponent(outsider.actor));
  expect((await s.call('GET', foreignPreview, { token: outsider.token })).status).toBe(404);
  // A second principal can represent the same owner and read the same Work,
  // but still cannot preview the first principal's unscreened original.
  await s.accessPool.query(`INSERT INTO access.representation (id, principal_id, subject_id, action, valid_until)
    VALUES ($1,$2,$3,'work.read',now() + interval '1 hour')`, [randomUUID(), outsider.principalId, owner.actor]);
  expect((await s.call('GET', preview, { token: outsider.token })).status).toBe(404);
  let classifications = 0;
  const { worker } = screening(s, { classify: async () => { classifications++; return benign; } });
  await worker.tick();
  expect(classifications).toBe(1);
  expect(await (await uploadStatus()).json()).toMatchObject({ status: 'activated', clearance: 'cleared' });
  expect((await summary()).selection).toBe(first);
  const delivered = await s.call('GET', `/v1/media/avatars/${first}`);
  expect(delivered.status).toBe(200);
  expect(sha(new Uint8Array(await delivered.arrayBuffer()))).toBe(sha(await s.objects(`media/asset/${image.asset}/`).get((await s.store.readUpload(image.upload))!.sha256!)));
  const replay = await s.call('PUT', `/v1/media/uploads/${image.upload}/bytes`, { token: owner.token, raw: png(2, 2) });
  expect(replay.status).toBe(200);
  expect(await replay.json()).toMatchObject({ status: 'activated', clearance: 'cleared', representation: image.representation, replayed: true });
  await worker.tick();
  expect(classifications).toBe(1);
  const jobs = await s.contentPool.query('SELECT count(*)::int AS n FROM media.transform_job WHERE source_id = $1 AND profile = $2',
    [image.representation, 'image-screen-v1']);
  expect(jobs.rows[0].n).toBe(1);

  const replacement = await owner.upload(png(41, 41), 'public', image.asset);
  const second = await select(replacement.asset, first);
  expect((await summary()).selection).toBe(first);
  expect((await s.call('GET', `/v1/media/avatars/${first}`)).status).toBe(200);
  expect((await s.call('GET', `/v1/media/avatars/${second}`)).status).toBe(404);
  await worker.tick();
  expect((await summary()).selection).toBe(second);
  expect((await s.call('GET', `/v1/media/avatars/${first}`)).status).toBe(404);
  expect((await s.call('GET', `/v1/media/avatars/${second}`)).status).toBe(200);
  const removal = await select(null, second);
  expect((await summary()).kind).toBe('fallback');
  expect((await s.call('GET', `/v1/media/avatars/${second}`)).status).toBe(404);
  expect((await s.call('GET', `/v1/media/avatars/${removal}`)).status).toBe(404);
}, 180_000);

test('G571: class guard enumerates all byte delivery paths; held imagery has no URL, public summary or preview and opens one disclosed platform case', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('held');
  const work = await s.publicWork(owner.actor);
  const target = work.work.slice('https://rezics.com/id/'.length);
  await owner.grant(`media:avatar:${work.work}`, 'media.avatar');
  const image = await owner.upload(png(50, 50));
  const selected = await owner.send('PUT', `/v1/resources/${target}/avatar`, {
    profile: 'resource-avatar-selection-v1', expectedSelection: null, asset: image.asset, actingSubject: owner.actor });
  expect(selected.status).toBe(201);
  const selection = (await selected.json() as { selection: string }).selection;
  const basis = await s.store.publicationBasis([image.asset], owner.actor);
  const use = randomUUID();
  await s.store.createPublicationUses(randomUUID(), owner.actor, work.work, [{ ...basis[0]!, use }]);
  const realmURL = await realmMediaFixture(s, work, { ...basis[0]!, use });
  expect((await s.call('GET', realmURL)).status).toBe(404);
  const { store, cases, worker } = screening(s, { classify: async () => flagged });
  // Likely explicit intake must also escalate an already open ordinary case.
  const existingCase = randomUUID();
  await s.accessPool.query(`INSERT INTO access.governance_case
    (id, kind, authority_kind, authority_scope_id, context, target_owner, target_resource, target_component, disclosure)
    VALUES ($1,'content_report','platform','governance:platform',$2,'media',$3,'record','private')`,
  [existingCase, GLOBAL_CONTEXT, `https://rezics.com/id/${image.asset}`]);
  await worker.tick();
  const status = await (await owner.read(`/v1/media/uploads/${image.upload}`)).json();
  expect(status).toMatchObject({ status: 'activated', clearance: 'held', clearanceReason: 'likely-explicit' });
  expect(JSON.stringify(status)).not.toMatch(/scores|thresholds|weightsDigest|Porn/);
  const params = new URLSearchParams({ target: work.work, actingSubject: owner.actor });
  for (const url of [`/v1/media/avatars/${selection}`, `/v1/media/uses/${use}`,
    `/v1/media/assets/${image.asset}/bytes?${params}`, realmURL]) {
    const delivery = new URL(url, 'http://main.local');
    delivery.searchParams.set('actingSubject', owner.actor);
    expect((await s.call('GET', delivery.pathname + delivery.search, { token: owner.token })).status).toBe(404);
  }
  const summary = await s.call('POST', '/v1/resources/summaries', { body: { profile: 'resource-summary-batch-v1', resources: [work.work], context, language: 'en' } });
  const summaryBody = await summary.json();
  expect(summaryBody).toMatchObject({ summaries: [{ avatar: { kind: 'fallback' } }] });
  expect(JSON.stringify(summaryBody)).not.toContain(image.representation);
  const previewBody = await (await s.call('GET', `/v1/public-previews/${target}`)).json();
  expect(previewBody).toMatchObject({ profile: 'public-preview-v1', avatar: { kind: 'fallback' } });
  expect(JSON.stringify(previewBody)).not.toContain(image.representation);
  expect(await s.store.itemDelivery(use)).toBeNull();
  expect(await readZoneBannerMedia(s.store, work.work, [{ id: 'held-banner', image: `https://rezics.com/id/${use}` }]))
    .toEqual([{ id: 'held-banner', image: null }]);
  expect((await s.store.avatarRows([work.work], context)).rows.get(work.work)?.representation ?? null).toBeNull();
  const record = (await s.accessPool.query(`SELECT c.*, r.reason_code, r.declarations, e.provenance FROM access.governance_case c
    JOIN access.governance_report r ON r.case_id = c.id JOIN access.governance_evidence e ON e.report_id = r.id
    WHERE c.target_resource = $1`, [`https://rezics.com/id/${image.asset}`])).rows[0]!;
  expect(record).toMatchObject({ id: existingCase, authority_kind: 'platform', authority_scope_id: 'governance:platform',
    target_owner: 'media', urgent: true, reason_code: 'explicit_imagery', declarations: { automation: true },
    provenance: { automation: 'local-image-screen', scores: flagged } });
  const reviews = await store.pendingReviews();
  expect(reviews).toHaveLength(0);
  const settled = (await s.contentPool.query(`SELECT j.id, j.input_digest, r.evidence FROM media.transform_job j
    JOIN media.screen_result r ON r.job_id = j.id WHERE j.source_id = $1`, [image.representation])).rows[0]!;
  await cases.openScreeningCase({ job: settled.id, asset: image.asset, source: image.representation,
    digest: settled.input_digest, verdict: { clearance: 'held', reason: 'likely-explicit', evidence: settled.evidence } });
  expect((await s.accessPool.query('SELECT count(*)::int AS n FROM access.governance_report WHERE id = $1', [settled.id])).rows[0].n).toBe(1);

  const ordinaryStaff = await s.member('ordinary-reviewer');
  await ordinaryStaff.grant('governance:platform', 'governance.moderate');
  await expect(cases.readReport(ordinaryStaff.principal, settled.id, ordinaryStaff.actor)).rejects.toThrow();
  await ordinaryStaff.grant('governance:platform', 'governance.safety.evidence');
  expect((await cases.readReport(ordinaryStaff.principal, settled.id, ordinaryStaff.actor)).evidence).toHaveLength(1);

  const staffDecision = randomUUID();
  expect(await store.reviewOriginal(image.representation, 'held', staffDecision, 'cleared')).toBe('applied');
  expect(await store.reviewOriginal(image.representation, 'held', staffDecision, 'cleared')).toBe('replayed');
  expect(await store.reviewOriginal(image.representation, 'held', randomUUID(), 'rejected')).toBe('stale');
  expect((await s.call('GET', realmURL)).status).toBe(200);
  expect(await store.reviewOriginal(image.representation, 'cleared', randomUUID(), 'rejected')).toBe('applied');
  expect((await s.store.readAsset(image.asset))?.moderation).toBe('suppressed');
  expect((await s.call('GET', realmURL)).status).toBe(404);

  // Discover object-producing routes from source. New surfaces must join this
  // inventory and prove the common owner clearance, rather than silently escape it.
  const routeDirectory = join(import.meta.dir, '../../../services/main/src/routes');
  const bytePaths = readdirSync(routeDirectory).flatMap(file => {
    const source = readFileSync(join(routeDirectory, file), 'utf8');
    return [...source.matchAll(/\.get\('(\/[^']+)'/g)].flatMap(match => {
      const end = source.indexOf('\n    .', match.index! + match[0].length);
      const handler = source.slice(match.index, end < 0 ? undefined : end);
      return /work\.media\.objects|(?:deliver|downloadBody)\(/.test(handler) ? [match[1]!] : [];
    });
  }).sort();
  expect(bytePaths).toEqual(['/v1/media/assets/:asset/bytes', '/v1/media/avatars/:selection',
    '/v1/media/uses/:use', '/v1/realms/:realm/main-versions/:mainVersion/selections/:selection/media/:use'].sort());
}, 180_000);

test('G571: classifier timeout/error holds uploads for review while uploads remain open', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('unavailable');
  for (const mode of ['timeout', 'error'] as const) {
    const image = await owner.upload(png(60, 60));
    const { worker } = screening(s, { classify: async () => {
      if (mode === 'error') throw new Error('outage');
      return new Promise<never>(() => {});
    } }, 20);
    await worker.tick();
    const status = await (await owner.read(`/v1/media/uploads/${image.upload}`)).json();
    expect(status).toMatchObject({ status: 'activated', clearance: 'held', clearanceReason: 'screen-unavailable' });
    expect((await s.accessPool.query('SELECT count(*)::int AS n FROM access.governance_case WHERE target_resource = $1',
      [`https://rezics.com/id/${image.asset}`])).rows[0].n).toBe(1);
  }
  expect((await owner.upload(png(61, 61))).representation).toBeDefined();
}, 180_000);

test('G571: exact-byte copy suppression crosses owners, is bounded and idempotent; later copies activate suppressed', async () => {
  const s = await stack();
  await clearQueued(s);
  const bytes = png(70, 70);
  const owners = await Promise.all(['copy-a', 'copy-b', 'copy-c', 'copy-d'].map(name => s.member(name)));
  const images = await Promise.all(owners.slice(0, 3).map(owner => owner.upload(bytes)));
  await clearQueued(s);
  await expect(s.store.suppressIdenticalCopies(sha(bytes), null, 101)).rejects.toThrow();
  await expect(s.store.suppressIdenticalCopies('invalid-digest')).rejects.toThrow();
  const before = (await s.contentPool.query('SELECT sequence FROM content.owner_control WHERE singleton')).rows[0].sequence;
  let batch = await s.store.suppressIdenticalCopies(sha(bytes), null, 1);
  const after = (await s.contentPool.query('SELECT sequence FROM content.owner_control WHERE singleton')).rows[0].sequence;
  expect(BigInt(after)).toBe(BigInt(before) + 2n); // marker and one asset history invalidate media generations

  expect(batch.suppressed).toBe(1);
  expect(batch.continuation).not.toBeNull();
  // The byte marker denies all copies before remaining state histories settle.
  for (const image of images) expect((await s.store.readUpload(image.upload))?.clearance).toBe('rejected');
  while (batch.continuation) batch = await s.store.suppressIdenticalCopies(sha(bytes), batch.continuation, 1);
  for (const image of images) expect((await s.store.readAsset(image.asset))?.moderation).toBe('suppressed');
  expect(await s.store.suppressIdenticalCopies(sha(bytes))).toEqual({ suppressed: 0, continuation: null });
  const fourth = await owners[3]!.upload(bytes);
  expect(fourth).toMatchObject({ status: 'activated', clearance: 'rejected', clearanceReason: 'restricted', reason: null });
  const replay = await s.call('PUT', `/v1/media/uploads/${fourth.upload}/bytes`, { token: owners[3]!.token, raw: bytes });
  const replayBody = await replay.json();
  expect(replayBody).toMatchObject({ status: 'activated', clearance: 'rejected', clearanceReason: 'restricted', reason: null });
  expect(JSON.stringify(replayBody)).not.toMatch(/identical|hash|match|digest/i);
  expect((await s.store.readAsset(fourth.asset))?.moderation).toBe('suppressed');
  expect(await (await owners[3]!.read(`/v1/media/uploads/${fourth.upload}`)).json()).toMatchObject({
    status: 'activated', clearance: 'rejected', reason: null, clearanceReason: 'restricted' });
  expect((await s.contentPool.query('SELECT count(*)::int AS n FROM media.transform_job WHERE source_id = $1',
    [fourth.representation])).rows[0].n).toBe(0);
}, 180_000);

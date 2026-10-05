import { afterAll, expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { png, sha, startMediaStack, type MediaStack } from '../integration/media-support.ts';
import { benign, clearQueued, flagged, screening, seedHistoricalScreen } from '../integration/g-571-screen-support.ts';
import { screenVerdict } from '../../../services/main/src/modules/media-screen/policy.ts';
import { MediaScreenWorker } from '../../../services/main/src/modules/media-screen/worker.ts';

let started: Promise<MediaStack> | undefined;
const stack = () => started ??= startMediaStack('g-571-screen-recovery', { autoClearUploads: false });
afterAll(async () => { if (started) await (await started).stop(); });

test('G571: a historical lease lost mid-screen is re-leased; stale/expired tokens settle no result or receipt', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('lease-loss');
  const image = await owner.upload(png(40, 40));
  await seedHistoricalScreen(s, image.representation);
  const { store } = screening(s);
  const old = (await store.leaseNext(1))!;
  expect(old.source).toBe(image.representation);
  await Bun.sleep(5);
  expect(await store.settle(old, screenVerdict(benign))).toBe(false);
  const next = (await store.leaseNext())!;
  expect(next.job).toBe(old.job);
  expect(next.attempt).toBe(old.attempt + 1);
  expect(next.token).not.toBe(old.token);
  expect(await store.settle(old, screenVerdict(flagged))).toBe(false);
  const applied = await Promise.all([store.settle(next, screenVerdict(benign)), store.settle(next, screenVerdict(flagged))]);
  expect(applied.filter(Boolean)).toHaveLength(1);
  const results = await s.contentPool.query('SELECT count(*)::int AS n FROM media.screen_result WHERE job_id = $1', [old.job]);
  expect(results.rows[0].n).toBe(1);
  expect((await s.contentPool.query('SELECT count(*)::int AS n FROM content.receipt WHERE operation_id = $1',
    [`media-screen:${old.job}`])).rows[0].n).toBe(1);
}, 180_000);

test('G571: concurrent historical leasing runs one screen; deletion and erasure fence in-flight results', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('epoch-loss');
  const { store } = screening(s);
  for (const [index, lifecycle] of (['deleted', 'erased'] as const).entries()) {
    const image = await owner.upload(png(41 + index, 41));
    await seedHistoricalScreen(s, image.representation);
    const leases = await Promise.all([store.leaseNext(), store.leaseNext()]);
    expect(leases.filter(Boolean)).toHaveLength(1);
    const lease = leases.find(Boolean)!;
    const removed = await owner.send('POST', `/v1/media/assets/${image.asset}/state`, {
      profile: 'media-asset-state-v1', expectedState: image.stateHead, disclosure: 'public', lifecycle,
      actingSubject: owner.actor });
    expect(removed.status).toBe(201);
    expect(await store.settle(lease, screenVerdict(benign))).toBe(false);
    expect(await store.settle(lease, screenVerdict(flagged))).toBe(false);
    expect((await s.store.readUpload(image.upload))).toMatchObject({ clearance: 'cleared', clearanceReason: null });
    expect((await (await owner.read(`/v1/media/uploads/${image.upload}`)).json()))
      .toMatchObject({ clearance: 'cleared', clearanceReason: null });
    expect((await s.call('GET', `/v1/media/representations/${image.representation}/bytes`)).status).toBe(404);
    if (lifecycle === 'deleted') {
      const state = await removed.json() as { id: string };
      expect((await owner.send('POST', `/v1/media/assets/${image.asset}/state`, {
        profile: 'media-asset-state-v1', expectedState: state.id, disclosure: 'public', lifecycle: 'active',
        actingSubject: owner.actor })).status).toBe(201);
      // Restoring the asset keeps the advanced epoch, so the original lease stays obsolete.
      expect(await store.settle(lease, screenVerdict(flagged))).toBe(false);
    }
    expect((await s.contentPool.query('SELECT 1 FROM media.screen_result WHERE source_id = $1', [image.representation])).rowCount).toBe(0);
    expect((await s.contentPool.query('SELECT 1 FROM content.receipt WHERE operation_id = $1',
      [`media-screen:${lease.job}`])).rowCount).toBe(0);
    expect((await s.contentPool.query('SELECT clearance FROM media.representation WHERE id = $1',
      [image.representation])).rows[0].clearance).toBe('screening');
    await store.cancelObsolete();
  }
}, 180_000);

test('G571: erased uploads retain staff rejection and exact-byte suppression without exposing the reason', async () => {
  const s = await stack();
  const owner = await s.member('erased-restrictions');
  const { store } = screening(s);
  for (const [index, restriction] of (['staff', 'digest'] as const).entries()) {
    const bytes = png(46 + index, 46);
    const image = await owner.upload(bytes);
    if (restriction === 'staff') {
      expect(await store.reviewOriginal(image.representation, 'cleared', randomUUID(), 'rejected')).toBe('applied');
    } else {
      expect((await s.store.suppressIdenticalCopies(sha(bytes))).suppressed).toBe(1);
    }
    const current = (await s.store.readAsset(image.asset))!;
    expect((await owner.send('POST', `/v1/media/assets/${image.asset}/state`, {
      profile: 'media-asset-state-v1', expectedState: current.state, disclosure: 'public', lifecycle: 'erased',
      actingSubject: owner.actor })).status).toBe(201);
    expect(await s.store.readUpload(image.upload)).toMatchObject({ clearance: 'rejected', clearanceReason: 'restricted' });
    expect(await (await owner.read(`/v1/media/uploads/${image.upload}`)).json())
      .toMatchObject({ clearance: 'rejected', clearanceReason: 'restricted' });
    expect((await s.call('GET', `/v1/media/representations/${image.representation}/bytes`)).status).toBe(404);
  }
}, 180_000);

test('G571: historical case retry survives a lost response without blocking image delivery', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('case-loss');
  const image = await owner.upload(png(42, 42));
  await seedHistoricalScreen(s, image.representation);
  const { store, cases } = screening(s);
  let lost = true;
  const worker = new MediaScreenWorker(store, { classify: async () => flagged }, s.objects, {
    openScreeningCase: async review => {
      const id = await cases.openScreeningCase(review);
      if (lost) { lost = false; throw new Error('lost case commit response'); }
      return id;
    },
  });
  await worker.tick();
  expect((await s.store.readUpload(image.upload))?.clearance).toBe('cleared');
  const row = (await s.contentPool.query('SELECT j.id, q.case_id FROM media.transform_job j JOIN media.screen_review q ON q.job_id = j.id WHERE j.source_id = $1',
    [image.representation])).rows[0]!;
  expect(row.case_id).toBeNull();
  // Advance the retry clock, rather than waiting a minute in the recovery test.
  await s.contentPool.query('UPDATE media.screen_review SET retry_after = clock_timestamp() WHERE job_id = $1', [row.id]);
  await worker.tick();
  expect((await s.contentPool.query('SELECT case_id FROM media.screen_review WHERE job_id = $1', [row.id])).rows[0].case_id).not.toBeNull();
  expect((await s.accessPool.query('SELECT count(*)::int AS n FROM access.governance_report WHERE id = $1', [row.id])).rows[0].n).toBe(1);

  const unavailable = await owner.upload(png(43, 43));
  await seedHistoricalScreen(s, unavailable.representation);
  await s.accessPool.query("UPDATE access.scope_gate SET open = false WHERE id = 'governance:platform'");
  try {
    const outage = screening(s, { classify: async () => { throw new Error('classifier outage'); } });
    await outage.worker.tick();
    expect((await s.store.readUpload(unavailable.upload))?.clearance).toBe('cleared');
    expect((await s.accessPool.query('SELECT 1 FROM access.governance_case WHERE target_resource = $1',
      [`https://rezics.com/id/${unavailable.asset}`])).rowCount).toBe(0);
  } finally { await s.accessPool.query("UPDATE access.scope_gate SET open = true WHERE id = 'governance:platform'"); }
}, 180_000);

test('G571: historical crashes exhaust at sixteen leases with retained unknown evidence; obsolete jobs leave the ready queue', async () => {
  const s = await stack();
  await clearQueued(s);
  const owner = await s.member('exhausted');
  const image = await owner.upload(png(44, 44));
  await seedHistoricalScreen(s, image.representation);
  const { store, worker } = screening(s);
  for (let attempt = 1; attempt <= 16; attempt++) {
    const lease = (await store.leaseNext(1))!;
    expect(lease.attempt).toBe(attempt);
    await Bun.sleep(3);
  }
  expect(await store.leaseNext()).toBeNull();
  await worker.tick();
  expect((await s.store.readUpload(image.upload))).toMatchObject({ clearance: 'cleared', clearanceReason: null });
  expect((await s.contentPool.query('SELECT status FROM media.transform_job WHERE source_id = $1', [image.representation])).rows[0].status).toBe('failed');
  await store.cancelObsolete();
  const stale = await s.contentPool.query(`SELECT 1 FROM media.transform_job j JOIN media.asset a ON a.id = j.asset_id
    JOIN media.asset_state st ON st.id = a.state_head WHERE j.profile = 'image-screen-v1' AND st.lifecycle = 'erased'
      AND j.status IN ('queued','leased')`);
  expect(stale.rowCount).toBe(0);
}, 180_000);

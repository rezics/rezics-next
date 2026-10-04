import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { FeedRefreshWorker } from '../../../services/main/src/modules/feed/refresh.ts';
import { seedHome, startHomeStack } from './feed-read-support.ts';

interface Health { status: 'ready' | 'indexing'; targets: { status: 'current' | 'indexing' } }
interface Page { items: { id: string }[]; projection: { status: string }; caughtUp: { state: string } }

test('G1043: migration and retained-epoch backfills serve honest partial Home pages and become ready automatically', async () => {
  const home = await startHomeStack('g-1043-readiness');
  try {
    const seeded = await seedHome(home);
    const { stack } = home;
    const epoch = stack.env.lineage.dataEpoch;
    const health = async () => home.json<Health>(await home.call('GET', '/health/feed-ready'));
    const following = async () => home.json<Page>(await home.call('GET', seeded.signed('/v1/feed?sort=new&scope=following'), undefined, home.reader.token));
    expect(await health()).toMatchObject({ status: 'ready', targets: { status: 'current' } });
    const expected = (await following()).items.map(item => item.id);
    expect(expected.length).toBeGreaterThan(0);

    // The migration adds empty target relations and target_indexed=false to
    // retained activities. Reproduce that shape without replacing schema.
    await stack.accessPool.query('DELETE FROM access.feed_target WHERE data_epoch=$1', [epoch]);
    await stack.accessPool.query('DELETE FROM access.feed_target_checkpoint WHERE data_epoch=$1', [epoch]);
    await stack.accessPool.query('UPDATE access.feed_item SET target_indexed=false WHERE data_epoch=$1', [epoch]);
    expect(await health()).toMatchObject({ status: 'indexing', targets: { status: 'indexing' } });
    expect(await following()).toMatchObject({ items: [], projection: { status: 'catching-up' }, caughtUp: { state: 'projecting' } });
    expect((await home.call('GET', '/v1/feed?sort=best&scope=all')).status).toBe(200);

    // Use the actual deployed worker lifecycle, without a manual rebuild call.
    const worker = new FeedRefreshWorker(home.deps, home.deps.feed, home.relay);
    worker.start();
    try {
      const deadline = Date.now() + 30_000;
      while ((await health()).status !== 'ready') {
        if (Date.now() > deadline) throw new Error('Automatic feed backfill did not become ready');
        await Bun.sleep(100);
      }
    } finally { await worker.stop(); }
    expect((await following()).items.map(item => item.id)).toEqual(expected);

    // The last relay batch can end exactly at its limit and source sequence.
    // Its empty continuation must publish the completed event frontier.
    await stack.accessPool.query("UPDATE access.feed_target_checkpoint SET after_event='zzzz' WHERE data_epoch=$1", [epoch]);
    expect((await health()).status).toBe('indexing');
    expect((await following()).caughtUp.state).toBe('projecting');
    await home.project();
    expect((await health()).status).toBe('ready');

    // Restored references copy as unindexed, then follow the same projector.
    const retained = await home.deps.feed.initialize(randomUUID());
    while ((await home.deps.feed.checkpoint(retained.data_epoch)).rebuild_epoch)
      await home.deps.feed.copyRetained(await home.deps.feed.checkpoint(retained.data_epoch));
    expect((await stack.accessPool.query('SELECT 1 FROM access.feed_item WHERE data_epoch=$1 AND NOT target_indexed LIMIT 1',
      [retained.data_epoch])).rowCount).toBe(1);
    await stack.accessPool.query('DELETE FROM access.feed_item WHERE data_epoch=$1', [epoch]);
    await stack.accessPool.query('DELETE FROM access.feed_target_checkpoint WHERE data_epoch=$1', [epoch]);
    await home.deps.feed.initialize(epoch);
    await home.project();
    expect(await health()).toMatchObject({ status: 'ready', targets: { status: 'current' } });
    expect((await following()).items.map(item => item.id)).toEqual(expected);

    // A dirty author history is partial even when its graph frontier is equal.
    await stack.accessPool.query('INSERT INTO access.feed_author_dirty(data_epoch,work) VALUES($1,$2)', [epoch, seeded.works[0]!.work]);
    expect((await following()).caughtUp.state).toBe('projecting');
    expect((await health()).status).toBe('indexing');
    await home.project();
    expect((await health()).status).toBe('ready');
    await stack.accessPool.query('UPDATE access.recovery_fence SET open=false WHERE id');
    try {
      expect((await home.call('GET', '/health/feed-ready')).status).toBe(503);
      expect((await home.call('GET', seeded.signed('/v1/feed?sort=new&scope=following'), undefined, home.reader.token)).status).toBe(503);
    } finally { await stack.accessPool.query('UPDATE access.recovery_fence SET open=true WHERE id'); }
  } finally { await home.stop(); }
}, 180_000);

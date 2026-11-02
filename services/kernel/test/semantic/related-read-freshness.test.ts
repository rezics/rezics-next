import { afterAll, beforeAll, expect, test } from 'bun:test';
import type { PoolClient } from 'pg';
import { newId } from '../../src/route/route.ts';
import { readRelated, updateSubjectIdentity } from '../../src/semantic/subject.ts';
import { openGrowthDatabase, type GrowthDatabase } from '../support/growth.ts';
import { deadline, identityFixture, release } from './identity-fixture.ts';

let db: GrowthDatabase;
beforeAll(async () => {
  if (!process.env.DATABASE_URL) throw new Error('DATABASE_URL must name the migrated test database');
  db = await openGrowthDatabase(process.env.DATABASE_URL);
}, 30_000);
afterAll(async () => {
  if (db) await db.close();
});

test('a reused client reads committed label, redirect and visibility changes', async () => {
  const f = await identityFixture(db.pool, db.admin);
  const original = await f.create(0x6e10, 'Original label');
  const survivor = await f.create(0x6e20, 'Survivor label');
  const client = await db.pool.connect();
  try {
    expect(await readRelated(client, [original])).toEqual({ [original]: { labels: { en: 'Original label' } } });
    await updateSubjectIdentity(db.pool, {
      subject: original,
      labels: { en: 'Committed label' },
      release,
      authorize: async () => true,
      deadline: deadline(),
    });
    expect(await readRelated(client, [original])).toEqual({ [original]: { labels: { en: 'Committed label' } } });
    await f.merge(original, survivor);
    expect(await readRelated(client, [original])).toEqual({
      [original]: { redirect: survivor, labels: { en: 'Survivor label' } },
    });
    await f.hide(survivor);
    expect(await readRelated(client, [original])).toEqual({});
  } finally {
    client.release();
  }
});

test('a failed related-read episode does not poison the next read', async () => {
  const f = await identityFixture(db.pool, db.admin);
  const id = await f.create(0x6e10, 'Recovered label');
  const client = await db.pool.connect();
  const flaky = Object.create(client) as PoolClient;
  let failNext = true;
  const query = client.query.bind(client) as (...args: any[]) => Promise<any>;
  flaky.query = ((...args: any[]) => {
    if (failNext) {
      failNext = false;
      return Promise.reject(new Error('injected related-read failure'));
    }
    return query(...args);
  }) as PoolClient['query'];
  try {
    await expect(readRelated(flaky, [id])).rejects.toThrow('injected related-read failure');
    expect(await readRelated(flaky, [id])).toEqual({ [id]: { labels: { en: 'Recovered label' } } });
  } finally {
    client.release();
  }
});

test('related reads reject batches above 256 ids', async () => {
  await expect(
    readRelated(
      db.pool,
      Array.from({ length: 257 }, () => newId(0x6e10)),
    ),
  ).rejects.toThrow('A related read accepts at most 256 ids');
});

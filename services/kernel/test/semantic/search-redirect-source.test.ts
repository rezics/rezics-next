import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { subjectPartition } from '../../src/search/source.ts';
import { subjectSource } from '../../src/semantic/search-source.ts';
import { createSemanticDriver } from './outcome-driver.ts';

test('a completed identity operation removes the redirected Subject from Search', async () => {
  const driver = await createSemanticDriver(undefined, { isolatedAuth: true, originalCapabilities: true });
  try {
    const write = (path: string, body: unknown) =>
      driver.request('acceptor', 'POST', path, body, { 'Idempotency-Key': JSON.stringify(randomUUID()) });
    const ids: string[] = [];
    for (const name of ['Higuchi Ichiyo', 'Higuchi Natsu']) {
      const created = await driver.request(
        'editor',
        'POST',
        '/v1/subjects',
        {
          type: 'schema:Person',
          labels: { en: name },
        },
        { 'Idempotency-Key': JSON.stringify(randomUUID()) },
      );
      expect(created.status, JSON.stringify(created.body)).toBe(201);
      ids.push((created.body.subject as { id: string }).id);
    }
    const survivor = ids.sort()[0]!;
    const redirected = ids[1]!;
    const home = subjectPartition(redirected);
    const source = subjectSource(driver.fixtures.pool, Buffer.from(driver.fixtures.runtime.routeKey, 'base64url'));
    const before = await source.count(home);
    const merge = await write('/v1/subjects:merge', { subjects: ids });
    expect(merge.status, JSON.stringify(merge.body)).toBe(202);
    const done = await driver.advanceIdentityOperation((merge.body.operation as { id: string }).id);
    expect(done.status, JSON.stringify(done.body)).toBe(200);
    expect(done.body.operation).toMatchObject({ done: true });
    const after = await source.count(home);
    expect(after.count).toBe(before.count - 1);
    const snapshot = await source.read(home, [redirected]);
    expect(snapshot.position).toBeGreaterThanOrEqual(after.position);
    expect(snapshot.subjects[0]).toMatchObject({ redirect: survivor, visibility: 'hidden' });
    expect((await source.readBookCandidateNames!([redirected]))?.get(home)?.subjects[0]).toMatchObject({
      redirect: survivor,
      visibility: 'hidden',
      labels: [],
    });
  } finally {
    await driver.close();
  }
}, 240_000);

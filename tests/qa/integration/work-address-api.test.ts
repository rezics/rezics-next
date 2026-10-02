import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { uuidToSid } from '@rezics/model/address/sid';
import { GRAPHS, iri } from '../../../services/main/src/modules/work/activate.ts';
import { addressFixture } from './g-937-support.ts';

test('VIEW01/VIEW02: one registry retains names through rename, release and equivalent merge', async () => {
  const f = await addressFixture('work');
  try {
    const a = await f.work('Alpha Work'),
      b = await f.work('Beta Work'),
      c = await f.work('Gamma Work');
    await f.accessPool.query('INSERT INTO access.scope_gate(id) VALUES ($1)', [
      `address:claim:${a.work}`,
    ]);
    expect((await f.nameWrite('work', a.work, 'claim', 'Alpha Work', null)).status).toBe(403);
    for (const record of [a, b, c]) await f.permit(record.work);
    const key = `claim-${randomUUID()}`;
    const first = await f.receipt(
      await f.nameWrite('work', a.work, 'claim', 'Alpha Work', null, key),
    );
    expect(first).toMatchObject({
      scope: 'work',
      holder: a.work,
      key: 'alpha-work',
      state: 'current',
      replayed: false,
    });
    expect(
      await f.json(await f.lookup('resource', uuidToSid(a.work.slice(-36))), 200),
    ).toMatchObject({ holder: a.work, canonical: { prefix: '/w/', key: first.key } });
    expect(
      await f.receipt(await f.nameWrite('work', a.work, 'claim', 'alpha work', null, key), 200),
    ).toMatchObject({ revision: first.revision, replayed: true });
    expect((await f.nameWrite('work', a.work, 'claim', 'Other Work', null, key)).status).toBe(409);
    expect((await f.nameWrite('work', a.work, 'claim', 'Another Address', null)).status).toBe(409);
    expect(
      (await f.nameWrite('work', b.work, 'claim', uuidToSid(b.work.slice(-36)), null)).status,
    ).toBe(400);
    expect((await f.nameWrite('work', b.work, 'claim', randomUUID(), null)).status).toBe(400);
    const raceName = `race-${randomUUID().replaceAll('-', '')}`;
    const raced = await Promise.all([
      f.nameWrite('work', b.work, 'claim', raceName, null),
      f.nameWrite('work', c.work, 'claim', raceName, null),
    ]);
    expect(raced.map((response) => response.status).sort()).toEqual([201, 409]);
    const oldExact = await f.json(
      await f.publicCall(
        `/v1/addresses/revisions/${first.revision}?${new URLSearchParams({ scope: 'work', key: first.key })}`,
      ),
      200,
    );
    const oldSummary = await f.publicCall(`/v1/resources/${a.work.slice(-36)}`);
    expect(oldSummary.status).toBe(200);
    const renamed = await f.receipt(
      await f.nameWrite('work', a.work, 'rename', '日本語の作品', first.revision),
    );
    const newSummary = await f.publicCall(`/v1/resources/${a.work.slice(-36)}`);
    expect(newSummary.status).toBe(200);
    expect(newSummary.headers.get('etag')).not.toBe(oldSummary.headers.get('etag'));
    expect(
      (await f.nameWrite('work', a.work, 'rename', 'Stale Title', first.revision)).status,
    ).toBe(409);
    expect(await f.json(await f.lookup('work', 'Alpha Work'), 200)).toMatchObject({
      holder: a.work,
      state: 'redirect',
      canonical: { prefix: '/w/', key: '日本語の作品', slugSource: 'Alpha Work' },
    });
    for (const identity of [
      a.work.slice(-36),
      uuidToSid(a.work.slice(-36)),
      `${uuidToSid(a.work.slice(-36))}-stale-slug`,
    ]) {
      expect(await f.json(await f.lookup('work', identity), 200)).toMatchObject({
        holder: a.work,
        canonical: { key: '日本語の作品' },
      });
    }
    expect(
      await f.json(
        await f.publicCall(`/v1/addresses/revisions/${first.revision}?scope=work&key=alpha-work`),
        200,
      ),
    ).toEqual(oldExact);
    const batch = await f.json<{ results: unknown[] }>(
      await f.publicCall('/v1/addresses/resolutions', {
        lookups: [
          { scope: 'work', key: first.key },
          { scope: 'work', key: 'missing-name' },
          { scope: 'work', key: first.key },
        ],
      }),
      200,
    );
    expect(batch.results[0]).toEqual(batch.results[2]);
    expect(batch.results[1]).toMatchObject({ status: 'unavailable' });
    const released = await f.receipt(
      await f.nameWrite('work', a.work, 'release', null, renamed.revision),
    );
    expect((await f.lookup('work', released.key)).status).toBe(410);
    expect((await f.nameWrite('work', b.work, 'claim', released.key, null)).status).toBe(409);
    expect(await f.json(await f.lookup('work', a.work.slice(-36)), 200)).toMatchObject({
      canonical: { prefix: '/w/', key: uuidToSid(a.work.slice(-36)) },
    });
    const reclaimed = await f.receipt(
      await f.nameWrite('work', a.work, 'claim', '日本語の作品', null),
    );
    expect(
      (await f.nameWrite('work', a.work, 'merge', null, reclaimed.revision, undefined, b.work))
        .status,
    ).toBe(400);
    await f.nativeFuseki.update(
      `PREFIX rv: <https://rezics.com/vocab/> INSERT DATA { GRAPH ${iri(GRAPHS.current)} { ${iri(a.work)} rv:mergedInto ${iri(b.work)} } }`,
    );
    await f.receipt(
      await f.nameWrite('work', a.work, 'merge', null, reclaimed.revision, undefined, b.work),
    );
    expect(await f.json(await f.lookup('work', '日本語の作品'), 200)).toMatchObject({
      holder: a.work,
      resolution: { state: 'merged', survivor: b.work },
      canonical: { prefix: '/w/' },
    });
    await f.accessPool.query('UPDATE access.recovery_fence SET open = false WHERE id');
    expect((await f.lookup('work', raceName)).status).toBe(503);
    expect((await f.nameWrite('work', a.work, 'claim', 'Held Name', null)).status).toBe(503);
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    expect((await f.lookup('work', raceName)).status).toBe(200);
    expect((await f.lookup('work', 'missing-name')).status).toBe(404);
    await expect(
      f.accessPool.query("DELETE FROM access.name_registry WHERE scope = 'work' AND key = $1", [
        first.key,
      ]),
    ).rejects.toThrow();
  } finally {
    await f.accessPool.query('UPDATE access.recovery_fence SET open = true WHERE id');
    await f.close();
  }
}, 30_000);

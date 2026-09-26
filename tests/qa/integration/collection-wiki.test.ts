import { expect, test } from 'bun:test';
import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { authorCreditFixture, nativeId, shortId } from '../fixtures/author-credit.ts';
import { S3ImmutableObjects, type ImmutableObjects }
  from '../../../services/main/src/infrastructure/immutable-objects.ts';

test('WIKI03/WIKI06: a Collection keeps repeated occurrence history and hides private members', async () => {
  if (!Bun.env.REZICS_QA_RUN_ID) throw new Error('Run through the isolated integration tier');
  const f = await authorCreditFixture(Bun.env as Record<string, string>,
    resolve('.temp', `collection-wiki-${randomUUID()}`),
    'openid work:create work:edit work:read collection:edit semantic:read');
  const objects = new S3ImmutableObjects({ endpoint: Bun.env.MAIN_S3_ENDPOINT!,
    bucket: Bun.env.MAIN_S3_BUCKET!, region: Bun.env.MAIN_S3_REGION!,
    accessKeyId: Bun.env.MAIN_S3_ACCESS_KEY!, secretAccessKey: Bun.env.MAIN_S3_SECRET_KEY!,
    prefix: 'semantic/structure/' });
  await objects.initialize();
  (f.env as typeof f.env & { structureObjects: ImmutableObjects }).structureObjects = objects;
  try {
    const visibleWork = await f.json<{ work: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Visible member', actingSubject: f.actor,
    }), 201);
    const privateWork = await f.json<{ work: string }>(await f.call('POST', '/v1/works', {
      profile: 'metadata-only-v1', title: 'Private member', actingSubject: f.actor,
    }), 201);
    await f.grant(`work:read:${visibleWork.work}`, 'work.read');
    const privateGrant = await f.grant(`work:read:${privateWork.work}`, 'work.read');
    const collection = nativeId();
    await f.grant(`collection:edit:${collection}`, 'collection.edit');
    await f.grant(`semantic:read:${collection}`, 'semantic.read');
    const create = { collection, name: 'Public collection', disclosure: 'public', actingSubject: f.actor };
    const createKey = `collection-${randomUUID()}`;
    const created = await f.json<{ structure: string; revision: string; replayed: boolean }>(
      await f.call('POST', '/v1/collections', create, createKey), 201);
    expect(created.replayed).toBe(false);
    expect(await f.json<{ structure: string; replayed: boolean }>(
      await f.call('POST', '/v1/collections', create, createKey), 200)).toMatchObject({
      structure: created.structure, replayed: true,
    });
    const path = `/v1/collections/${shortId(collection)}`;
    const insert = { expectedHead: created.revision, actingSubject: f.actor,
      operations: [visibleWork.work, visibleWork.work, privateWork.work].map(target => ({
        op: 'insert', role: 'member', parent: created.structure, position: 'last', target,
        selection: { mode: 'follow-context' },
      })) };
    const inserted = await f.json<{ revision: string; occurrences: string[]; cost: {
      placementsWritten: number } }>(await f.call('POST', `${path}/changes`, insert), 200);
    expect(inserted.occurrences).toHaveLength(3);
    expect(new Set(inserted.occurrences).size).toBe(3);
    expect(inserted.cost.placementsWritten).toBe(3);
    const move = { expectedHead: inserted.revision, actingSubject: f.actor,
      operations: [{ op: 'move', occurrence: inserted.occurrences[1], parent: created.structure,
        position: 'first' }] };
    const moved = await f.json<{ revision: string }>(await f.call('POST', `${path}/changes`, move), 200);
    const query = `actingSubject=${encodeURIComponent(f.actor)}`;
    const current = await f.json<{ occurrences: Array<{ occurrence: string }> }>(
      await f.call('GET', `${path}?${query}`), 200);
    expect(current.occurrences.map(item => item.occurrence).slice(0, 2)).toEqual([
      inserted.occurrences[1], inserted.occurrences[0],
    ]);
    const historical = await f.json<{ revision: string; occurrences: Array<{ occurrence: string }> }>(
      await f.call('GET', `${path}/revisions/${shortId(inserted.revision)}?${query}`), 200);
    expect(historical.revision).toBe(inserted.revision);
    expect(historical.occurrences.map(item => item.occurrence).slice(0, 2)).toEqual([
      inserted.occurrences[0], inserted.occurrences[1],
    ]);
    await f.accessPool.query('UPDATE access.permission_grant SET active = false WHERE id = $1',
      [privateGrant]);
    const disclosed = await f.json<{ occurrences: Array<{ target: string; occurrence: string }>;
      next: string | null }>(await f.call('GET', `${path}?${query}`), 200);
    expect(disclosed.occurrences).toHaveLength(2);
    expect(disclosed.occurrences.every(item => item.target === visibleWork.work)).toBe(true);
    expect(JSON.stringify(disclosed)).not.toContain(privateWork.work);
    expect(JSON.stringify(disclosed)).not.toContain('Private member');
    expect(JSON.stringify(disclosed)).not.toContain(inserted.occurrences[2]!);
    expect(disclosed.next).toBeNull();
    expect((await f.call('POST', `${path}/changes`, move, `collection-${randomUUID()}`)).status).toBe(409);
    expect((await f.call('GET', `${path}?${query}`, undefined, randomUUID(), f.account.tokenB)).status)
      .toBe(404);
  } finally { await f.close(); }
}, 180_000);

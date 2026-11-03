import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { DBOS } from '@dbos-inc/dbos-sdk';
import sharp from 'sharp';
import { Pool } from 'pg';
import { readRealmPresentationImages } from '../../../src/content/realm-media.ts';
import { actionCatalogue } from '../../../src/http/request.ts';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import type { Actor } from '../../../src/request/access.ts';
import { type Population, type Row } from '../../support/growth.ts';
import { testAccess, testRouteKey } from '../../support/test-kernel.ts';
import { mediaRealmDownloadFixture } from '../media-realm-download-fixture.ts';
import {
  composeNativeCollectionRuntime,
  createMediaObjectStore,
  imageWorkflowIds,
  uploadedEvent,
} from '../media-native-collection-fixture.ts';

export async function realmImageSummaryFixture() {
  const native = await mediaRealmDownloadFixture();
  const { db, alice, bob, governor } = native;
  const realmId = native.protectedRealm.realmId;
  const route = routeOf(realmId)!;
  const partition = partitionOf(route);
  const store = createMediaObjectStore();
  let runtime: Awaited<ReturnType<typeof composeNativeCollectionRuntime>> | undefined;
  const failedPool = new Pool({ connectionString: db.url, max: 1 });
  try {
    // All identities and website credentials exist before replacing Auth's setup executor.
    await native.grant(alice.accountId, realmId, ['realm:manage']);
    const deps = {
      pool: db.pool,
      access: testAccess({
        pool: db.pool,
        actions: actionCatalogue(native.kernel),
        auth: {
          ...native.auth.host.service.verifier,
          fetch: (url, init) => native.auth.host.service.handler(new Request(url, init)),
        },
      }),
    };
    const authenticate = (bearer: string) =>
      deps.access.authenticate(bearer, { pool: db.pool, deadline: Date.now() + 30_000 });
    const reader = await authenticate(bob.bearer);
    const owner = await authenticate(alice.bearer);
    const anonymous: Actor = { kind: 'anonymous' };
    const realm = await native.readRealm(realmId, governor.bearer);
    expect(realm.response.status).toBe(200);
    const spaceId: string = realm.value.realm.spaceId;
    await DBOS.shutdown({ deregister: true });
    runtime = await composeNativeCollectionRuntime({
      databaseUrl: db.url,
      routeKey: testRouteKey(),
      partitions: [partition],
      store,
      clock: () => new Date(),
      pool: db.openPool({ max: 4 }),
    });
    const work = runtime;
    const bytes = await sharp({ create: { width: 96, height: 48, channels: 3, background: '#123456' } })
      .png().toBuffer();
    const sha256 = createHash('sha256').update(bytes).digest('hex');

    async function upload(purpose: 'realm-icon' | 'realm-banner') {
      const key = crypto.randomUUID();
      const reserved = await native.checked('POST', `/v1/realms/${realmId}/media`, {
        purpose, mediaType: 'image/png', byteCount: bytes.length, sha256,
      }, 201, { bearer: alice.bearer, key });
      const id = reserved.media.id as string;
      expect(routeOf(id)).toBe(route);
      await store.putOriginal(id, bytes);
      const body = { containerId: realmId, reservationRequestId: key, byteCount: bytes.length, sha256 };
      const completionKey = crypto.randomUUID();
      await native.checked('POST', `/v1/media/${id}:complete`, body, 200,
        { bearer: alice.websiteBearer, key: completionKey });
      const source = await uploadedEvent(db.pool, id);
      const ids = imageWorkflowIds(source);
      await work.relayThrough(source.partition, source.position);
      await work.client.retrieveWorkflow(ids.effect).getResult();
      expect(await work.client.retrieveWorkflow(ids.image).getResult()).toMatchObject({ mediaId: id, state: 'available' });
      const objects = store.inspect(`m/${id}/`);
      // Native receipt replay and terminal workflow retrieval cannot republish derivatives.
      await native.checked('POST', `/v1/media/${id}:complete`, body, 200,
        { bearer: alice.websiteBearer, key: completionKey });
      expect(await work.client.retrieveWorkflow(ids.image).getResult()).toMatchObject({ mediaId: id, state: 'available' });
      expect(store.inspect(`m/${id}/`)).toEqual(objects);
      expect((await db.admin.query(
        "SELECT type FROM core.outbox WHERE subject=$1 AND type IN ('com.rezics.content.media.uploaded.v1','com.rezics.content.media.available.v1') ORDER BY type",
        [id],
      )).rows).toEqual([
        { type: 'com.rezics.content.media.available.v1' },
        { type: 'com.rezics.content.media.uploaded.v1' },
      ]);
      return id;
    }
    async function select(avatarMediaId: string | null, bannerMediaId: string | null) {
      const current = await native.readRealm(realmId, governor.bearer);
      expect(current.response.status).toBe(200);
      await native.checked('PATCH', `/v1/realms/${realmId}`, {
        presentation: { avatarMediaId, bannerMediaId, rules: null },
      }, 200, { bearer: alice.bearer, headers: { 'if-match': JSON.stringify(current.value.realm.headRevisionId) } });
    }
    const erased = { realmId, avatarMediaId: await upload('realm-icon'), bannerMediaId: await upload('realm-banner') };
    await select(erased.avatarMediaId, erased.bannerMediaId);
    for (const id of [erased.avatarMediaId, erased.bannerMediaId])
      await native.checked('DELETE', `/v1/media/${id}`, undefined, 204, { bearer: alice.bearer });
    const selected = { realmId, avatarMediaId: await upload('realm-icon'), bannerMediaId: await upload('realm-banner') };
    await select(selected.avatarMediaId, selected.bannerMediaId);
    const published = await native.readRealm(realmId, governor.bearer);
    expect(published.value.realm.presentation).toMatchObject({
      avatarMediaId: selected.avatarMediaId, bannerMediaId: selected.bannerMediaId,
    });
    await native.revoke(realmId, alice.accountId, ['realm:read']);
    const authority = await db.admin.query(
      `SELECT action FROM access.resource_grant WHERE route=$1 AND resource_id=$2 AND subject_id=$3
       AND action IN ('realm:manage','realm:read') AND valid @> clock_timestamp() ORDER BY action`,
      [route, realmId, alice.accountId],
    );
    expect(authority.rows).toEqual([{ action: 'realm:manage' }]);
    await failedPool.end();
    await expect(failedPool.connect()).rejects.toThrow('Cannot use a pool after calling end on the pool');

    const read = (input: { realmId: string; avatarMediaId: string | null; bannerMediaId: string | null } = selected, actor = reader, pool = db.pool) =>
      readRealmPresentationImages({ ...deps, pool }, input, { actor, deadline: Date.now() + 30_000 });
    const facts = await db.admin.query<{
      media_id: string; format: 'avif' | 'webp'; width: number; height: number; sha256: string;
    }>(`SELECT media_id::text,format,width,height,sha256 FROM content.media_variant
        WHERE route=$1 AND media_id=ANY($2::uuid[]) ORDER BY format,width`,
    [route, [selected.avatarMediaId, selected.bannerMediaId]]);
    const metadata = await db.admin.query<{ media_id: string; thumbhash: string | null; color: string | null }>(
      `SELECT media_id::text,encode(thumbhash,'base64') AS thumbhash,average_color AS color
       FROM content.media WHERE route=$1 AND media_id=ANY($2::uuid[])`,
      [route, [selected.avatarMediaId, selected.bannerMediaId]],
    );
    const templates = {
      realm: (await db.admin.query('SELECT * FROM community.realm WHERE route=$1 AND realm_id=$2', [route, realmId])).rows[0] as Row,
      revision: (await db.admin.query('SELECT * FROM community.realm_revision WHERE route=$1 AND realm_id=$2 AND revision_id=$3',
        [route, realmId, published.value.realm.headRevisionId])).rows[0] as Row,
      space: (await db.admin.query('SELECT * FROM community.space WHERE route=$1 AND space_id=$2', [routeOf(spaceId), spaceId])).rows[0] as Row,
      spaceRevision: (await db.admin.query(`SELECT r.* FROM community.space_revision r JOIN community.space s
        USING(route,space_id) WHERE s.route=$1 AND s.space_id=$2 AND r.revision_id=s.head_revision_id`,
        [routeOf(spaceId), spaceId])).rows[0] as Row,
      media: (await db.admin.query('SELECT * FROM content.media WHERE route=$1 AND media_id=$2', [route, selected.avatarMediaId])).rows[0] as Row,
      variants: (await db.admin.query('SELECT * FROM content.media_variant WHERE route=$1 AND media_id=$2', [route, selected.avatarMediaId])).rows as Row[],
    };
    let closed = false;
    return {
      native, db, deps, route, partition, realmId, spaceId, selected, erased,
      reader, owner, anonymous, failedPool, read, facts: facts.rows, metadata: metadata.rows,
      bytes: bytes.length, sha256,
      population(axis: 'population' | 'history'): Population {
        const historyRealm = newId(route);
        const historySpace = newId(route);
        const historyHead = newId(route);
        let previous: string | null = null;
        let last = historyHead;
        let selectedHead: string = published.value.realm.headRevisionId;
        return {
          name: `realm-image-summary-${axis}`, hotPartition: partition, hotShare: 1,
          rows({ ordinal }) {
            // Deliberately one exact home, independent of seeder route distribution.
            const rid = axis === 'history' ? historyRealm : newId(route);
            const sid = axis === 'history' ? historySpace : newId(route);
            const revision = axis === 'history' && ordinal === 0 ? historyHead : newId(route);
            const spaceRevision = newId(route);
            const mid = newId(route);
            const transactionId = newId(route);
            const old = new Date(Date.UTC(2000, 0, 1) + ordinal * 2000).toISOString();
            const end = new Date(Date.UTC(2000, 0, 1) + ordinal * 2000 + 1000).toISOString();
            const rows: Record<string, Row[]> = {};
            if (axis === 'population' || ordinal === 0) {
              rows['community.space'] = [{ ...templates.space, route, space_id: sid, head_revision_id: spaceRevision }];
              rows['community.space_revision'] = [{ ...templates.spaceRevision, route, space_id: sid,
                revision_id: spaceRevision, predecessor: null, address: null }];
              rows['community.realm'] = [{ ...templates.realm, route, realm_id: rid, space_id: sid,
                head_revision_id: revision }];
            }
            rows['community.realm_revision'] = [{ ...templates.revision, route, realm_id: rid,
              revision_id: revision, predecessor: axis === 'history' ? previous : null,
              presentation: { avatarMediaId: null, bannerMediaId: null, rules: null } }];
            rows['access.resource_grant'] = [{ route, resource_id: rid, subject_id: alice.accountId,
              subject_role: '', subject_kind: 'identity', action: 'realm:read',
              valid: `[${old},${end})`, transaction_id: transactionId }];
            rows['community.realm_ban'] = [{ route, realm_id: rid, account_id: alice.accountId,
              valid: `[${old},${end})`, reason: 'Retained growth history', actor: governor.accountId,
              transaction_id: transactionId }];
            rows['content.media'] = [{ ...templates.media, route, media_id: mid, container_id: rid,
              reservation_request_id: crypto.randomUUID(), key: `m/${mid}/original`,
              claimed_realm_id: rid, claimed_item_id: null, transaction_id: transactionId,
              erased: axis === 'history' }];
            rows['content.media_variant'] = templates.variants.map((v) => ({ ...v, route, media_id: mid,
              key: `m/${mid}/${v.format}-${v.width}` }));
            previous = revision;
            last = revision;
            return rows;
          },
          async finish(admin, range) {
            if (axis !== 'history') return;
            await admin.query('UPDATE community.realm SET head_revision_id=$3 WHERE route=$1 AND realm_id=$2',
              [route, historyRealm, last]);
            // Selected immutable history must come from its ordinary settings writer.
            // Only unrelated pressure is bulk SQL; selected publication and claims stay native.
            for (let ordinal = range.from; ordinal < range.to; ordinal++) {
              const changed = await native.checked('PATCH', `/v1/realms/${realmId}`, {
                summary: `Retained image history ${String(ordinal).padStart(4, '0')}`,
              }, 200, { headers: { 'if-match': JSON.stringify(selectedHead) } });
              selectedHead = changed.realm.headRevisionId;
            }
            const current = await native.readRealm(realmId, governor.bearer);
            expect(current.value.realm.presentation).toMatchObject({
              avatarMediaId: selected.avatarMediaId, bannerMediaId: selected.bannerMediaId,
            });
          },
        };
      },
      async close() {
        if (closed) return;
        closed = true;
        await work.close();
        store.close();
        await native.close();
      },
    };
  } catch (error) {
    await runtime?.close();
    store.close();
    await native.close();
    throw error;
  }
}

export type RealmImageSummaryFixture = Awaited<ReturnType<typeof realmImageSummaryFixture>>;

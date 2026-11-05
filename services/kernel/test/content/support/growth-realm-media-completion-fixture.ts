import { expect } from 'bun:test';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { DBOS } from '@dbos-inc/dbos-sdk';
import sharp from 'sharp';
import { newId, partitionOf, routeOf } from '../../../src/route/route.ts';
import { seed, type Population, type GrowthReport } from '../../support/growth.ts';
import { testRouteKey } from '../../support/test-kernel.ts';
import { mediaRealmDownloadFixture } from '../media-realm-download-fixture.ts';
import {
  composeNativeCollectionRuntime,
  createMediaObjectStore,
  uploadedEvent,
  imageWorkflowIds,
  type NativeCollectionRuntime,
} from '../media-native-collection-fixture.ts';

export type Axis = 'population' | 'history';
export type Selection = Readonly<{
  id: string;
  realmId: string;
  purpose: 'realm-icon' | 'realm-banner';
  reservationRequestId: string;
  completionKey: string;
}>;
// Encode once; every selected request and both axes use these same real image bytes.
export const bytes = await sharp({ create: { width: 96, height: 48, channels: 3, background: '#123456' } })
  .png()
  .toBuffer();
export const sha256 = createHash('sha256').update(bytes).digest('hex');

export async function completionFixture() {
  // Shared fixture stays read-only: real Auth clients, production Access factory and native Realm HTTP.
  const base = await mediaRealmDownloadFixture();
  const store = createMediaObjectStore();
  let runtime: NativeCollectionRuntime | undefined;
  const realmId = base.protectedRealm.realmId;
  const route = routeOf(realmId)!;
  const partition = partitionOf(route);
  const pressureRealm = newId(route);
  const pressureHead = newId(route);
  const prefix = `realm-completion-${crypto.randomUUID()}`;
  await base.grant(base.alice.accountId, realmId, ['realm:manage']);
  // Only unrelated pressure state is inserted directly. Selected reservations always use HTTP below.
  await base.db.admin.query(
    `WITH inserted AS (INSERT INTO community.realm
       (route,realm_id,space_id,state,visibility,context_id,head_revision_id,creator,votes,created_at)
     SELECT route,$2,space_id,state,visibility,context_id,$3,creator,votes,created_at
       FROM community.realm WHERE route=$1 AND realm_id=$4 RETURNING route,realm_id)
     INSERT INTO community.realm_revision
       (route,realm_id,revision_id,predecessor,title,summary,visibility,context_id,author,created_at,votes)
     SELECT r.route,i.realm_id,$3,NULL,r.title,r.summary,r.visibility,r.context_id,r.author,r.created_at,r.votes
       FROM inserted i JOIN community.realm m ON m.route=i.route AND m.realm_id=$4
       JOIN community.realm_revision r ON r.route=m.route AND r.realm_id=m.realm_id AND r.revision_id=m.head_revision_id`,
    [route, pressureRealm, pressureHead, realmId],
  );

  async function reserve(purpose: Selection['purpose'] = 'realm-icon'): Promise<Selection> {
    const reservationRequestId = crypto.randomUUID();
    const result = await base.checked(
      'POST',
      `/v1/realms/${realmId}/media`,
      {
        purpose,
        mediaType: 'image/png',
        byteCount: bytes.length,
        sha256,
      },
      201,
      { bearer: base.alice.bearer, key: reservationRequestId },
    );
    const id = result.media.id as string;
    expect(routeOf(id)).toBe(route);
    await store.putOriginal(id, bytes);
    expect(store.inspect(`m/${id}/`)).toEqual([{ key: `m/${id}/original`, sha256 }]);
    return { id, realmId, purpose, reservationRequestId, completionKey: crypto.randomUUID() };
  }
  function input(selected: Selection) {
    return {
      containerId: selected.realmId,
      reservationRequestId: selected.reservationRequestId,
      byteCount: bytes.length,
      sha256,
    };
  }
  function complete(
    selected: Selection,
    options: {
      bearer?: string;
      key?: string;
      body?: Record<string, unknown>;
    } = {},
  ) {
    return base.call('POST', `/v1/media/${selected.id}:complete`, {
      bearer: options.bearer ?? base.alice.websiteBearer,
      key: options.key ?? selected.completionKey,
      body: options.body ?? input(selected),
    });
  }
  async function snapshot(selected: Selection) {
    const media = await base.db.admin.query(
      `SELECT container_id::text,uploader_id::text,reservation_request_id,purpose,media_type,
              byte_count::integer,actual_byte_count::integer,declared_sha256,sha256,state,
              transaction_id::text,claimed_at,claimed_realm_id,
              (SELECT count(*)::integer FROM content.media_variant v
                WHERE v.route=m.route AND v.media_id=m.media_id) AS variants
         FROM content.media m WHERE route=$1 AND media_id=$2`,
      [route, selected.id],
    );
    const receipts = await base.db.admin.query(
      `SELECT principal_kind,principal_id::text,command_kind,idempotency_key,
              encode(request_digest,'hex') AS digest,epoch,position::text,transaction_id::text,response
         FROM core.receipt WHERE partition_no=$1 AND principal_id=$2
          AND command_kind='content.media.complete' AND response->>'mediaId'=$3`,
      [partition, base.alice.accountId, selected.id],
    );
    const events = await base.db.admin.query(
      `SELECT epoch,position::text,event_seq,transaction_id::text,data FROM core.outbox
        WHERE partition_no=$1 AND subject=$2 AND type='com.rezics.content.media.uploaded.v1'`,
      [partition, selected.id],
    );
    return { media: media.rows[0], receipts: receipts.rows, events: events.rows };
  }
  async function assertState(selected: Selection, uploaded: boolean) {
    const state = await snapshot(selected);
    expect(state.media).toMatchObject({
      container_id: realmId,
      uploader_id: base.alice.accountId,
      reservation_request_id: selected.reservationRequestId,
      purpose: selected.purpose,
      media_type: 'image/png',
      byte_count: bytes.length,
      declared_sha256: sha256,
      actual_byte_count: uploaded ? bytes.length : null,
      sha256: uploaded ? sha256 : null,
      state: uploaded ? 'uploaded' : 'reserved',
      variants: 0,
      claimed_at: null,
      claimed_realm_id: null,
    });
    expect(state.receipts).toHaveLength(uploaded ? 1 : 0);
    expect(state.events).toHaveLength(uploaded ? 1 : 0);
    if (uploaded) {
      expect(state.receipts[0]).toMatchObject({
        principal_kind: 'account',
        principal_id: base.alice.accountId,
        command_kind: 'content.media.complete',
        transaction_id: state.media.transaction_id,
        response: { mediaId: selected.id, state: 'uploaded' },
      });
      expect(state.receipts[0].digest).toMatch(/^[a-f0-9]{64}$/);
      expect(state.events[0]).toMatchObject({
        transaction_id: state.media.transaction_id,
        epoch: state.receipts[0].epoch,
        position: state.receipts[0].position,
        data: { mediaId: selected.id, containerId: realmId, actorId: base.alice.accountId },
      });
    }
    return state;
  }

  const pressureIds: string[] = [];
  let cohort = '';
  function population(axis: Axis): Population {
    return {
      name: `${prefix}-${axis}`,
      hotPartition: partition,
      hotShare: 1,
      rows({ ordinal }) {
        const id = newId(route);
        pressureIds.push(id);
        const transaction_id = id;
        if (axis === 'population')
          return {
            'content.media': [
              {
                route,
                media_id: id,
                container_id: pressureRealm,
                uploader_id: base.alice.accountId,
                reservation_request_id: `${cohort}-${ordinal}`,
                purpose: ordinal % 2 ? 'realm-icon' : 'realm-banner',
                media_type: 'image/png',
                byte_count: bytes.length,
                declared_sha256: sha256,
                state: 'reserved',
                key: `m/${id}/original`,
                transaction_id,
                created_at: '2025-01-01T00:00:00Z',
              },
            ],
          };
        const start = new Date(Date.UTC(2000, 0, 1) + historyOrdinal++ * 2000).toISOString();
        const end = new Date(Date.parse(start) + 1000).toISOString();
        return {
          'community.realm_revision': [
            {
              route,
              realm_id: pressureRealm,
              revision_id: id,
              predecessor: pressureHead,
              title: `Retained history ${ordinal}`,
              summary: 'Unrelated retained revision',
              visibility: 'protected',
              context_id: '00000000-0000-8000-8000-000000000000',
              author: base.alice.accountId,
              created_at: start,
              votes: { upvote: 1, downvote: -1 },
            },
          ],
          'access.resource_grant': [
            {
              route,
              resource_id: pressureRealm,
              subject_id: base.alice.accountId,
              subject_role: '',
              subject_kind: 'identity',
              action: 'realm:manage',
              valid: `[${start},${end})`,
              transaction_id,
            },
          ],
          'core.receipt': [
            {
              partition_no: partition,
              principal_kind: 'account',
              principal_id: base.alice.accountId,
              command_kind: 'content.media.complete',
              idempotency_key: `${cohort}-${ordinal}`,
              request_digest: Buffer.alloc(32, 7),
              epoch: 1,
              position: 0,
              transaction_id,
              response: {},
            },
          ],
        };
      },
    };
  }
  let historyOrdinal = 0;
  async function grow(axis: Axis, scale: number, previous: number) {
    // Retain completed cohorts as a fixed background for the next series; immutable history is never deleted.
    if (previous === 0) {
      cohort = `${prefix}-${crypto.randomUUID()}`;
      pressureIds.length = 0;
    }
    await seed(base.db, population(axis), { from: previous, to: scale });
    const relations =
      axis === 'population' ? ['content.media'] : ['community.realm_revision', 'access.resource_grant', 'core.receipt'];
    for (const relation of relations) {
      const predicate =
        relation === 'content.media'
          ? 'media_id=ANY($2::uuid[])'
          : relation === 'community.realm_revision'
            ? 'revision_id=ANY($2::uuid[])'
            : relation === 'access.resource_grant'
              ? 'transaction_id=ANY($2::uuid[])'
              : 'idempotency_key LIKE $2';
      const result = await base.db.admin.query(
        `SELECT count(*)::integer AS count FROM ${relation} WHERE ${relation === 'core.receipt' ? 'partition_no' : 'route'}=$1 AND ${predicate}`,
        [relation === 'core.receipt' ? partition : route, relation === 'core.receipt' ? `${cohort}%` : pressureIds],
      );
      expect(result.rows[0].count).toBe(scale);
    }
  }
  async function startPublication() {
    // Auth provisioning belongs to this fixture; release its in-process executor before registering Content.
    await DBOS.shutdown({ deregister: true });
    runtime = await composeNativeCollectionRuntime({
      databaseUrl: base.db.url,
      pool: base.db.pool,
      routeKey: testRouteKey(),
      partitions: [partition],
      store,
      clock: () => new Date(),
    });
    // Drain the fixed setup prefix before measuring a fresh publication. No preselected future upload exists.
    const prior = await base.db.admin.query(
      `SELECT epoch,position::text,event_seq FROM core.outbox WHERE partition_no=$1
        AND type='com.rezics.content.media.uploaded.v1' ORDER BY position,event_seq`,
      [partition],
    );
    if (prior.rows.length) {
      await runtime.relayThrough(partition, BigInt(prior.rows.at(-1)!.position));
      for (const row of prior.rows) {
        const ids = imageWorkflowIds({
          partition,
          epoch: row.epoch,
          position: BigInt(row.position),
          eventSeq: row.event_seq,
          type: 'com.rezics.content.media.uploaded.v1',
        });
        await runtime.client.retrieveWorkflow(ids.effect).getResult();
        await runtime.client.retrieveWorkflow(ids.image).getResult();
      }
    }
  }
  async function publish(selected: Selection) {
    if (!runtime) throw new Error('Registered publication runtime has not started');
    const source = await uploadedEvent(base.db.pool, selected.id);
    const ids = imageWorkflowIds(source);
    await runtime.relayThrough(source.partition, source.position);
    await runtime.client.retrieveWorkflow(ids.effect).getResult();
    const image = await runtime.client.retrieveWorkflow(ids.image).getResult();
    expect(image).toMatchObject({ mediaId: selected.id, state: 'available' });
    const state = await snapshot(selected);
    expect(state.media.state).toBe('available');
    expect(state.media.variants).toBeGreaterThan(0);
    expect(state.media.variants).toBeLessThanOrEqual(12);
    expect(store.inspect(`m/${selected.id}/`).length).toBe(state.media.variants + 1);
    const workflows = await Promise.all([
      runtime.client.getWorkflow(ids.effect),
      runtime.client.getWorkflow(ids.image),
    ]);
    expect(workflows.map((workflow) => workflow?.status)).toEqual(['SUCCESS', 'SUCCESS']);
    const original = store.objects.get(`m/${selected.id}/original`);
    expect(original).toEqual(bytes);
    return {
      workflows: workflows.filter((workflow) => workflow?.status === 'SUCCESS').length,
      originals: original!.byteLength,
      variants: state.media.variants,
    };
  }
  return {
    base,
    realmId,
    route,
    partition,
    reserve,
    input,
    complete,
    snapshot,
    assertState,
    grow,
    startPublication,
    publish,
    async close() {
      try {
        await runtime?.close();
      } finally {
        store.close();
        await base.close();
      }
    },
  };
}

export function recordObservations(report: GrowthReport) {
  // Machine-readable stdout is retained by the owning check runner, never committed as an evidence file.
  console.log(
    'REALM_COMPLETION_GROWTH',
    JSON.stringify({
      revision: execFileSync('git', ['rev-parse', 'HEAD'], { encoding: 'utf8' }).trim(),
      image: { bytes: bytes.length, sha256 },
      ...report,
    }),
  );
}

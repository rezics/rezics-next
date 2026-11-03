import type { Pool } from 'pg';
import { noEffect, runCommand } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { lookupEventType } from '../events/catalogue.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import {
  REVIEW_DISCOVERY_CHANGED,
  REVIEW_DISCOVERY_OPENED,
  REVIEW_DISCOVERY_PROGRESS,
  type ReviewDiscoveryOrigin,
  type ReviewDiscoveryWork,
} from './review-discovery-events.ts';

export const REVIEW_DISCOVERY_CHANGE_LIMIT = 100;
const zero = '00000000-0000-0000-0000-000000000000';
const maxPosition = 9223372036854775807n;
type Gate = 'thread' | 'post' | 'board' | 'subject' | 'account' | 'realm' | 'space' | 'resource';
type Scope =
  | Readonly<{ kind: Gate; id: string }>
  | Readonly<{ kind: 'all' }>
  | Readonly<{
      kind: 'source';
      route: number;
      source: string;
      externalId: string;
      fieldGroup: string;
    }>;
type Key = Readonly<{ route: number; id: string }>;
type WorkRow = {
  route: number;
  id: string;
  origin: ReviewDiscoveryOrigin;
  scopes: Scope[];
  scope_no: number;
  after_route: number;
  after_id: string;
  source_subject: string | null;
  after_subject: string;
  version: string;
  complete: boolean;
};
export type ReviewDiscoveryPageResult = Readonly<{
  complete: boolean;
  version: string;
  /** Identity probes; includes concealed and already removed native reviews. */
  examined: number;
  delivered: number;
}>;

/** Closed original-event subscription. Derived projection events are deliberately absent. */
export const REVIEW_DISCOVERY_SOURCE_TYPES = [
  'com.rezics.content.thread.created.v1',
  'com.rezics.content.post.created.v1',
  'com.rezics.content.post.published.v1',
  'com.rezics.content.revision.created.v1',
  'com.rezics.content.post.erased.v1',
  'com.rezics.content.post.restored.v1',
  'com.rezics.content.moderation.takedown.v1',
  'com.rezics.content.moderation.restored.v1',
  'com.rezics.content.moderation.erasure.v1',
  'com.rezics.content.source_fence.taken_down.v1',
  'com.rezics.community.realm-discovery.changed.v1',
  'com.rezics.community.realm.created.v1',
  'com.rezics.community.realm.updated.v1',
  'com.rezics.community.realm.removed.v1',
  'com.rezics.community.realm.restored.v1',
  'com.rezics.community.realm.ban.v1',
  'com.rezics.community.realm.unban.v1',
  'com.rezics.community.realm.board-scheme.v1',
  'com.rezics.community.publication.adopted.v1',
  'com.rezics.community.publication.withdrawn.v1',
  'com.rezics.community.publication.rejected.v1',
  'com.rezics.community.space.created.v1',
  'com.rezics.community.space.updated.v1',
  'com.rezics.community.space.removed.v1',
  'com.rezics.community.space.restored.v1',
  'com.rezics.subject.created.v1',
  'com.rezics.subject.revised.v1',
  'com.rezics.subject.merged.v1',
  'com.rezics.semantic.record.deleted.v1',
  'com.rezics.semantic.record.restored.v1',
  'com.rezics.access.account.suspended.v1',
  'com.rezics.access.account.reinstated.v1',
  'com.rezics.access.operator.subject-fenced.v1',
  'com.rezics.access.operator.subject-unfenced.v1',
  'com.rezics.access.account-tombstoned.v1',
  'com.rezics.access.grant.create.v1',
  'com.rezics.access.grant.change.v1',
  'com.rezics.access.grant.revoke.v1',
  'com.rezics.access.role-grant.create.v1',
  'com.rezics.access.role-grant.change.v1',
  'com.rezics.access.role-grant.revoke.v1',
  'com.rezics.access.exposure.opened.v1',
  'com.rezics.access.exposure.closed.v1',
] as const;

/** Trusted projection inputs only: no payload body, author presentation or eligibility is copied. */
function scopes(event: CloudEvent): Scope[] {
  const data = event.data as Record<string, unknown>;
  const point = (kind: Gate, value: unknown): Scope[] => {
    if (typeof value !== 'string' || routeOf(value) === null) throw new TypeError('Invalid review discovery gate');
    return [{ kind, id: value }];
  };
  switch (event.type) {
    case 'com.rezics.content.thread.created.v1':
      return data.kind === 'review' ? point('thread', data.threadId) : [];
    case 'com.rezics.content.post.created.v1':
    case 'com.rezics.content.post.published.v1':
    case 'com.rezics.content.revision.created.v1':
      return data.kind === 'review' ? point('post', data.itemId) : [];
    case 'com.rezics.content.post.erased.v1':
    case 'com.rezics.content.post.restored.v1':
      return point('post', data.postId);
    case 'com.rezics.content.moderation.takedown.v1':
    case 'com.rezics.content.moderation.restored.v1':
      return point(data.targetKind as Gate, data.targetId);
    case 'com.rezics.content.moderation.erasure.v1':
      return point('thread', data.threadId);
    case 'com.rezics.content.source_fence.taken_down.v1':
      return [
        {
          kind: 'source',
          route: data.route as number,
          source: data.source as string,
          externalId: data.external_id as string,
          fieldGroup: data.field_group as string,
        },
      ];
    case 'com.rezics.community.publication.adopted.v1':
    case 'com.rezics.community.publication.withdrawn.v1':
    case 'com.rezics.community.publication.rejected.v1':
      return point('subject', data.subjectId);
    case 'com.rezics.semantic.record.deleted.v1':
    case 'com.rezics.semantic.record.restored.v1':
      return point(data.kind === 'context' ? 'resource' : 'subject', data.kind === 'context' ? data.id : data.subject);
    case 'com.rezics.subject.created.v1':
    case 'com.rezics.subject.revised.v1':
    case 'com.rezics.subject.merged.v1':
      return point('subject', data.id);
    case 'com.rezics.access.exposure.opened.v1':
    case 'com.rezics.access.exposure.closed.v1':
      // A public action group can be a gate on any native ancestor. Invalidate identities
      // conservatively, without treating an exposure-open event as publication authority.
      return data.changed === true ? [{ kind: 'all' }] : [];
    default:
      if (event.type.includes('.access.')) {
        if (event.type.includes('grant.')) return point('resource', (data.resource as { id: string }).id);
        return point('account', data.accountId);
      }
      if (event.type.includes('.community.realm.')) return point('realm', data.realmId ?? data.id);
      if (event.type === 'com.rezics.community.realm-discovery.changed.v1') return point('realm', data.realmId);
      if (event.type.includes('.community.space.')) return point('space', data.spaceId ?? data.id);
      throw new TypeError('Unsupported review discovery source');
  }
}

export function assertReviewDiscoveryWork(ref: ReviewDiscoveryWork): void {
  if (
    !Number.isInteger(ref.route) ||
    ref.route < 0 ||
    ref.route > 65535 ||
    ref.route % 16 !== 0 ||
    typeof ref.id !== 'string' ||
    !/^[0-9a-f-]{36}$/.test(ref.id)
  )
    throw new TypeError('Invalid review discovery work reference');
}

/** Verify the retained original before opening any work. Missing/minimized evidence is
 * unavailable, never an empty successful invalidation. Pool checkout ends before commands. */
async function original(pool: Pool, event: CloudEvent): Promise<ReviewDiscoveryOrigin> {
  if (!lookupEventType(event.type)?.Check(event.data)) throw new TypeError('Invalid review discovery original data');
  const parsed = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const partition = Number(parsed?.[1]);
  const epoch = Number(parsed?.[2]);
  if (
    !parsed ||
    !Number.isInteger(partition) ||
    partition < 0 ||
    partition > 4095 ||
    !Number.isInteger(epoch) ||
    epoch < 1 ||
    epoch > 2147483647 ||
    !/^\d{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n ||
    BigInt(event.sequence) > maxPosition ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id)
  )
    throw new TypeError('Invalid review discovery original envelope');
  const position = BigInt(event.sequence).toString();
  const found = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<{ event_seq: number }>(
          `SELECT event_seq FROM core.outbox WHERE partition_no=$1 AND epoch=$2 AND position=$3
       AND id=$4 AND type=$5 AND subject IS NOT DISTINCT FROM $6 AND data=$7::jsonb`,
          [partition, epoch, position, event.id, event.type, event.subject ?? null, JSON.stringify(event.data)],
        )
      ).rows[0],
  );
  if (!found) throw new Error('Review discovery original envelope unavailable');
  return { partition, epoch, position, eventIndex: found.event_seq, id: event.id, type: event.type };
}

/** Idempotent admission, independent of effect delivery order. No user receipt or permission is minted. */
export async function openReviewDiscoveryWork(pool: Pool, event: CloudEvent): Promise<ReviewDiscoveryWork | null> {
  if (!(REVIEW_DISCOVERY_SOURCE_TYPES as readonly string[]).includes(event.type))
    throw new TypeError('Unsupported review discovery original');
  const origin = await original(pool, event);
  const selected = scopes(event);
  if (selected.length === 0) return null;
  const ref = { route: origin.partition * 16, id: origin.id };
  await runCommand(pool, { partition: origin.partition, deadline: Date.now() + 30_000 }, async (tx) => {
    const inserted = await tx.query(
      `INSERT INTO content.review_discovery_work(route,id,origin,scopes) VALUES($1,$2,$3::jsonb,$4::jsonb)
       ON CONFLICT DO NOTHING RETURNING id`,
      [ref.route, ref.id, JSON.stringify(origin), JSON.stringify(selected)],
    );
    if (inserted.rowCount === 0) return noEffect(null);
    return { value: null, events: [{ type: REVIEW_DISCOVERY_OPENED, subject: ref.id, data: ref }] };
  });
  return ref;
}

export function createReviewDiscoveryEffect(pool: Pool): Effect {
  return {
    name: 'content_review_discovery_source',
    types: [...REVIEW_DISCOVERY_SOURCE_TYPES],
    async run(event) {
      await openReviewDiscoveryWork(pool, event);
    },
  };
}

async function readWork(pool: Pool, ref: ReviewDiscoveryWork): Promise<WorkRow> {
  assertReviewDiscoveryWork(ref);
  const row = await withConnection(
    pool,
    async (client) =>
      (
        await client.query<WorkRow>(
          `SELECT route,id,origin,scopes,scope_no,after_route,after_id,source_subject,after_subject,
       version::text,complete FROM content.review_discovery_work WHERE route=$1 AND id=$2`,
          [ref.route, ref.id],
        )
      ).rows[0],
  );
  if (!row) throw new Error('Review discovery work unavailable');
  return row;
}

async function candidatePage(pool: Pool, row: WorkRow, scope: Scope, subject: string | null): Promise<Key[]> {
  // All predicates are from the closed scope union. Values are always parameters.
  let predicate: string;
  let values: unknown[];
  if (scope.kind === 'all') {
    predicate = "gate_kind='thread'";
    values = [];
  } else if (scope.kind === 'resource') {
    predicate = 'gate_key=$1::uuid';
    values = [scope.id];
  } else {
    predicate = 'gate_kind=$1 AND gate_key=$2::uuid';
    values = [scope.kind === 'source' ? 'subject' : scope.kind, scope.kind === 'source' ? subject : scope.id];
  }
  const offset = values.length;
  return withConnection(
    pool,
    async (client) =>
      (
        await client.query<Key>(
          `SELECT DISTINCT route,thread_id AS id FROM content.review_discovery_dependency
     WHERE ${predicate} AND (route,thread_id)>($${offset + 1}::integer,$${offset + 2}::uuid)
     ORDER BY route,thread_id LIMIT $${offset + 3}`,
          [...values, row.after_route, row.after_id, REVIEW_DISCOVERY_CHANGE_LIMIT + 1],
        )
      ).rows,
  );
}

/** Receiving commands serialize their sparse frontier independently of the source log.
 * Original positions from different partitions are never compared or substituted for it. */
async function deliver(pool: Pool, origin: ReviewDiscoveryOrigin, keys: readonly Key[]): Promise<number> {
  const groups = new Map<number, Key[]>();
  for (const key of keys) {
    const partition = partitionOf(key.route);
    groups.set(partition, [...(groups.get(partition) ?? []), key]);
  }
  let delivered = 0;
  for (const [partition, group] of groups) {
    const outcome = await runCommand(pool, { partition, deadline: Date.now() + 30_000 }, async (tx) => {
      // Do not insert a frontier for a duplicate-only replay.
      const pending = async () =>
        (
          await tx.query<Key>(
            `SELECT k.route,k.id::text AS id FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid)
         WHERE NOT EXISTS (SELECT 1 FROM content.review_discovery_change c
           WHERE c.route=k.route AND c.thread_id=k.id AND c.origin_id=$2::uuid) ORDER BY k.route,k.id`,
            [JSON.stringify(group), origin.id],
          )
        ).rows;
      if ((await pending()).length === 0) return noEffect(0);
      await tx.query(`INSERT INTO content.review_discovery_frontier(route) VALUES($1) ON CONFLICT DO NOTHING`, [
        partition * 16,
      ]);
      const frontier = (
        await tx.query<{ position: string }>(
          `SELECT position::text FROM content.review_discovery_frontier WHERE route=$1 FOR UPDATE`,
          [partition * 16],
        )
      ).rows[0]!;
      const current = await pending();
      if (current.length === 0) return noEffect(0);
      const through = BigInt(frontier.position) + BigInt(current.length);
      await tx.query(
        `INSERT INTO content.review_discovery_change(route,thread_id,partition_no,position,origin,origin_id)
         SELECT k.route,k.id,$2::integer,$3::bigint + row_number() OVER (ORDER BY k.route,k.id),$4::jsonb,$5::uuid
         FROM jsonb_to_recordset($1::jsonb) AS k(route integer,id uuid)`,
        [JSON.stringify(current), partition, frontier.position, JSON.stringify(origin), origin.id],
      );
      await tx.query(`UPDATE content.review_discovery_frontier SET position=$2 WHERE route=$1`, [
        partition * 16,
        through.toString(),
      ]);
      return {
        value: current.length,
        events: [
          {
            type: REVIEW_DISCOVERY_CHANGED,
            data: {
              partition,
              through: through.toString(),
              ids: current.map((key) => key.id),
              origin,
            },
          },
        ],
      };
    });
    delivered += outcome.value;
  }
  return delivered;
}

/** One bounded durable page. Read and receiving checkouts are released before the
 * source work CAS. A crash between receiving commands and CAS only replays identities. */
export async function processReviewDiscoveryPage(
  pool: Pool,
  ref: ReviewDiscoveryWork,
): Promise<ReviewDiscoveryPageResult> {
  const row = await readWork(pool, ref);
  if (row.complete) return { complete: true, version: row.version, examined: 0, delivered: 0 };
  const scope = row.scopes[row.scope_no];
  if (!scope) throw new Error('Review discovery scope unavailable');
  let subject = row.source_subject;
  if (scope.kind === 'source' && subject === null) {
    subject = await withConnection(
      pool,
      async (client) =>
        (
          await client.query<{ id: string }>(
            `SELECT subject_id AS id FROM semantic.source_candidate
       WHERE route=$1 AND source=$2 AND external_id=$3 AND field_group=$4 AND subject_id>$5::uuid
       ORDER BY subject_id LIMIT 1`,
            [scope.route, scope.source, scope.externalId, scope.fieldGroup, row.after_subject],
          )
        ).rows[0]?.id ?? null,
    );
  }
  const candidates = scope.kind === 'source' && subject === null ? [] : await candidatePage(pool, row, scope, subject);
  const selected = candidates.slice(0, REVIEW_DISCOVERY_CHANGE_LIMIT);
  const delivered = await deliver(pool, row.origin, selected);
  const more = candidates.length > selected.length;
  const last = selected.at(-1);
  const sourceNext = scope.kind === 'source' && subject !== null && !more;
  const scopeDone = !more && !sourceNext;
  const scopeNo = row.scope_no + (scopeDone ? 1 : 0);
  const complete = scopeNo === row.scopes.length;
  const outcome = await runCommand(
    pool,
    { partition: partitionOf(ref.route), deadline: Date.now() + 30_000 },
    async (tx) => {
      const result = await tx.query<{ version: string }>(
        `UPDATE content.review_discovery_work SET scope_no=$4,after_route=$5,after_id=$6,
         source_subject=$7,after_subject=$8,version=version+1,complete=$9
       WHERE route=$1 AND id=$2 AND version=$3::bigint RETURNING version::text`,
        [
          ref.route,
          ref.id,
          row.version,
          scopeNo,
          more ? last!.route : -1,
          more ? last!.id : zero,
          scope.kind === 'source' && more ? subject : null,
          sourceNext ? subject : scopeDone ? zero : row.after_subject,
          complete,
        ],
      );
      const updated = result.rows[0];
      if (!updated) return noEffect(null);
      return {
        value: updated.version,
        events: [
          { type: REVIEW_DISCOVERY_PROGRESS, subject: ref.id, data: { ...ref, version: updated.version, complete } },
        ],
      };
    },
  );
  if (outcome.value === null) {
    const current = await readWork(pool, ref);
    return { complete: current.complete, version: current.version, examined: selected.length, delivered };
  }
  return { complete, version: outcome.value, examined: selected.length, delivered };
}

/** Original native task event is the only default enqueue seam. A replay returns the
 * same workflow ID, including after a lost enqueue acknowledgement. */
export function createReviewDiscoveryDispatchEffect(
  pool: Pool,
  enqueue: (ref: ReviewDiscoveryWork) => Promise<void>,
): Effect {
  return {
    name: 'content_review_discovery_dispatch',
    types: [REVIEW_DISCOVERY_OPENED],
    async run(event) {
      if (event.type !== REVIEW_DISCOVERY_OPENED) throw new TypeError('Invalid review discovery work event');
      const origin = await original(pool, event);
      const ref = event.data as ReviewDiscoveryWork;
      assertReviewDiscoveryWork(ref);
      if (origin.partition !== partitionOf(ref.route) || event.subject !== ref.id)
        throw new TypeError('Invalid review discovery work event source');
      await readWork(pool, ref);
      await enqueue(ref);
    },
  };
}

/** An explicit source-work frontier, including empty gate pages. Does not certify an
 * effects checkpoint or an index generation. Internal consumer seam; no public route. */
export async function readReviewDiscoveryProgress(pool: Pool, ref: ReviewDiscoveryWork) {
  const row = await readWork(pool, ref);
  return {
    origin: row.origin,
    complete: row.complete,
    version: row.version,
    continuation: row.complete
      ? null
      : {
          scope: row.scope_no,
          route: row.after_route,
          id: row.after_id,
          sourceSubject: row.source_subject,
          afterSubject: row.after_subject,
        },
  };
}

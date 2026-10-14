import type { Pool, PoolClient } from 'pg';
import { controlRead, controlTransaction } from '../access/topology-control.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { replySlotIri } from '../realm-reply/graph.ts';
import { activityTime } from '../feed/ranking.ts';
import type { FeedCheckpoint } from '../feed/store.ts';
import {
  compareRelayPositions,
  MAIN_RELAY_STREAM_SCOPE,
  type RelayHandoffPosition,
} from '../outbox/relay-position.ts';
import { hash } from '../work/activate.ts';
import { realmHistoryOriginCutFilter, type RealmHistoryFloor } from '../realm-admin/history.ts';
import { retireRealmPopulation } from './retirement.ts';
import { readEpochOrder } from '../discovery/lineage.ts';
import { readReplyBoards } from '../realm-reply/boards.ts';
import type { PlacementPreparation } from '../realm-reply/content-store.ts';

export const REALM_RANK_SEEK_SETTINGS = 'SET LOCAL enable_bitmapscan=off; SET LOCAL enable_seqscan=off';

export const REALM_RANK_COST = {
  projectBatch: 20,
  expirationBatch: 500,
  pageSize: 20,
  pageStatements: 2,
  candidatesPerPage: 21,
  headerAnonymousStatements: 6,
  headerMemberStatements: 9,
} as const;
export interface RealmRankKey {
  rank: number;
  time: string;
  placement: string;
}
export interface RealmRankPage {
  revision: string;
  rows: { reply: string; placement: string; rank_key: number; time_key: string }[];
}
interface Checkpoint {
  sequence: string;
  after_event: string;
  content_epoch: string;
  content_sequence: string;
}
interface Reference {
  realm: string;
  reply: string;
  placement: string;
  parent: string | null;
  work: string;
  occurred_at: Date;
  active: boolean;
  concepts: string[]; newEpoch: number; newSequence: string;
}
const BATCH = REALM_RANK_COST.projectBatch;
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

/** An accepted, pinned placement already carries the Content identity and the
 * native command proof. Publishing it needs no graph or inventory reread. */
export async function settleRealmThreadPlacement(
  access: Pool, epoch: string,
  preparation: Pick<PlacementPreparation, 'realm' | 'reply' | 'rootTarget' | 'parentReply' | 'ownerDataEpoch' | 'ownerSequence'>,
  placement: string, client?: PoolClient,
  order = { concepts: [] as string[], newEpoch: 0, newSequence: '0' },
) {
  const { realm, reply, rootTarget: work, parentReply: parent } = preparation;
  await applyRealmThreadReferences(access, epoch, [{ realm, reply }], [{
    realm, reply, placement, parent, thread: parent ?? reply, work,
    occurred_at: activityTime(placement, new Date(0)).time, active: true, ...order,
  }], [{ id: placement, occurred_at: new Date(0) }], client,
  { dataEpoch: preparation.ownerDataEpoch, sequence: preparation.ownerSequence });
}

/** Fence the exact placement before its Content decision can remove it. The
 * existing resumable ledger retains unknown outcomes until receipt recovery.
 * Operation keys prevent one refused review from clearing another's fence. */
export async function fenceRealmThreadRemoval(access: Pool, epoch: string, realm: string, reply: string, operation: string) {
  await controlTransaction(access, client => client.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource,after_key)
    VALUES($1,'placement',$2,$3) ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key=EXCLUDED.after_key`,
  [epoch, `${realm}|${reply}|${operation}`, `pending:${operation}`]));
}

export async function finishRealmThreadRemoval(access: Pool, epoch: string, realm: string, reply: string, operation: string) {
  await controlTransaction(access, client => client.query(`UPDATE access.realm_thread_dirty SET after_key=$3
    WHERE data_epoch=$1 AND kind='placement' AND resource=$2 AND after_key=$4`,
  [epoch, `${realm}|${reply}|${operation}`, `ready:${operation}`, `pending:${operation}`]));
}
async function contentPosition(session: WorkReadSession) {
  const row = (
    await session.deps.realmReplyThreads!.rankingContent.query<{
      data_epoch: string;
      sequence: string;
    }>(`
    SELECT data_epoch::text,sequence::text FROM content.owner_control WHERE singleton`)
  ).rows[0];
  if (!row) throw new WorkReadUnavailable('Realm ranking Content source is unavailable');
  return { dataEpoch: row.data_epoch, sequence: row.sequence };
}

async function mainStreamCoverage(session: WorkReadSession): Promise<RelayHandoffPosition> {
  const coverage = await session.deps.relayPosition?.read();
  if (!coverage) throw new WorkReadUnavailable('Realm ranking Main stream coverage is unavailable');
  try {
    compareRelayPositions(coverage, {
      streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch: session.position.dataEpoch,
      sequence: '0',
    });
  } catch {
    throw new WorkReadUnavailable('Realm ranking Main stream coverage is unavailable');
  }
  return coverage;
}

/** Keyset order is identical to the B-tree, including tied scores/times. */
export function realmRankSeek(
  sort: 'best' | 'top' | 'new',
  after: boolean,
  privatePopulation = false,
  concept = false,
): string {
  const table = privatePopulation ? 'realm_thread_private_order' : 'realm_thread_order';
  return `WITH parameters AS (SELECT $4::double precision AS rank,$5::bigint AS time,$6::text AS placement
      ${concept ? ',$8::uuid AS content_epoch,$9::bigint AS content_sequence,$10::numeric AS main_sequence,$11::text AS population' : ''})
    SELECT reply,placement,rank_key,time_key::text${concept ? ',expires_at' : ''} FROM access.${table}
    WHERE data_epoch=$1 AND realm=$2 AND sort='${sort}' AND period=$3
      ${privatePopulation ? 'AND population=$11' : ''}
      AND concept=${concept ? '$12' : "''"}
      ${after ? 'AND (rank_key,time_key,placement)>($4::double precision,$5::bigint,$6::text COLLATE "C")' : ''}
    ORDER BY ${table}.rank_key,${table}.time_key,${table}.placement LIMIT $7`;
}

/** One bounded page and its existing selected-dependency fence share a snapshot. */
export function realmConceptRankCut(sort: 'new' | 'best' | 'top', after: boolean, privatePopulation = false) {
  return `WITH page AS MATERIALIZED (${realmRankSeek(sort, after, privatePopulation, true)}),
    fence AS MATERIALIZED (SELECT open FROM access.recovery_fence WHERE id FOR SHARE),
    state AS (SELECT COALESCE(s.revision,0)::text AS revision FROM (SELECT 1) root
      LEFT JOIN access.realm_thread_state s ON s.data_epoch=$1 AND s.realm=$2),
    readiness AS (SELECT ready AND NOT EXISTS(SELECT 1 FROM access.realm_thread_reference
        WHERE data_epoch=$1 AND realm=$2 AND concepts IS NULL LIMIT 1)
      AND NOT EXISTS(SELECT 1 FROM page WHERE expires_at<=clock_timestamp()) AS complete
      FROM access.read_realm_thread_scope_cut($1,$2,
        (SELECT COALESCE(array_agg(reply),'{}') FROM page),$8::uuid,$9::bigint,$10::numeric,$11::text))
    SELECT fence.open,readiness.complete,state.revision,
      CASE WHEN fence.open AND readiness.complete THEN
        (SELECT COALESCE(jsonb_agg(to_jsonb(page)-'expires_at' ORDER BY rank_key,time_key::bigint,placement),'[]'::jsonb) FROM page)
      ELSE '[]'::jsonb END AS rows FROM fence CROSS JOIN state CROSS JOIN readiness`;
}

export const realmHistoryPopulation = (floor: RealmHistoryFloor) =>
  hash(['realm-ranked-history-v1', floor.dataEpoch, floor.sequence].join('\0'));

/** The caller obtained this immutable cut from current Access membership. A
 * cut index grants no authority and never contains private roster identities. */
export async function ensureRealmHistoryPopulation(
  access: Pool,
  epoch: string,
  realm: string,
  floor: RealmHistoryFloor,
) {
  const population = realmHistoryPopulation(floor);
  await access.query(
    `INSERT INTO access.realm_thread_population(data_epoch,realm,population,floor_epoch,floor_sequence)
    SELECT $1,$2,$3,$4,$5::numeric FROM access.recovery_fence WHERE id AND open
    ON CONFLICT DO NOTHING`,
    [epoch, realm, population, floor.dataEpoch, floor.sequence],
  );
  return population;
}

/** This population has not initialized or has an unsettled dependency. */
export class RealmRankingsIncomplete extends WorkReadUnavailable {
  constructor() { super('Realm rankings are projecting'); }
}

/** Reads one maintained population, without visiting an expired or denied
 * prefix. The source cut and page share one statement snapshot. A continuation
 * already admitted that population revision. Additions awaiting projection are
 * absent from that cut; dirty indexed dependencies refuse only their population.
 * Its selected rows still pass live disclosure. */
export async function realmRankPage(
  access: Pool,
  session: WorkReadSession,
  realm: string,
  sort: 'best' | 'top' | 'new',
  period: 'week' | 'month' | 'all',
  limit: number,
  after?: RealmRankKey & { revision: string },
  population?: string,
  concept?: string,
): Promise<RealmRankPage> {
  if (
    !native.test(realm) || concept !== undefined && !native.test(concept) ||
    limit < 1 ||
    limit > REALM_RANK_COST.pageSize ||
    !Number.isInteger(limit) ||
    (after &&
      (!Number.isFinite(after.rank) ||
        !/^-?\d+$/.test(after.time) ||
        !native.test(after.placement) ||
        !/^\d+$/.test(after.revision)))
  )
    throw new WorkReadUnavailable('Invalid Realm rank seek');
  const main = await mainStreamCoverage(session);
  const content = await contentPosition(session);
  type Cut = { open: boolean; complete: boolean; revision: string; rows: RealmRankPage['rows'] };
  const sql = concept ? realmConceptRankCut(sort, !!after, !!population)
    : `SELECT * FROM access.read_realm_thread_rank_cut($1,$2,'${sort}',$3,
      $4::double precision,$5::bigint,$6::text,$7::integer,$8::uuid,$9::bigint,$10::numeric,$11::text)`;
  const values = [session.position.dataEpoch, realm, sort === 'top' ? period : 'all',
    after?.rank ?? null, after?.time ?? null, after?.placement ?? '', limit + 1,
    content.dataEpoch, content.sequence, main.sequence, population ?? null, ...(concept ? [concept] : [])];
  const result = concept ? await controlRead(access, async client => {
    // Match the existing seek function's local planner contract, including
    // empty/sparse keys when small-tail statistics would otherwise choose a scan.
    await client.query(REALM_RANK_SEEK_SETTINGS);
    return client.query<Cut>(sql, values);
  }) : await access.query<Cut>(sql, values);
  const row = result.rows[0];
  if (!row?.open) throw new WorkReadUnavailable('Realm rankings are projecting');
  if (after && after.revision !== row.revision) throw new WorkReadMoved('Thread ranking changed');
  if (!row.complete) throw new RealmRankingsIncomplete();
  return { revision: row.revision, rows: row.rows };
}

/** Bounded, resumable owner projection attached to Home's existing refresh
 * worker. It publishes reference, aggregate and order changes together; reads
 * may use an established cut while unrelated work and additions remain pending. */
export class RealmThreadRankingProjection {
  constructor(
    private readonly access: Pool,
    private readonly relay: Pool,
  ) {}

  async tick(session: WorkReadSession, feed: FeedCheckpoint, through: string): Promise<boolean> {
    const content = session.deps.content;
    if (!content || !session.deps.realmReplyThreads) return false;
    const mainThrough: RelayHandoffPosition = {
      streamScope: MAIN_RELAY_STREAM_SCOPE,
      dataEpoch: feed.data_epoch,
      sequence: through,
    };
    try {
      compareRelayPositions(mainThrough, {
        streamScope: MAIN_RELAY_STREAM_SCOPE,
        dataEpoch: session.position.dataEpoch,
        sequence: '0',
      });
    } catch {
      throw new WorkReadUnavailable('Realm ranking Main stream coverage is unavailable');
    }
    const epoch = feed.data_epoch,
      owner = await contentPosition(session);
    // Backfill admits CURRENT heads, so its initial source cut is the current
    // owner cut. Only later changes need event replay; immutable old events do
    // not add a history-sized replay before this new index can become ready.
    await this.access.query(
      `INSERT INTO access.realm_thread_checkpoint(data_epoch,content_epoch,content_sequence,sequence,after_event)
      VALUES($1,$2,$3,$4,'￿') ON CONFLICT DO NOTHING`,
      [epoch, owner.dataEpoch, owner.sequence, mainThrough.sequence],
    );
    const position = (
      await this.access.query<Checkpoint>(
        `SELECT sequence::text,after_event,
      content_epoch::text,content_sequence::text FROM access.realm_thread_checkpoint WHERE data_epoch=$1`,
        [epoch],
      )
    ).rows[0]!;
    if (
      position.content_epoch !== owner.dataEpoch ||
      BigInt(position.content_sequence) > BigInt(owner.sequence)
    ) {
      await controlTransaction(this.access, async (client) => {
        await client.query(
          `UPDATE access.feed_item SET realm_thread_indexed=false
          WHERE data_epoch=$1 AND kind IN ('reply','discussion')`,
          [epoch],
        );
        await client.query(
          `UPDATE access.realm_thread_checkpoint SET content_epoch=$2,content_sequence=$3 WHERE data_epoch=$1`,
          [epoch, owner.dataEpoch, owner.sequence],
        );
      });
      return true;
    }
    // NULL marks only pre-migration references. The existing owner consumes
    // their exact keys in its normal bounded turn, with no migration scan.
    const backfill = (await this.access.query<{ realm: string; reply: string }>(
      `SELECT realm,reply FROM access.realm_thread_reference WHERE data_epoch=$1 AND concepts IS NULL
        ORDER BY realm,reply LIMIT $2`, [epoch, BATCH])).rows;
    if (backfill.length) { await this.project(session, backfill); return true; }
    const pending = (
      await this.access.query<{ id: string; occurred_at: Date }>(
        `SELECT id,occurred_at FROM access.feed_item
      WHERE data_epoch=$1 AND kind IN ('reply','discussion') AND NOT realm_thread_indexed ORDER BY id LIMIT $2`,
        [epoch, BATCH],
      )
    ).rows;
    if (pending.length) {
      // Immutable references discover the slot even when this historical
      // placement has been replaced, hidden or came from a restored epoch.
      const rows = await session.query(
        `SELECT DISTINCT ?realm ?reply WHERE {
        VALUES ?id { ${pending.map((row) => iri(row.id)).join(' ')} }
        GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ; rv:realm ?realm ; rv:reply ?reply . }
      } LIMIT ${BATCH + 1}`,
        BATCH,
      );
      await this.project(
        session,
        rows.map((row) => ({ realm: row.realm!.value, reply: row.reply!.value })),
        pending,
      );
      return true;
    }
    const dirty = (
      await this.access.query<{
        kind: 'reply' | 'work' | 'realm' | 'parent' | 'population' | 'placement';
        resource: string;
        after_key: string;
      }>(
        `
      SELECT kind,resource,after_key FROM access.realm_thread_dirty WHERE data_epoch=$1 ORDER BY kind,resource LIMIT 1`,
        [epoch],
      )
    ).rows[0];
    if (dirty) {
      if (dirty.kind === 'placement') {
        const [realm, reply] = dirty.resource.split('|');
        if (!realm || !reply || !native.test(realm) || !native.test(reply))
          throw new WorkReadUnavailable('Realm placement job is malformed');
        if (dirty.after_key.startsWith('pending:')) {
          const committed = await this.accessContent(session).query(
            'SELECT 1 FROM content.receipt WHERE operation_id=$1', [dirty.after_key.slice(8)]);
          if (!committed.rowCount) return this.projectPopulation(session, epoch);
        }
        const after = dirty.after_key.startsWith('children:') ? dirty.after_key.slice(9) : '';
        const children = (await this.access.query<{ reply: string }>(`SELECT reply
          FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND parent=$3 AND reply>$4
          ORDER BY reply LIMIT $5`, [epoch, realm, reply, after, BATCH - 1])).rows;
        await this.project(session, [
          ...(dirty.after_key.startsWith('children:') ? [] : [{ realm, reply }]),
          ...children.map(child => ({ realm, reply: child.reply })),
        ]);
        await this.access.query(children.length === BATCH - 1
          ? `UPDATE access.realm_thread_dirty SET after_key=$4 WHERE data_epoch=$1 AND kind='placement'
            AND resource=$2 AND after_key=$3`
          : `DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind='placement' AND resource=$2 AND after_key=$3`,
        children.length === BATCH - 1
          ? [epoch, dirty.resource, dirty.after_key, `children:${children.at(-1)!.reply}`]
          : [epoch, dirty.resource, dirty.after_key]);
        return true;
      }
      if (dirty.kind === 'population') {
        await retireRealmPopulation(this.access, session, epoch, dirty.resource, dirty.after_key);
        return true;
      }
      const [afterRealm = '', afterReply = ''] = dirty.after_key.split('|');
      const column = dirty.kind;
      const refs = (
        await this.access.query<{ realm: string; reply: string }>(
          `SELECT realm,reply
        FROM access.realm_thread_reference WHERE data_epoch=$1 AND ${column}=$2
          AND (realm,reply)>($3,$4) ORDER BY realm,reply LIMIT $5`,
          [epoch, dirty.resource, afterRealm, afterReply, BATCH],
        )
      ).rows;
      await this.project(session, refs);
      const last = refs.at(-1);
      await this.access.query(
        refs.length === BATCH
          ? `UPDATE access.realm_thread_dirty SET after_key=$4 WHERE data_epoch=$1 AND kind=$2 AND resource=$3`
          : `DELETE FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind=$2 AND resource=$3`,
        refs.length === BATCH
          ? [epoch, dirty.kind, dirty.resource, `${last!.realm}|${last!.reply}`]
          : [epoch, dirty.kind, dirty.resource],
      );
      return true;
    }
    if (position.content_sequence !== owner.sequence) {
      const events = (
        await this.accessContent(session).query<{
          sequence: string;
          reply: string | null;
          resource: string | null;
          realm: string | null;
          effect?: 'addition' | 'removal';
          has_effect?: boolean;
        }>(
          `
        SELECT o.sequence::text,p.id AS reply,v.resource_id AS resource,r.outcome='succeeded' AS has_effect,
          CASE WHEN o.event_type='content.realm-review.decided' THEN o.payload->>'realm' ELSE NULL END AS realm,
          CASE WHEN r.outcome='succeeded' AND (
            o.event_type='content.reply.created' AND r.action='reply.create'
            OR o.event_type IN ('content.realm-reply.prepared','content.publication.prepared')
              AND r.action='publication.prepare'
            OR o.event_type='content.revision.saved' AND r.action='draft.save'
            OR o.event_type='content.comment.created' AND r.action='comment.create'
            OR o.event_type='content.publication.active' AND r.action='publication.settle'
            OR o.event_type='content.realm-review.decided' AND r.action='review.decide'
              AND d.outcome='approved' AND d.supersedes IS NULL
          ) THEN 'addition' ELSE 'removal' END AS effect
          FROM content.outbox o
        JOIN content.receipt r ON r.operation_id=o.operation_id
        LEFT JOIN content.variant v ON v.id=r.variant_id
        LEFT JOIN content.reply p ON p.variant_id=v.id
        LEFT JOIN content.realm_review_decision d ON d.operation_id=o.operation_id
        WHERE o.data_epoch=$1 AND o.sequence>$2::bigint ORDER BY o.sequence LIMIT $3`,
          [owner.dataEpoch, position.content_sequence, BATCH],
        )
      ).rows;
      if (!events.length) throw new WorkReadUnavailable('Realm ranking Content source has a gap');
      let expected = BigInt(position.content_sequence);
      for (const event of events)
        if (BigInt(event.sequence) !== ++expected) {
          throw new WorkReadUnavailable('Realm ranking Content source is not contiguous');
        }
      await controlTransaction(this.access, async (client) => {
        await this.lock(client, epoch, position);
        for (const event of events) {
          // A typed refusal consumes a stream position without changing a placement.
          if (event.has_effect === false) continue;
          if (event.reply && event.realm) await this.placementDirty(client, epoch, event.realm, event.reply, event.effect);
          else if (event.reply) await this.dirty(client, epoch, 'reply', event.reply, event.effect);
          else if (event.resource) await this.dirty(client, epoch, 'work', event.resource, event.effect);
        }
        await client.query(
          `UPDATE access.realm_thread_checkpoint SET content_sequence=$2 WHERE data_epoch=$1`,
          [epoch, expected.toString()],
        );
      });
      return true;
    }
    if (position.sequence !== mainThrough.sequence || position.after_event !== '￿') {
      const events = (
        await this.relay.query<{
          sequence: string;
          event_id: string;
          reply: string | null;
          work: string | null;
          realm: string | null;
          effect?: 'addition' | 'removal';
          has_effect?: boolean | null;
        }>(
          `SELECT sequence::text,event_id,
          CASE WHEN envelope#>>'{data,receipt,outcome}' IN ('rejected','refused','cancelled','stale_head') THEN false
            WHEN envelope#>>'{data,receipt,outcome}'='succeeded' THEN true ELSE NULL END AS has_effect,
          envelope#>>'{data,receipt,reply}' AS reply,
          COALESCE(envelope#>>'{data,receipt,work}',envelope#>>'{data,receipt,rootTarget}',
            envelope#>>'{data,payload,work}',envelope#>>'{data,work}') AS work,
          envelope#>>'{data,receipt,realm}' AS realm,
          CASE WHEN envelope#>>'{data,receipt,outcome}'='succeeded' AND (
            envelope->>'type'='com.rezics.realm.reply-placed.v1' AND envelope#>>'{data,receipt,action}'='reply.place'
            OR envelope->>'type'='com.rezics.work.created.v1' AND envelope#>>'{data,receipt,action}'='work.create'
            OR envelope->>'type'='com.rezics.contribution.draft-created.v1'
              AND envelope#>>'{data,receipt,action}'='contribution.create'
            OR envelope->>'type'='com.rezics.space.created.v1' AND envelope#>>'{data,receipt,action}'='space.create'
          ) THEN 'addition' ELSE 'removal' END AS effect
        FROM relay.delivered_event WHERE stream_scope=$1 AND data_epoch=$2 AND sequence<=$3::numeric
          AND (sequence>$4::numeric OR sequence=$4::numeric AND event_id>$5)
        ORDER BY sequence,event_id LIMIT $6`,
          [mainThrough.streamScope, mainThrough.dataEpoch, mainThrough.sequence,
            position.sequence, position.after_event, BATCH],
        )
      ).rows;
      await controlTransaction(this.access, async (client) => {
        await this.lock(client, epoch, position);
        for (const event of events) {
          if (event.has_effect === false) continue;
          if (event.reply && event.realm) await this.placementDirty(client, epoch, event.realm, event.reply, event.effect);
          else if (event.reply) await this.dirty(client, epoch, 'reply', event.reply, event.effect);
          else if (event.work) await this.dirty(client, epoch, 'work', event.work, event.effect);
          else if (event.realm) await this.dirty(client, epoch, 'realm', event.realm, event.effect);
        }
        const last = events.at(-1);
        await client.query(
          `UPDATE access.realm_thread_checkpoint SET sequence=$2,after_event=$3 WHERE data_epoch=$1`,
          [
            epoch,
            events.length === BATCH ? last!.sequence : mainThrough.sequence,
            events.length === BATCH ? last!.event_id : '￿',
          ],
        );
      });
      return true;
    }
    if (await this.projectPopulation(session, epoch)) return true;
    const expired = await this.access.query(
      `DELETE FROM access.realm_thread_order WHERE
      (data_epoch,realm,sort,period,reply) IN (SELECT data_epoch,realm,sort,period,reply
        FROM access.realm_thread_order WHERE period<>'all' AND expires_at<=clock_timestamp()
        ORDER BY expires_at LIMIT $1)`,
      [REALM_RANK_COST.expirationBatch],
    );
    return (expired.rowCount ?? 0) > 0;
  }

  private async projectPopulation(session: WorkReadSession, epoch: string): Promise<boolean> {
    const job = (
      await this.access.query<{ realm: string; population: string }>(
        `SELECT realm,population
      FROM access.realm_thread_population_job WHERE data_epoch=$1 ORDER BY realm,population,reply LIMIT 1`,
        [epoch],
      )
    ).rows[0];
    const population = (
      await this.access.query<{
        realm: string;
        population: string;
        floor_epoch: string;
        floor_sequence: string;
        after_reply: string;
        ready: boolean;
      }>(
        `SELECT realm,population,floor_epoch,
        floor_sequence::text,after_reply,ready FROM access.realm_thread_population
      WHERE data_epoch=$1 ${job ? 'AND realm=$2 AND population=$3' : 'AND NOT ready'}
      ORDER BY realm,population LIMIT 1`,
        job ? [epoch, job.realm, job.population] : [epoch],
      )
    ).rows[0];
    if (!population) return false;
    const { realm } = population;
    const refs = (
      await this.access.query<{ reply: string }>(
        job
          ? `SELECT reply FROM access.realm_thread_population_job WHERE data_epoch=$1 AND realm=$2 AND population=$3 ORDER BY reply LIMIT $4`
          : `SELECT reply FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply>$3 ORDER BY reply LIMIT $4`,
        [epoch, realm, job ? population.population : population.after_reply, BATCH],
      )
    ).rows;
    const history = await realmHistoryOriginCutFilter(
      session.deps.environment,
      { dataEpoch: population.floor_epoch, sequence: population.floor_sequence },
      realm,
      'placement',
      '?slot',
    );
    const admitted = refs.length
      ? await session.query(
          `SELECT DISTINCT ?reply WHERE {
      VALUES (?reply ?slot) { ${refs.map((ref) => `(${iri(ref.reply)} ${iri(replySlotIri(realm, ref.reply))})`).join(' ')} }
      ${history}
    } LIMIT ${BATCH + 1}`,
          BATCH,
        )
      : [];
    const allowed = new Set(admitted.map((row) => row.reply!.value));
    await controlTransaction(this.access, async (client) => {
      for (const ref of refs) {
        // Source score/order changes and cut admission must not race their
        // mirrors: serialize on the same exact reference row.
        const present = await client.query(
          `SELECT 1 FROM access.realm_thread_reference
          WHERE data_epoch=$1 AND realm=$2 AND reply=$3 FOR UPDATE`,
          [epoch, realm, ref.reply],
        );
        if (present.rowCount) {
          await client.query(
            `INSERT INTO access.realm_thread_population_admission VALUES($1,$2,$3,$4,$5)
            ON CONFLICT(data_epoch,realm,population,reply) DO UPDATE SET admitted=EXCLUDED.admitted`,
            [epoch, realm, population.population, ref.reply, allowed.has(ref.reply)],
          );
          await client.query(
            `DELETE FROM access.realm_thread_private_order
            WHERE data_epoch=$1 AND realm=$2 AND population=$3 AND reply=$4`,
            [epoch, realm, population.population, ref.reply],
          );
          if (allowed.has(ref.reply))
            await client.query(
              `INSERT INTO access.realm_thread_private_order
            SELECT data_epoch,realm,$3,sort,period,reply,placement,rank_key,time_key,expires_at,concept FROM access.realm_thread_order
            WHERE data_epoch=$1 AND realm=$2 AND reply=$4`,
              [epoch, realm, population.population, ref.reply],
            );
        }
        if (job)
          await client.query(
            `DELETE FROM access.realm_thread_population_job
          WHERE data_epoch=$1 AND realm=$2 AND population=$3 AND reply=$4`,
            [epoch, realm, population.population, ref.reply],
          );
      }
      if (!job)
        await client.query(
          `UPDATE access.realm_thread_population SET after_reply=$4,ready=$5
        WHERE data_epoch=$1 AND realm=$2 AND population=$3`,
          [
            epoch,
            realm,
            population.population,
            refs.at(-1)?.reply ?? population.after_reply,
            refs.length < BATCH,
          ],
        );
    });
    return true;
  }

  private accessContent(session: WorkReadSession): Pool {
    // ThreadStore already owns both pools; no new cross-owner credentials or
    // service lifecycle is introduced by the projection.
    return session.deps.realmReplyThreads!.rankingContent;
  }

  private async lock(client: PoolClient, epoch: string, expected: Checkpoint) {
    const current = (
      await client.query<Checkpoint>(
        `SELECT sequence::text,after_event,content_epoch::text,
      content_sequence::text FROM access.realm_thread_checkpoint WHERE data_epoch=$1 FOR UPDATE`,
        [epoch],
      )
    ).rows[0];
    if (JSON.stringify(current) !== JSON.stringify(expected))
      throw new WorkReadMoved('Realm ranking projection changed');
  }
  private async dirty(
    client: PoolClient,
    epoch: string,
    kind: 'reply' | 'work' | 'realm',
    resource: string,
    effect: 'addition' | 'removal' = 'removal',
  ) {
    await client.query(
      `INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource,effect) VALUES($1,$2,$3,$4)
      ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET after_key='',
        effect=CASE WHEN access.realm_thread_dirty.effect='removal' OR EXCLUDED.effect='removal'
          THEN 'removal' ELSE 'addition' END`,
      [epoch, kind, resource, effect],
    );
  }

  private async placementDirty(client: PoolClient, epoch: string, realm: string, reply: string,
    effect: 'addition' | 'removal' = 'removal') {
    // Successful placements retain Content's immutable parent/root and have
    // settled their own index. Replaying one cannot remove membership. An
    // already registered review removal keeps its marker and wins the effect.
    await client.query(`INSERT INTO access.realm_thread_dirty(data_epoch,kind,resource,after_key,effect)
      VALUES($1,'placement',$2,'ready:replay',$3)
      ON CONFLICT(data_epoch,kind,resource) DO UPDATE SET
        effect=CASE WHEN access.realm_thread_dirty.effect='removal' OR EXCLUDED.effect='removal'
          THEN 'removal' ELSE 'addition' END`, [epoch, `${realm}|${reply}`, effect]);
  }

  private async project(
    session: WorkReadSession,
    keys: { realm: string; reply: string }[],
    pending: { id: string; occurred_at: Date }[] = [],
  ) {
    const epochs = await readEpochOrder(session);
    const rows = keys.length
      ? await session.query(
          `SELECT ?realm ?reply ?id ?work ?author ?rootRevision ?parent ?revision ?review ?preparation ?epochOrder ?sequence WHERE {
      ${epochs}
      VALUES (?realm ?reply ?slot) { ${keys.map((key) => `(${iri(key.realm)} ${iri(key.reply)} ${iri(replySlotIri(key.realm, key.reply))})`).join(' ')} }
        GRAPH ${iri(GRAPHS.current)} { ?realm a rv:Realm ; rv:realmState rv:Active ; rv:space ?space .
          ?space a rv:Space ; rv:realmCapability ?realm .
          ?slot a rv:RealmReplySlot ; rv:replyPlacementHead ?id . }
      GRAPH ${iri(GRAPHS.revisions)} { ?id a rv:RealmReplyPlacement ; rv:placementOutcome rv:Accepted ;
        rv:realm ?realm ; rv:reply ?reply ; rv:rootTarget ?work ; rv:rootRevision ?rootRevision ; rv:author ?author ;
        rv:contentRevision ?revision ; rv:reviewDecision ?review ; rv:contentPreparation ?preparation ;
        rv:dataEpoch ?revisionEpoch ; rv:sequence ?sequence .
        OPTIONAL { ?id rv:parentReply ?parent }
        BIND(IRI(?rootRevision) AS ?anchor)
        FILTER NOT EXISTS { ?anchor a rv:ErasedRevision } }
      FILTER(EXISTS { GRAPH ${iri(GRAPHS.current)} { ?work ?p ?o } }
        || EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?work ?p ?o } })
    } LIMIT ${BATCH + 1}`,
          BATCH,
        )
      : [];
    if (
      new Set(rows.map((row) => `${row.realm?.value}|${row.reply?.value}`)).size !== rows.length
    ) {
      throw new WorkReadUnavailable('Realm ranking placements are ambiguous');
    }
    const threads = session.deps.realmReplyThreads!;
    const heads = rows.map((row) => ({
      reply: row.reply!.value,
      revisionId: row.revision!.value.replace('urn:rezics:content:revision:', ''),
      reviewDecisionId: row.review!.value.replace('urn:rezics:realm-review:', ''),
      preparationId: row.preparation!.value,
    }));
    const admitted = new Set<string>();
    for (const realm of new Set(rows.map((row) => row.realm!.value))) {
      const members = heads.filter((_head, index) => rows[index]!.realm!.value === realm);
      for (const [reply, node] of await threads.admitted(realm, members)) {
        const row = rows.find((row) => row.realm!.value === realm && row.reply!.value === reply)!;
        if (
          node.rootTarget !== row.work!.value ||
          node.rootRevision !== row.rootRevision!.value ||
          node.author !== row.author!.value ||
          node.parent !== (row.parent?.value ?? null)
        ) {
          throw new WorkReadUnavailable('Realm ranking placement differs from Content identity');
        }
        admitted.add(`${realm}|${reply}`);
      }
    }
    const references: (Reference & { thread: string })[] = [];
    for (const row of rows) {
      const reply = row.reply!.value,
        parent = row.parent?.value ?? null;
      const fallback = pending.find((ref) => ref.id === row.id!.value)?.occurred_at ?? new Date(0);
      references.push({
        realm: row.realm!.value,
        reply,
        placement: row.id!.value,
        parent,
        thread: parent ?? reply,
        work: row.work!.value,
        occurred_at: activityTime(row.id!.value, fallback).time,
        active: admitted.has(`${row.realm!.value}|${reply}`),
        concepts: (await readReplyBoards(session.deps.environment, row.id!.value)).concepts,
        newEpoch: Number(row.epochOrder!.value), newSequence: row.sequence!.value,
      });
    }
    await applyRealmThreadReferences(this.access, session.position.dataEpoch, keys, references, pending);
  }
}


/** One owner applies the command delta and background replay with the same lock
 * order, root aggregate and order triggers. No caller drains unrelated work. */
async function applyRealmThreadReferences(
  access: Pool, epoch: string, keys: { realm: string; reply: string }[],
  references: (Reference & { thread: string })[], pending: { id: string; occurred_at: Date }[] = [],
  borrowed?: PoolClient,
  source?: { dataEpoch: string; sequence: string },
) {
  await controlTransaction(access, async (client) => {
      if (source) await client.query(`INSERT INTO access.realm_thread_checkpoint
        (data_epoch,content_epoch,content_sequence,sequence,after_event) VALUES($1,$2,$3,0,'￿') ON CONFLICT DO NOTHING`,
      [epoch, source.dataEpoch, source.sequence]);
      const affected = new Map<string, { realm: string; thread: string; delta: number }>();
      const changedRealms = new Set<string>();
      const changed = (realm: string, thread: string, delta: number) => {
        const key = `${realm}|${thread}`;
        affected.set(key, { realm, thread, delta: (affected.get(key)?.delta ?? 0) + delta });
      };
      for (const key of keys) {
        const ref = references.find((ref) => ref.realm === key.realm && ref.reply === key.reply);
        if (ref?.parent) {
          // Resolve the parent's indexed pointer inside this transaction: a
          // parent may have appeared earlier in the SAME batch. References in
          // arbitrary restore order resume through exact parent jobs; no
          // request ancestor cap becomes a limit on the ranked population.
          const above = (
            await client.query<{ thread: string; active: boolean }>(
              `SELECT thread,active
            FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3`,
              [epoch, ref.realm, ref.parent],
            )
          ).rows[0];
          ref.thread = above?.thread ?? ref.parent;
          ref.active = ref.active && above?.active === true;
        }
        // Vote and projection take the same lock order. In particular, a vote
        // concurrent with FIRST insertion cannot miss a not-yet-existing mirror.
        const vote = ref
          ? (
              await client.query<{ score: number }>(
                `SELECT score FROM access.feed_item
          WHERE data_epoch=$1 AND id=$2 FOR SHARE`,
                [epoch, ref.placement],
              )
            ).rows[0]
          : null;
        const prior = (
          await client.query<{
            thread: string;
            occurred_at: Date;
            parent: string | null;
            active: boolean;
            placement: string;
          }>(
            `SELECT thread,occurred_at,parent,active,placement
          FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3 FOR UPDATE`,
            [epoch, key.realm, key.reply],
          )
        ).rows[0];
        if (ref ? !prior || prior.placement !== ref.placement || prior.parent !== ref.parent
          || prior.thread !== ref.thread || prior.active !== ref.active : prior) changedRealms.add(key.realm);
        if (prior) changed(key.realm, prior.thread, prior.parent && prior.active ? -1 : 0);
        if (!ref) {
          await client.query(
            `DELETE FROM access.realm_thread_reference WHERE data_epoch=$1 AND realm=$2 AND reply=$3`,
            [epoch, key.realm, key.reply],
          );
          continue;
        }
        const time = ref.occurred_at.getTime() === 0 && prior ? prior.occurred_at : ref.occurred_at;
        await client.query(
          `INSERT INTO access.realm_thread_reference
          (data_epoch,realm,reply,placement,parent,thread,work,occurred_at,activity_at,active,score,concepts,new_epoch,new_sequence)
          VALUES($1,$2,$3,$4,$5,$6,$7,$8,$8,$9,$10,$11,$12,$13::bigint)
          ON CONFLICT(data_epoch,realm,reply) DO UPDATE SET placement=EXCLUDED.placement,parent=EXCLUDED.parent,
            thread=EXCLUDED.thread,work=EXCLUDED.work,occurred_at=EXCLUDED.occurred_at,
            active=EXCLUDED.active,score=EXCLUDED.score,concepts=EXCLUDED.concepts,
            new_epoch=EXCLUDED.new_epoch,new_sequence=EXCLUDED.new_sequence`,
          [
            epoch,
            ref.realm,
            ref.reply,
            ref.placement,
            ref.parent,
            ref.thread,
            ref.work,
            time,
            ref.active,
            vote?.score ?? 0, ref.concepts, ref.newEpoch, ref.newSequence,
          ],
        );
        changed(ref.realm, ref.thread, ref.parent && ref.active ? 1 : 0);
      }
      // Reply activity is retained as an owner input. Best's existing vote/age
      // formula remains unchanged; new replies never rejuvenate its placement.
      for (const { realm, thread, delta } of affected.values())
        await client.query(
          `UPDATE access.realm_thread_reference root
        SET replies=GREATEST(0,root.replies+$4::integer),
          activity_at=GREATEST(root.occurred_at,COALESCE((SELECT occurred_at FROM access.realm_thread_reference child
            WHERE child.data_epoch=$1 AND child.realm=$2 AND child.thread=$3 AND child.active AND child.parent IS NOT NULL
            ORDER BY occurred_at DESC LIMIT 1),root.occurred_at))
        WHERE root.data_epoch=$1 AND root.realm=$2 AND root.reply=$3`,
          [epoch, realm, thread, delta],
        );
      if (pending.length)
        await client.query(
          `UPDATE access.feed_item SET realm_thread_indexed=true
        WHERE data_epoch=$1 AND id=ANY($2::text[])`,
          [epoch, pending.map((row) => row.id)],
        );
      for (const realm of changedRealms) await client.query(`INSERT INTO access.realm_thread_state VALUES($1,$2,1)
        ON CONFLICT(data_epoch,realm) DO UPDATE SET revision=access.realm_thread_state.revision+1`, [epoch, realm]);
  }, false, borrowed);
}

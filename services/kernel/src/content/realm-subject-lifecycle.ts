import { createHash } from 'node:crypto';
import type { Pool } from 'pg';
import type { WorkDimensions } from '../library/collection-source.ts';
import { Value } from 'typebox/value';
import { readIdentityMappings } from '../semantic/identity-epoch-read.ts';
import { SEMANTIC_EVENTS, SUBJECT_MERGED, SUBJECT_REVISED } from '../semantic/events.ts';
import { COMMUNITY_EVENTS } from '../community/events.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { readOutboxEvent } from './read-outbox-event-index.sql';
import {
  createRealmSubjectCandidates,
  REALM_SUBJECT_RAW_LIMIT,
  realmSubjectHome,
  realmSubjectRoute,
  type CandidateVersion,
  type RealmSubjectCandidate,
  type RealmSubjectCoverage,
} from './realm-subject-candidates.ts';
import { createRealmSubjectCensus } from './realm-subject-census.ts';
import type { RealmSubjectMaintenance } from './realm-subject-source.ts';
import { createRealmSubjectScope, type RealmSubjectScopeChange } from './realm-subject-scope.ts';
import type { Effect } from '../events/effects.ts';
import type { CloudEvent } from '../events/log.ts';
import { CONTENT_EVENTS } from './events.ts';
import { zeroScopeWork } from '../search/scope-execution.ts';

const threadCreated = 'com.rezics.content.thread.created.v1';
const postCreated = 'com.rezics.content.post.created.v1';
const postPublished = 'com.rezics.content.post.published.v1';
const revisionCreated = 'com.rezics.content.revision.created.v1';
const postRestored = 'com.rezics.content.post.restored.v1';
const postErased = 'com.rezics.content.post.erased.v1';
const takedown = 'com.rezics.content.moderation.takedown.v1';
const restored = 'com.rezics.content.moderation.restored.v1';
const boardCreated = 'com.rezics.content.board.created.v1';
const realmDiscoveryChanged = 'com.rezics.community.realm-discovery.changed.v1';
const contentSourceTypes = [
  threadCreated,
  postCreated,
  postPublished,
  revisionCreated,
  postRestored,
  postErased,
  takedown,
  restored,
  boardCreated,
] as const;
const communitySourceTypes = [
  'com.rezics.community.realm.created.v1',
  'com.rezics.community.realm.updated.v1',
  'com.rezics.community.realm.removed.v1',
  'com.rezics.community.realm.restored.v1',
  'com.rezics.community.realm.board-scheme.v1',
  realmDiscoveryChanged,
  'com.rezics.community.space.created.v1',
  'com.rezics.community.space.updated.v1',
  'com.rezics.community.space.removed.v1',
  'com.rezics.community.space.restored.v1',
  'com.rezics.community.space.address-changed.v1',
] as const;
const identitySourceTypes = [SUBJECT_MERGED, SUBJECT_REVISED] as const;
export const REALM_SUBJECT_LIFECYCLE_EFFECT = 'content_realm_subject_lifecycle';
export const REALM_SUBJECT_CENSUS_PAGE = 32;
export const REALM_SUBJECT_IDENTITY_PAGE = REALM_SUBJECT_RAW_LIMIT;
const maxPosition = 9_223_372_036_854_775_807n;
const zero = '00000000-0000-0000-0000-000000000000';
const schemas: readonly Record<string, unknown>[] = [CONTENT_EVENTS, COMMUNITY_EVENTS, SEMANTIC_EVENTS];

export type RealmSubjectIdentityWork = Readonly<{
  original: string;
  partition: number;
  epoch: number;
  position: string;
  eventId: string;
}>;
export type RealmSubjectIdentityPage = Readonly<{
  state: 'done' | 'more' | 'unknown';
  after: Readonly<{ route: number; realm: string; thread: string }> | null;
}>;
export type RealmSubjectSweepCursor = Readonly<{
  generation: string;
  route: number;
  complete: boolean;
  after: string | null;
  ordinal: number;
}>;
export type RealmSubjectSweepPage = Readonly<{ state: 'more' | 'retry' | 'complete'; next: RealmSubjectSweepCursor }>;

type Source = CandidateVersion & Readonly<{ partition: number; eventId: string; eventIndex: number }>;
type ThreadState = Readonly<{
  realm: string | null;
  thread: string;
  opening: string;
  revision: string;
  board: string;
  kind: 'discussion' | 'review';
  subjects: readonly string[];
  active: boolean;
}>;
type IdentityRow = Readonly<{
  route: number;
  realm: string;
  original: string;
  terminal: string | null;
  identityEpoch: string | null;
  thread: string;
  opening: string;
  revision: string;
  board: string;
  kind: 'discussion' | 'review';
  active: boolean;
}>;

function checkSchema(event: CloudEvent): void {
  const schema = schemas.map((catalogue) => catalogue[event.type]).find((value) => value !== undefined);
  if (!schema || !Value.Check(schema as never, event.data)) throw new TypeError('Invalid Realm Subject source event');
}

function sourceId(event: CloudEvent, data: Record<string, unknown>): string {
  if ([threadCreated, postCreated, postPublished, revisionCreated].includes(event.type as never))
    return String(data.threadId);
  if (event.type === postRestored) return String(data.postId);
  if (event.type === postErased) return String(data.postId);
  if (event.type === takedown || event.type === restored) return String(data.targetId);
  if (event.type === boardCreated) return String(data.boardId);
  const id = data.realmId ?? data.spaceId ?? data.id;
  if (typeof id !== 'string') throw new TypeError('Realm Subject source event has no native subject');
  return id;
}

async function sourceAnchor(pool: Pool, event: CloudEvent, nativeId: string, deadline: number): Promise<Source> {
  const route = realmSubjectRoute(nativeId);
  const source = /^urn:rezics:log:(0|[1-9][0-9]*)\.([1-9][0-9]*)$/.exec(event.source);
  const partition = Number(source?.[1]);
  const epoch = Number(source?.[2]);
  if (
    !source ||
    partition < 0 ||
    partition > 4095 ||
    partition !== partitionOf(route) ||
    !Number.isInteger(epoch) ||
    epoch < 1 ||
    epoch > 2_147_483_647 ||
    !/^[0-9]{19}$/.test(event.sequence) ||
    BigInt(event.sequence) < 1n ||
    BigInt(event.sequence) > maxPosition ||
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(event.id) ||
    event.specversion !== '1.0' ||
    event.datacontenttype !== 'application/json'
  )
    throw new TypeError('Invalid Realm Subject native source envelope');
  const position = BigInt(event.sequence);
  return realmSubjectHome(pool, route, deadline, false, async (client, home) => {
    if (epoch > home.epoch || (epoch === home.epoch && position > BigInt(home.position)))
      throw new TypeError('Realm Subject source is beyond its native home');
    const rows = await readOutboxEvent.run(client, {
      partition_no: partition,
      position,
      epoch,
      id: event.id,
      type: event.type,
      subject: event.subject ?? null,
      data: event.data,
    });
    const row = rows[0];
    if (
      rows.length !== 1 ||
      !row ||
      !Number.isInteger(row.event_seq) ||
      row.event_seq < 0 ||
      !Number.isInteger(row.event_count) ||
      row.event_seq >= row.event_count ||
      row.event_count > 1000
    )
      throw new TypeError('Realm Subject event has no unique native outbox anchor');
    const receipt = await client.query<{ transaction_id: string }>(
      `SELECT transaction_id FROM core.receipt WHERE partition_no=$1 AND epoch=$2 AND position=$3`,
      [partition, epoch, position.toString()],
    );
    if (receipt.rows.length !== 1 || !receipt.rows[0]?.transaction_id)
      throw new TypeError('Realm Subject event has no original transaction receipt');
    return { partition, epoch, position: position.toString(), eventId: event.id, eventIndex: row.event_seq };
  });
}

function currentThreadEvent(event: CloudEvent): boolean {
  return [threadCreated, postCreated, postPublished, revisionCreated, postRestored, postErased, takedown, restored].includes(
    event.type as never,
  );
}

function threadIdFor(event: CloudEvent, data: Record<string, unknown>): string | null {
  if ([threadCreated, postCreated, postPublished, revisionCreated].includes(event.type as never)) {
    if (event.type === postCreated && data.itemId !== data.threadId) return null;
    return String(data.threadId);
  }
  if (event.type === takedown || event.type === restored) {
    if (data.targetKind === 'board') return null;
    if (data.targetKind === 'thread') return String(data.targetId);
    return null;
  }
  if (event.type === postRestored || event.type === postErased) return null;
  return null;
}

async function postThread(pool: Pool, post: string, deadline: number): Promise<string | null> {
  const route = realmSubjectRoute(post);
  const row = await realmSubjectHome(pool, route, deadline, false, async (client) =>
    client.query<{ thread: string }>(`SELECT thread_id AS thread FROM content.post WHERE route=$1 AND post_id=$2`, [route, post]),
  );
  return row.rows[0]?.thread ?? null;
}

async function readThreadState(pool: Pool, thread: string, deadline: number): Promise<ThreadState | null> {
  const route = realmSubjectRoute(thread);
  const result = await realmSubjectHome(pool, route, deadline, false, async (client) =>
    client.query<{
      thread: string;
      opening: string | null;
      board: string;
      kind: 'discussion' | 'review';
      thread_visibility: string;
      thread_availability: string;
      post_visibility: string | null;
      post_availability: string | null;
      post_deleted_at: string | null;
      revision: string | null;
      subjects: string[] | null;
      revision_availability: string | null;
    }>(
      `SELECT t.thread_id AS thread,t.first_post_id AS opening,t.board_id AS board,t.kind,
        t.visibility AS thread_visibility,t.availability AS thread_availability,
        p.visibility AS post_visibility,p.availability AS post_availability,p.deleted_at::text AS post_deleted_at,
        r.revision_id AS revision,r.subject_ids AS subjects,r.availability AS revision_availability
       FROM content.thread t
       LEFT JOIN content.post p ON p.route=t.route AND p.thread_id=t.thread_id AND p.post_id=t.first_post_id
       LEFT JOIN content.revision r ON r.route=t.route AND r.thread_id=t.thread_id
         AND r.post_id=p.post_id AND r.revision_id=p.head_revision_id
       WHERE t.route=$1 AND t.thread_id=$2`,
      [route, thread],
    ),
  );
  const row = result.rows[0];
  if (!row?.opening || !row.revision || !row.subjects) return null;
  const boardRoute = realmSubjectRoute(row.board);
  const board = await realmSubjectHome(pool, boardRoute, deadline, false, async (client) =>
    client.query<{ realm: string | null; visibility: string; purpose: string }>(
      `SELECT realm_id AS realm,visibility,purpose FROM content.board WHERE route=$1 AND board_id=$2`,
      [boardRoute, row.board],
    ),
  );
  const nativeBoard = board.rows[0];
  if (!nativeBoard) return null;
  const purposeMatches =
    (row.kind === 'discussion' && nativeBoard.purpose === 'discussion') ||
    (row.kind === 'review' && nativeBoard.purpose === 'reviews');
  return {
    realm: nativeBoard.realm,
    thread: row.thread,
    opening: row.opening,
    revision: row.revision,
    board: row.board,
    kind: row.kind,
    subjects: row.subjects,
    active:
      purposeMatches &&
      row.thread_visibility === 'published' &&
      row.thread_availability === 'available' &&
      row.post_visibility === 'published' &&
      row.post_availability === 'available' &&
      row.post_deleted_at === null &&
      row.revision_availability === 'available' &&
      nativeBoard.visibility === 'published',
  };
}

async function verifyRevisionAnchor(
  pool: Pool,
  thread: string,
  revision: string,
  transactionId: string,
  deadline: number,
): Promise<void> {
  const route = realmSubjectRoute(thread);
  const rows = await realmSubjectHome(pool, route, deadline, false, async (client) =>
    client.query(
      `SELECT 1 FROM content.revision WHERE route=$1 AND thread_id=$2 AND revision_id=$3
       AND recorded_transaction_id=$4`,
      [route, thread, revision, transactionId],
    ),
  );
  if (rows.rows.length !== 1) throw new TypeError('Realm Subject revision has no original native transaction anchor');
}

function uniqueIds(ids: readonly string[]) {
  return [...new Set(ids)].sort();
}

function chunks<T>(rows: readonly T[], limit: number): T[][] {
  const result: T[][] = [];
  for (let index = 0; index < rows.length; index += limit) result.push(rows.slice(index, index + limit));
  return result;
}

async function enqueueIdentityWork(pool: Pool, work: RealmSubjectIdentityWork, deadline: number): Promise<void> {
  const route = realmSubjectRoute(work.original);
  await realmSubjectHome(pool, route, deadline, true, async (client) => {
    await client.query(
      `INSERT INTO content.realm_subject_identity_work
       (route,source_partition,source_epoch,source_position,event_id,original_id)
       VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT DO NOTHING`,
      [route, work.partition, work.epoch, work.position, work.eventId, work.original],
    );
  });
}

function identityKey(work: RealmSubjectIdentityWork) {
  return `${work.partition}:${work.epoch}:${work.position}:${work.eventId}`;
}

/** Bounded live producer, captured-cut runner and current ancestor observation adapter. */
export function createRealmSubjectLifecycle(input: {
  pool: Pool;
  enqueueIdentity?: (work: RealmSubjectIdentityWork) => Promise<void>;
}) {
  const { pool } = input;
  const candidates = createRealmSubjectCandidates(pool);
  const census = createRealmSubjectCensus(pool);
  const scope = createRealmSubjectScope(pool);

  async function invalidateScope(event: CloudEvent, data: Record<string, unknown>, source: Source, deadline: number) {
    const change = (kind: RealmSubjectScopeChange['kind'], id: unknown) => {
      if (typeof id !== 'string' || routeOf(id) === null) return Promise.resolve(false);
      return scope.invalidate(
        { kind, id, eventId: source.eventId, partition: source.partition, epoch: source.epoch, position: source.position },
        deadline,
      );
    };
    if (event.type === boardCreated || (event.type === takedown && data.targetKind === 'board')) {
      const boardId = String(event.type === boardCreated ? data.boardId : data.targetId);
      const route = realmSubjectRoute(boardId);
      const board = await realmSubjectHome(pool, route, deadline, false, async (client) =>
        client.query<{ realm: string | null }>(
          `SELECT realm_id AS realm FROM content.board WHERE route=$1 AND board_id=$2`,
          [route, boardId],
        ),
      );
      const realm = board.rows[0]?.realm ?? (event.type === boardCreated ? (data.realmId as string | null) : null);
      if (realm) await change('realm-board-set', realm);
      return;
    }
    if (event.type === realmDiscoveryChanged || event.type.startsWith('com.rezics.community.realm.')) {
      await change('realm', data.realmId ?? data.id);
      return;
    }
    if (event.type.startsWith('com.rezics.community.space.')) await change('space', data.spaceId ?? data.id);
  }

  async function refreshThread(event: CloudEvent, data: Record<string, unknown>, source: Source, deadline: number) {
    const thread = threadIdFor(event, data);
    if (!thread) return;
    if (event.type === postRestored || event.type === postErased) return;
    const native = await readThreadState(pool, thread, deadline);
    if (!native?.realm) return;
    if (event.type === threadCreated || event.type === postCreated || event.type === revisionCreated)
      await verifyRevisionAnchor(pool, thread, String(data.revisionId), source.transactionId, deadline);
    const previous = event.type === revisionCreated && Array.isArray(data.previousSubjectIds)
      ? (data.previousSubjectIds as string[])
      : [];
    const originals = uniqueIds([...native.subjects, ...previous]);
    await candidates.initialize(native.realm, deadline);
    if (!(await candidates.fence(native.realm, thread, source, deadline))) return;
    for (const part of chunks(originals, 100)) {
      const mappings = await readIdentityMappings(pool, part);
      const byId = new Map(mappings.map((mapping) => [mapping.original, mapping]));
      for (const original of part) {
        const mapping = byId.get(original);
        const mapped = mapping?.state === 'mapped';
        const candidate: RealmSubjectCandidate = {
          realm: native.realm,
          original,
          terminal: mapped ? mapping.terminal : null,
          identityEpoch: mapped ? mapping.epoch.toString() : null,
          thread,
          opening: native.opening,
          revision: native.revision,
          board: native.board,
          kind: native.kind,
          active: native.active && native.subjects.includes(original),
        };
        await candidates.write(candidate, source, 'live', deadline);
      }
    }
  }

  async function identityPage(work: RealmSubjectIdentityWork, deadline: number): Promise<RealmSubjectIdentityPage> {
    const route = realmSubjectRoute(work.original);
    const stored = await realmSubjectHome(pool, route, deadline, false, async (client) =>
      client.query<{
        after_route: number;
        after_realm_id: string;
        after_thread_id: string;
        complete: boolean;
      }>(
        `SELECT after_route,after_realm_id AS after_realm_id,after_thread_id AS after_thread_id,complete
         FROM content.realm_subject_identity_work
         WHERE route=$1 AND source_partition=$2 AND source_epoch=$3 AND source_position=$4 AND event_id=$5`,
        [route, work.partition, work.epoch, work.position, work.eventId],
      ),
    );
    const state = stored.rows[0];
    if (!state) return { state: 'unknown', after: null };
    if (state.complete) return { state: 'done', after: null };
    const rows = await realmSubjectHome(pool, route, deadline, false, async (client) =>
      client.query<IdentityRow>(
        `SELECT route,realm_id AS realm,original_id AS original,terminal_id AS terminal,
          identity_epoch::text AS "identityEpoch",thread_id AS thread,opening_id AS opening,
          revision_id AS revision,board_id AS board,kind,active
         FROM content.realm_subject_candidate
         WHERE original_id=$1 AND (route,realm_id,thread_id)>($2::integer,$3::uuid,$4::uuid)
         ORDER BY route,realm_id,thread_id LIMIT $5`,
        [work.original, state.after_route, state.after_realm_id, state.after_thread_id, REALM_SUBJECT_IDENTITY_PAGE],
      ),
    );
    if (rows.rows.length === 0) {
      await realmSubjectHome(pool, route, deadline, true, async (client) =>
        client.query(
          `UPDATE content.realm_subject_identity_work SET complete=true
           WHERE route=$1 AND source_partition=$2 AND source_epoch=$3 AND source_position=$4 AND event_id=$5 AND NOT complete`,
          [route, work.partition, work.epoch, work.position, work.eventId],
        ),
      );
      return { state: 'done', after: null };
    }
    const mapping = (await readIdentityMappings(pool, [work.original]))[0];
    const mapped = mapping?.state === 'mapped';
    for (const row of rows.rows) {
      const threadRoute = realmSubjectRoute(row.thread);
      const version = await realmSubjectHome(pool, threadRoute, deadline, false, async (_client, current) => current);
      if (!(await candidates.fence(row.realm, row.thread, version, deadline))) continue;
      await candidates.write(
        {
          ...row,
          terminal: mapped ? mapping.terminal : null,
          identityEpoch: mapped ? mapping.epoch.toString() : null,
        },
        version,
        'live',
        deadline,
      );
    }
    const last = rows.rows.at(-1)!;
    const after = { route: last.route, realm: last.realm, thread: last.thread };
    await realmSubjectHome(pool, route, deadline, true, async (client) => {
      await client.query(
        `UPDATE content.realm_subject_identity_work
         SET after_route=$6,after_realm_id=$7,after_thread_id=$8
         WHERE route=$1 AND source_partition=$2 AND source_epoch=$3 AND source_position=$4 AND event_id=$5 AND NOT complete`,
        [route, work.partition, work.epoch, work.position, work.eventId, after.route, after.realm, after.thread],
      );
    });
    return { state: 'more', after };
  }

  async function sweepCursor(deadline: number): Promise<RealmSubjectSweepCursor> {
    return realmSubjectHome(pool, 0, deadline, true, async (client) => {
      await client.query(`INSERT INTO content.realm_subject_sweep_state(singleton) VALUES(true) ON CONFLICT DO NOTHING`);
      const row = (
        await client.query<{ generation: string; next_route: number; complete: boolean }>(
          `SELECT generation::text,next_route,complete FROM content.realm_subject_sweep_state WHERE singleton=true`,
        )
      ).rows[0]!;
      const state = row.complete ? null : await census.observe(row.next_route, deadline);
      return {
        generation: row.generation,
        route: row.next_route,
        complete: row.complete,
        after: state?.after ?? null,
        ordinal: state?.ordinal ?? 0,
      };
    });
  }

  async function sweep(route: number, limit = REALM_SUBJECT_CENSUS_PAGE, deadline = Date.now() + 30_000): Promise<RealmSubjectSweepPage> {
    if (!Number.isInteger(route) || route < 0 || route >= 65_536 || !Number.isInteger(limit) || limit < 1 || limit > 64)
      throw new RangeError('Invalid Realm Subject census page');
    const before = await sweepCursor(deadline);
    if (before.complete || before.route !== route) return { state: before.complete ? 'complete' : 'retry', next: before };
    const cut = await census.capture(route, deadline);
    let unknown = false;
    for (let step = 0; step < limit; step++) {
      const result = await census.step(route, deadline);
      if (result === 'unknown') {
        unknown = true;
        break;
      }
      if (result === 'exhausted') break;
    }
    const observed = await census.observe(route, deadline);
    if (observed?.exhausted) {
      await realmSubjectHome(pool, 0, deadline, true, async (client) => {
        await client.query(
          `UPDATE content.realm_subject_sweep_state
           SET next_route=next_route+1,complete=(next_route=65535)
           WHERE singleton=true AND next_route=$1 AND generation=$2`,
          [route, before.generation],
        );
      });
      const next = await sweepCursor(deadline);
      return { state: next.complete ? 'complete' : 'more', next };
    }
    const next: RealmSubjectSweepCursor = {
      generation: cut.generation,
      route,
      complete: false,
      after: observed?.after ?? null,
      ordinal: observed?.ordinal ?? 0,
    };
    return { state: unknown ? 'retry' : 'more', next };
  }

  const dimensions = Object.freeze({
    ...zeroScopeWork(),
    nativeRows: 8,
    nativePoints: 6,
    statements: 24,
    bytes: 16_384,
  }) satisfies WorkDimensions;
  const maintenance: RealmSubjectMaintenance = {
    bounds: { observe: dimensions, current: dimensions },
    async observe(realm, coverage, context) {
      context.work.consume(dimensions);
      if (coverage.unresolved !== '0') return null;
      const sweep = await sweepCursor(context.reader.deadline);
      if (!sweep.complete) return null;
      const pending = await pool.query(
        `SELECT 1 FROM core.history_event_consumer
         WHERE consumer=$1 AND state='open' LIMIT 1`,
        [REALM_SUBJECT_LIFECYCLE_EFFECT],
      );
      if (pending.rows.length) return null;
      const identities = await pool.query('SELECT 1 FROM content.realm_subject_identity_work WHERE NOT complete LIMIT 1');
      if (identities.rows.length) return null;
      const ancestor = await scope.observe(realm, context.reader.deadline);
      if (!ancestor) return null;
      return createHash('sha256')
        .update(JSON.stringify([coverage, sweep.generation, ancestor]))
        .digest('hex');
    },
    async current(realm, coverage, token, context) {
      context.work.consume(dimensions);
      if (coverage.unresolved !== '0') return 'unavailable';
      const sweep = await sweepCursor(context.reader.deadline);
      if (!sweep.complete) return 'unavailable';
      const pending = await pool.query(
        `SELECT 1 FROM core.history_event_consumer
         WHERE consumer=$1 AND state='open' LIMIT 1`,
        [REALM_SUBJECT_LIFECYCLE_EFFECT],
      );
      if (pending.rows.length) return 'unavailable';
      const identities = await pool.query('SELECT 1 FROM content.realm_subject_identity_work WHERE NOT complete LIMIT 1');
      if (identities.rows.length) return 'unavailable';
      const ancestor = await scope.observe(realm, context.reader.deadline);
      if (!ancestor) return 'unavailable';
      const current = createHash('sha256')
        .update(JSON.stringify([coverage, sweep.generation, ancestor]))
        .digest('hex');
      return current === token ? 'current' : 'changed';
    },
  };

  const effect: Effect = {
    name: REALM_SUBJECT_LIFECYCLE_EFFECT,
    types: [...contentSourceTypes, ...communitySourceTypes, ...identitySourceTypes],
    async run(event) {
      checkSchema(event);
      const data = event.data as Record<string, unknown>;
      const nativeId = sourceId(event, data);
      const source = await sourceAnchor(pool, event, nativeId, Date.now() + 30_000);
      // Opening candidates are sourced from the committed thread/post/revision, never the event projection.
      if (currentThreadEvent(event)) await refreshThread(event, data, source, Date.now() + 30_000);
      await invalidateScope(event, data, source, Date.now() + 30_000);
      if (identitySourceTypes.includes(event.type as (typeof identitySourceTypes)[number])) {
        const isIdentityRevision = event.type === SUBJECT_MERGED || data.kind === 'identity' || data.kind === 'merge';
        if (isIdentityRevision) {
          const work: RealmSubjectIdentityWork = {
            original: String(data.id),
            partition: source.partition,
            epoch: source.epoch,
            position: source.position,
            eventId: source.eventId,
          };
          await enqueueIdentityWork(pool, work, Date.now() + 30_000);
          await input.enqueueIdentity?.(work);
        }
      }
    },
  };

  return { effect, maintenance, scope, sweep, sweepCursor, identityPage, identityKey };
}

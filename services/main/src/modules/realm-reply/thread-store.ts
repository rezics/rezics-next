import type { Pool } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { controlRead } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { RealmReplyInvalid } from './content-store.ts';
import { REALM_THREAD_COST } from './thread-contract.ts';
import { disclosurePoolReader, discloseInventory, DISCLOSURE_COST } from '../disclosure/read.ts';
import { currentDisclosureViewer } from '../disclosure/viewer.ts';
import {
  ensureRealmHistoryPopulation,
  realmRankPage,
  type RealmRankKey,
} from '../rankings/realm-threads.ts';
import type { RealmHistoryFloor } from '../realm-admin/history.ts';
import type { WorkReadSession } from '../work/read-session.ts';
import { WorkReadUnavailable } from '../work/read-session.ts';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

/** A reply identity as Content keeps it: who wrote it, under which parent and root. */
export interface ThreadNode {
  reply: string; parent: string | null; author: string; origin: string | null;
  rootTarget: string; rootRevision: string; createdAt: Date;
  /** The depth boundary has children outside this bounded walk. */
  truncated?: boolean;
}
/** One Realm placement head a read admits: its exact revision, review decision and pinned preparation. */
export interface PlacedHead { reply: string; revisionId: string; reviewDecisionId: string; preparationId: string }
/** A placement's standing in Home's vote projection; closed where the projection has no votable activity. */
export interface ThreadVote { score: number; value: -1 | 0 | 1; revision: string | null; open: boolean }
/** Ascending seek tuple; the saved key survives removal of its anchor. */
export interface ThreadSiblingKey { rank: number; time: string; placement: string }
export interface ThreadSibling extends ThreadSiblingKey { reply: string; hasChildren: boolean }

// The same approval, supersession, pin and live-draft rules as
// `RealmReplyContentStore.currentReview`, over a batch in one statement.
const approved = (realm: string, reply: string, revision: string, review: string | null, preparation: string | null) => `
  EXISTS (SELECT 1 FROM content.reply p
    JOIN content.variant v ON v.id = p.variant_id
    JOIN content.revision head ON head.id = v.draft_head AND head.availability = 'available'
      AND head.body->>'deleted' = 'false'
    JOIN content.realm_review_decision d ON d.variant_id = p.variant_id
    JOIN content.revision r ON r.variant_id = d.variant_id AND r.id = d.revision_id
    WHERE p.id = ${reply} AND d.realm = ${realm} AND d.outcome = 'approved' AND r.availability = 'available'
      AND (p.origin_realm IS NULL OR p.origin_realm = ${realm})
      AND ${revision === 'any' ? 'TRUE' : `d.revision_id = ${revision}`}
      ${review ? `AND d.id = ${review}` : ''}
      AND EXISTS (SELECT 1 FROM content.realm_placement_preparation placement
        JOIN content.publication_preparation publication ON publication.operation_id = placement.operation_id
        WHERE ${preparation ? `placement.operation_id = ${preparation} AND` : ''} placement.realm = d.realm
          AND placement.variant_id = p.variant_id AND placement.revision_id = d.revision_id
          AND placement.review_decision_id = d.id
          AND publication.status = 'active' AND publication.pin_active)
      AND NOT EXISTS (SELECT 1 FROM content.realm_review_decision later WHERE later.supersedes = d.id))`;

/**
 * The Content and Home-projection reads behind Realm threads. Sibling pages
 * seek the existing projection; Content identities and admission take bounded
 * batches. Ancestors stop at a fixed height and the legacy subtree walk at its
 * candidate limit, whatever the thread's size.
 * Counts add at most 21 Access disclosure batches for 20 × 64 + 1 candidates.
 */
export class RealmReplyThreadStore {
  constructor(private readonly content: Pool, private readonly access: Pool) {}

  /** Content source inventory for the existing bounded background projector. */
  get rankingContent() {
    return this.content;
  }
  /** Source readiness is checked before and after a window; an incomplete projection is never an empty branch. */
  async assertThreadProjection(session: WorkReadSession): Promise<void> {
    const source = (await this.content.query<{ data_epoch: string; sequence: string }>(
      'SELECT data_epoch::text,sequence::text FROM content.owner_control WHERE singleton')).rows[0];
    if (!source) throw new WorkReadUnavailable('Thread source is unavailable');
    const ready = (await this.access.query<{ ready: boolean }>(`SELECT f.open AND
      c.content_epoch=$2::uuid AND c.content_sequence=$3::bigint AND c.sequence=$4::numeric
      AND c.after_event='￿'
      AND NOT EXISTS(SELECT 1 FROM access.feed_item WHERE data_epoch=$1
        AND kind IN ('reply','discussion') AND NOT realm_thread_indexed LIMIT 1)
      AND COALESCE((SELECT false FROM access.realm_thread_dirty WHERE data_epoch=$1 AND kind<>'population'
        ORDER BY kind,resource LIMIT 1),true)
      AS ready FROM access.recovery_fence f
      LEFT JOIN access.realm_thread_checkpoint c ON c.data_epoch=$1 WHERE f.id`,
    [session.position.dataEpoch, source.data_epoch, source.sequence, session.position.sequence])).rows[0];
    if (!ready?.ready) throw new WorkReadUnavailable('Realm replies are projecting');
  }

  /** One parent index range, at most limit+1 candidates and one exact child probe per candidate. */
  async siblingPage(epoch: string, realm: string, parent: string, sort: 'best' | 'new' | 'top',
    limit: number, after?: ThreadSiblingKey, includeInactive = false): Promise<ThreadSibling[]> {
    if (!native.test(realm) || !native.test(parent) || !Number.isInteger(limit)
      || limit < 1 || limit > REALM_THREAD_COST.replies
      || after && (!Number.isFinite(after.rank) || !/^-?\d+$/.test(after.time) || !native.test(after.placement))) {
      throw new RealmReplyInvalid('Invalid sibling page');
    }
    const rank = sort === 'best' ? 'access.realm_reply_best(r.score,r.placement)'
      : sort === 'top' ? '-r.score::double precision' : '0::double precision';
    const time = '-access.realm_reply_time(r.placement)';
    const key = sort === 'new' ? `${time},r.placement COLLATE "C"` : `${rank},${time},r.placement COLLATE "C"`;
    const seek = sort === 'new' ? '$5::bigint,$6::text COLLATE "C"'
      : '$4::double precision,$5::bigint,$6::text COLLATE "C"';
    const rows = await this.access.query<{ reply: string; rank: number; time: string;
      placement: string; has_children: boolean }>(`WITH parameters AS
      (SELECT $4::double precision AS rank,$5::bigint AS time,$6::text AS placement)
      SELECT r.reply,r.placement,${rank} AS rank,(${time})::text AS time,
      COALESCE((SELECT true FROM access.realm_thread_reference c WHERE c.data_epoch=$1 AND c.realm=$2
        AND c.parent=r.reply ${includeInactive ? '' : 'AND c.active'}
        ORDER BY -access.realm_reply_time(c.placement),c.placement COLLATE "C" LIMIT 1),false) AS has_children
      FROM access.realm_thread_reference r WHERE r.data_epoch=$1 AND r.realm=$2 AND r.parent=$3
      ${includeInactive ? '' : 'AND r.active'}
      ${after ? `AND (${key}) > (${seek})` : ''}
      ORDER BY ${key} LIMIT $7`, [epoch, realm, parent, after?.rank ?? null,
        after?.time ?? null, after?.placement ?? '', limit + 1]);
    return rows.rows.map(row => ({ reply: row.reply, placement: row.placement, rank: row.rank,
      time: row.time, hasChildren: row.has_children }));
  }

  /** Immutable Content identities for only the chosen window, including its focus. */
  async identities(replies: readonly string[]): Promise<ThreadNode[]> {
    if (replies.length > REALM_THREAD_COST.replies + 1 || replies.some(reply => !native.test(reply))) {
      throw new RealmReplyInvalid('Invalid thread identity batch');
    }
    const rows = await this.content.query<{ reply: string; parent: string | null; author: string;
      origin: string | null; root_target: string; root_revision: string; created_at: Date }>(`
      SELECT id AS reply,parent_reply AS parent,author,origin_realm AS origin,root_target,root_revision,created_at
      FROM content.reply WHERE id=ANY($1::text[])`, [[...replies]]);
    return rows.rows.map(node);
  }
  /** The projector resolves the opening discussion beyond the request's ancestor bound. */
  async focusBasis(epoch: string, realm: string, focus: string): Promise<{ thread: string; active: boolean } | null> {
    if (!native.test(realm) || !native.test(focus)) throw new RealmReplyInvalid('Invalid thread focus');
    return (await this.access.query<{ thread: string; active: boolean }>(`SELECT thread,active FROM access.realm_thread_reference
      WHERE data_epoch COLLATE "C"=$1 AND realm COLLATE "C"=$2 AND reply COLLATE "C"=$3`,
    [epoch, realm, focus])).rows[0] ?? null;
  }
  /** At most one indexed row per explored parent; scores never require a sibling population scan. */
  async siblingOrderRevisions(epoch: string, realm: string, parents: readonly string[]): Promise<Map<string, string>> {
    if (!native.test(realm) || parents.length > REALM_THREAD_COST.replies + 1
      || parents.some(parent => !native.test(parent))) throw new RealmReplyInvalid('Invalid sibling order batch');
    if (!parents.length) return new Map();
    const rows = await this.access.query<{ reply: string; revision: string }>(`SELECT reply,sibling_rank_revision::text AS revision
      FROM access.realm_thread_reference WHERE data_epoch COLLATE "C"=$1 AND realm COLLATE "C"=$2
        AND reply COLLATE "C"=ANY($3::text[])`,
    [epoch, realm, [...parents]]);
    return new Map(rows.rows.map(row => [row.reply, row.revision]));
  }
  rankedPage(
    session: WorkReadSession,
    realm: string,
    sort: 'best' | 'top',
    period: 'week' | 'month' | 'all',
    limit: number,
    after?: RealmRankKey & { revision: string },
    population?: string,
  ) {
    return realmRankPage(this.access, session, realm, sort, period, limit, after, population);
  }
  historyPopulation(epoch: string, realm: string, floor: RealmHistoryFloor) {
    return ensureRealmHistoryPopulation(this.access, epoch, realm, floor);
  }
  async rankedHistoryAdmission(
    epoch: string,
    realm: string,
    population: string,
    replies: readonly string[],
  ) {
    if (replies.length > DISCLOSURE_COST.batch)
      throw new RealmReplyInvalid('Invalid ranked history batch');
    const rows = await this.access.query<{ reply: string; }>(
      `SELECT reply FROM access.realm_thread_population_admission
      WHERE data_epoch=$1 AND realm=$2 AND population=$3 AND reply=ANY($4::text[]) AND admitted`,
      [epoch, realm, population, [...replies]],
    );
    return new Set(rows.rows.map((row) => row.reply));
  }
  async rankingRevision(epoch: string, realm: string): Promise<string> {
    return (
      (
        await this.access.query<{ revision: string }>(
          `SELECT COALESCE(s.revision,0)::text AS revision
      FROM access.recovery_fence f LEFT JOIN access.realm_thread_state s ON s.data_epoch=$1 AND s.realm=$2
      WHERE f.id AND f.open`,
          [epoch, realm],
        )
      ).rows[0]?.revision ?? 'unavailable'
    );
  }

  /** One author's newest Realm replies; a caller must still admit each current placement. */
  async authorPage(author: string, kind: 'posts' | 'comments', limit: number,
    before?: { time: string; reply: string }): Promise<ThreadNode[]> {
    if (!native.test(author) || !Number.isInteger(limit) || limit < 1 || limit > 9
      || before && (!native.test(before.reply) || Number.isNaN(Date.parse(before.time)))) {
      throw new RealmReplyInvalid('invalid author page');
    }
    const rows = await this.content.query<{ reply: string; parent: string | null; author: string;
      origin: string | null; root_target: string; root_revision: string; created_at: Date }>(`
      SELECT id AS reply, parent_reply AS parent, author, origin_realm AS origin,
        root_target, root_revision, created_at FROM content.reply
      WHERE author = $1 AND origin_realm IS NOT NULL
        AND parent_reply IS ${kind === 'posts' ? 'NULL' : 'NOT NULL'}
        AND ($2::timestamptz IS NULL OR (created_at, id) < ($2::timestamptz, $3::text))
      ORDER BY created_at DESC, id DESC LIMIT $4`,
    [author, before?.time ?? null, before?.reply ?? '', limit]);
    return rows.rows.map(node);
  }

  /** The focused reply and its descendants, breadth first; one row past `limit` means more exist. */
  async subtree(focus: string, limit: number = REALM_THREAD_COST.replies + 1): Promise<ThreadNode[]> {
    if (!native.test(focus) || !Number.isInteger(limit) || limit < 1 || limit > REALM_THREAD_COST.replies + 1) {
      throw new RealmReplyInvalid('invalid thread read');
    }
    // No ORDER BY: the outer LIMIT stops the recursive walk once it has enough rows.
    const rows = await this.content.query<{ reply: string; parent: string | null; author: string; origin: string | null;
      root_target: string; root_revision: string; created_at: Date; truncated: boolean }>(`WITH RECURSIVE tree AS (
        SELECT id, parent_reply, author, origin_realm, root_target, root_revision, created_at, 0 AS depth
          FROM content.reply WHERE id = $1
        UNION ALL
        SELECT c.id, c.parent_reply, c.author, c.origin_realm, c.root_target, c.root_revision, c.created_at, t.depth + 1
          FROM tree t JOIN content.reply c ON c.parent_reply = t.id WHERE t.depth < $2
      ) SELECT id AS reply, parent_reply AS parent, author, origin_realm AS origin, root_target, root_revision,
        created_at, depth = $2 AND EXISTS(SELECT 1 FROM content.reply child
          WHERE child.parent_reply = tree.id) AS truncated
        FROM tree LIMIT $3`, [focus, REALM_THREAD_COST.depth, limit + 1]);
    return rows.rows.map(row => ({ ...node(row), truncated: row.truncated }));
  }

  /** The focused reply's parents, nearest first, up to a fixed height. */
  async ancestors(focus: string): Promise<ThreadNode[]> {
    if (!native.test(focus)) throw new RealmReplyInvalid('invalid thread read');
    const rows = await this.content.query<{ reply: string; parent: string | null; author: string; origin: string | null;
      root_target: string; root_revision: string; created_at: Date }>(`WITH RECURSIVE up AS (
        SELECT p.id, p.parent_reply, p.author, p.origin_realm, p.root_target, p.root_revision, p.created_at, 1 AS height
          FROM content.reply c JOIN content.reply p ON p.id = c.parent_reply WHERE c.id = $1
        UNION ALL
        SELECT p.id, p.parent_reply, p.author, p.origin_realm, p.root_target, p.root_revision, p.created_at, u.height + 1
          FROM up u JOIN content.reply p ON p.id = u.parent_reply WHERE u.height < $2
      ) SELECT id AS reply, parent_reply AS parent, author, origin_realm AS origin, root_target, root_revision,
        created_at FROM up ORDER BY height`, [focus, REALM_THREAD_COST.ancestors]);
    return rows.rows.map(node);
  }

  /** Which placement heads Content still approves in the Realm, with each reply's identity. */
  async admitted(realm: string, heads: readonly PlacedHead[]): Promise<Map<string, ThreadNode>> {
    if (!native.test(realm) || heads.length > REALM_THREAD_COST.cohort
      + REALM_THREAD_COST.replies + REALM_THREAD_COST.ancestors
      || heads.some(head => !native.test(head.reply) || !uuid.test(head.revisionId)
        || !uuid.test(head.reviewDecisionId) || !head.preparationId || head.preparationId.length > 300)) {
      throw new RealmReplyInvalid('invalid thread admission');
    }
    if (!heads.length) return new Map();
    const rows = await this.content.query<{ reply: string; parent: string | null; author: string;
      origin: string | null; root_target: string; root_revision: string; created_at: Date }>(`
      SELECT c.id AS reply, c.parent_reply AS parent, c.author, c.origin_realm AS origin, c.root_target,
        c.root_revision, c.created_at
      FROM unnest($2::text[], $3::uuid[], $4::uuid[], $5::text[]) AS x(reply, revision_id, review_id, preparation_id)
      JOIN content.reply c ON c.id = x.reply
      WHERE ${approved('$1', 'x.reply', 'x.revision_id', 'x.review_id', 'x.preparation_id')}`,
    [realm, heads.map(head => head.reply), heads.map(head => head.revisionId),
      heads.map(head => head.reviewDecisionId), heads.map(head => head.preparationId)]);
    return new Map(rows.rows.map(row => [row.reply, node(row)]));
  }

  /**
   * How many approved, placed replies sit under each thread, counting down to
   * the fixed depth. The walk stops after a fixed total; when it does, every
   * count is a lower bound.
   */
  async counts(realm: string, threads: readonly string[], historyAdmission?: (replies: readonly string[]) => Promise<ReadonlySet<string>>): Promise<{ counts: Map<string, number>; complete: boolean }> {
    if (!native.test(realm) || threads.length > REALM_THREAD_COST.pageSize || threads.some(id => !native.test(id))) {
      throw new RealmReplyInvalid('invalid thread count');
    }
    const counts = new Map(threads.map(id => [id, 0]));
    if (!threads.length) return { counts, complete: true };
    const limit = threads.length * REALM_THREAD_COST.countPerThread;
    const rows = await this.content.query<{ thread: string; id: string; parent_reply: string; root_target: string; visible: boolean; truncated: boolean }>(`WITH RECURSIVE tree AS (
        SELECT r.id AS thread, c.id, 1 AS depth FROM unnest($2::text[]) AS r(id)
          JOIN content.reply c ON c.parent_reply = r.id
        UNION ALL
        SELECT t.thread, c.id, t.depth + 1 FROM tree t JOIN content.reply c ON c.parent_reply = t.id
          WHERE t.depth < $3
      ), walked AS MATERIALIZED (SELECT thread, id, depth FROM tree LIMIT $4)
      SELECT thread, walked.id, reply.parent_reply, reply.root_target,
        walked.depth = $3 AND EXISTS(SELECT 1 FROM content.reply child
          WHERE child.parent_reply = walked.id) AS truncated,
        ${approved('$1', 'walked.id', 'any', null, null)} AS visible FROM walked
        JOIN content.reply reply ON reply.id = walked.id`,
    [realm, [...threads], REALM_THREAD_COST.depth, limit + 1]);
    const reader = disclosurePoolReader(this.access);
    const candidates = rows.rows.filter(row => row.visible);
    const eligible = new Set<string>();
    if (historyAdmission) for (let offset = 0; offset < candidates.length; offset += DISCLOSURE_COST.batch) {
      const admitted = await historyAdmission(candidates.slice(offset,offset + DISCLOSURE_COST.batch).map(row => row.id));
      for (const id of admitted) eligible.add(id);
    }
    const byId = new Map(candidates.map(row => [row.id,row]));
    const readableChain = (id: string, seen = new Set<string>()): boolean => {
      if (threads.includes(id)) return true;
      const row = byId.get(id);
      if (!row || seen.has(id) || !eligible.has(id)) return false;
      seen.add(id);
      return readableChain(row.parent_reply,seen);
    };
    for (let offset = 0; offset < candidates.length; offset += DISCLOSURE_COST.batch) {
      const page = candidates.slice(offset, offset + DISCLOSURE_COST.batch);
      const targets = page.map(row => ({ owner: 'content' as const, resource: row.id,
        component: 'body' as const, work: row.root_target, context: realm }));
      const decisions = !reader ? page.map(() => 'visible') : reader.environment
        ? await discloseInventory(reader.environment, targets, currentDisclosureViewer(), 'count')
        : await reader.read(targets, currentDisclosureViewer(), 'count');
      page.forEach((row, index) => {
        if (decisions[index] === 'visible' && (!historyAdmission || readableChain(row.id))) counts.set(row.thread, (counts.get(row.thread) ?? 0) + 1);
      });
    }
    return { counts, complete: rows.rows.length <= limit && !rows.rows.some(row => row.truncated) };
  }

  /**
   * Scores and the reader's votes from Home's projection, where each placement
   * is a feed activity. Only a group's leading activity takes votes there, so
   * a grouped reply shows its score with voting closed. Read-only; Home's feed
   * owns these rows.
   */
  async votes(dataEpoch: string, placements: readonly string[],
    reader?: { principal: VerifiedPrincipal; agent: string }): Promise<Map<string, ThreadVote>> {
    if (placements.length > REALM_THREAD_COST.cohort + REALM_THREAD_COST.replies + REALM_THREAD_COST.ancestors
      || placements.some(id => !native.test(id))) throw new RealmReplyInvalid('invalid vote read');
    if (!placements.length) return new Map();
    return controlRead(this.access, async client => {
      const owner = reader ? await followPrincipal(client, reader.principal, reader.agent) : null;
      const rows = await client.query<{ id: string; score: number; group_leader: boolean; value: -1 | 0 | 1 | null;
        revision: string | null }>(`SELECT i.id, i.score, i.group_leader, v.value, v.revision
        FROM access.feed_item i LEFT JOIN access.feed_vote v ON v.target = i.id AND v.principal_id = $3
        WHERE i.data_epoch = $1 AND i.id = ANY($2::text[])`, [dataEpoch, [...placements], owner]);
      return new Map(rows.rows.map(row => [row.id, { score: row.score, value: row.value ?? 0,
        revision: row.revision, open: row.group_leader }]));
    });
  }
}

function node(row: { reply: string; parent: string | null; author: string; origin: string | null;
  root_target: string; root_revision: string; created_at: Date }): ThreadNode {
  return { reply: row.reply, parent: row.parent, author: row.author, origin: row.origin,
    rootTarget: row.root_target, rootRevision: row.root_revision, createdAt: row.created_at };
}

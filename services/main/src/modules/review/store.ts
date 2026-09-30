import { createHash, randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { ControlConflict, ControlDenied, ControlInvalid, ControlStale, controlTransaction } from '../access/topology-control.ts';
import { followPrincipal } from '../follows/authority.ts';
import { WorkReadMoved } from '../work/read-session.ts';
import { REVIEW_COST } from './contract.ts';

const ID = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const KEY = /^[A-Za-z0-9:_./-]{1,128}$/;
const LANGUAGE = /^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$/;
const hash = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('hex');

export interface ReviewRow { id: string; principal_id: string; acting_subject: string;
  context: string; realm: string | null; work: string; main_version: string | null;
  rating_observation: string | null; rating_revision: string | null; rating: number | null;
  language: string; body: string; spoiler: boolean; started_on: string | null;
  finished_on: string | null; revision: string; deleted: boolean; helpful_count: number;
  created_at: Date; updated_at: Date; viewer_helpful?: boolean; viewer_vote_revision?: string | null }
export interface ReviewIntent { actingSubject: string; context: string; work: string;
  expectedRevision: string | null; language: string; text: string; spoiler: boolean; rating?: number | null }
export interface RatingLink { mainVersion: string | null; observation: string; revision: string;
  value: number; realm: string | null }
export interface ReviewReceipt { profile: 'reader-review-receipt-v1'; review: string;
  revision: string; deleted: boolean; replayed: boolean }
export interface HelpfulReceipt { profile: 'reader-review-helpful-receipt-v1'; review: string;
  revision: string; helpful: boolean; helpfulCount: number; replayed: boolean }
export interface ReviewPageQuery { context: string; work: string; sort: 'new' | 'helpful';
  language?: string; rating?: number; limit: number; ownPrincipal?: string;
  after?: { count: number; time: string; id: string } }
export interface ReviewEvent { sequence: string; id: string; review: string; revision: string;
  kind: 'created' | 'edited' | 'deleted' | 'helpful-changed';
  context: string; work: string; realm: string | null; occurredAt: string }

export function validateReviewIntent(input: ReviewIntent, key: string) {
  if (![input.actingSubject, input.context, input.work].every(value => ID.test(value))
    || !KEY.test(key) || input.expectedRevision !== null && !UUID.test(input.expectedRevision)
    || !LANGUAGE.test(input.language) || input.language.length > 35
    || input.rating != null && (!Number.isInteger(input.rating) || input.rating < 1 || input.rating > 10)
    || input.text.length < 1 || input.text.length > REVIEW_COST.textChars
    || input.text.trim().length === 0 || input.text !== input.text.normalize('NFC')
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/u.test(input.text)) {
    throw new ControlInvalid('Invalid review command');
  }
}

const rowColumns = `r.*, r.started_on::text AS started_on, r.finished_on::text AS finished_on`;
/** A component fence covers every revision. An exact fence covers only its
 * named revision; writers cannot edit a fenced current head to escape it. */
export const reviewVisibleSql = `NOT EXISTS (SELECT 1 FROM access.governance_enforcement e
  WHERE e.owner = 'review' AND e.resource = r.id::text AND e.component = 'body'
    AND e.state = 'restricted' AND e.effect IN ('disclosure','publication')
    AND (e.revision IS NULL OR e.revision = r.revision::text)
    AND e.context IN ('urn:rezics:context:global', r.context, r.realm))`;
async function bumpCollection(client: PoolClient, context: string, work: string) {
  await client.query(`INSERT INTO access.reader_review_collection (context, work) VALUES ($1,$2)
    ON CONFLICT (context, work) DO UPDATE SET revision = gen_random_uuid()`, [context, work]);
}
async function receipt<T>(client: PoolClient, owner: string, key: string, intent: unknown): Promise<T | null> {
  const row = (await client.query<{ request_digest: string; result: T }>(`
    SELECT request_digest, result FROM access.reader_review_receipt
    WHERE principal_id = $1 AND idempotency_key = $2`, [owner, key])).rows[0];
  if (!row) return null;
  if (row.request_digest !== hash(intent)) throw new ControlConflict('Idempotency key has another review intent');
  return row.result;
}
async function saveReceipt(client: PoolClient, owner: string, key: string, intent: unknown,
  result: ReviewReceipt | HelpfulReceipt) {
  await client.query(`INSERT INTO access.reader_review_receipt
    (principal_id, idempotency_key, request_digest, result) VALUES ($1,$2,$3,$4)`,
  [owner, key, hash(intent), result]);
}
async function lockKey(client: PoolClient, kind: string, ...parts: string[]) {
  await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))',
    [JSON.stringify([kind, ...parts])]);
}

/** Access owns the person slot, revision CAS, helpful count and receipt in one
 * transaction. Rating remains a separate graph owner and is proven under the
 * locked Access inventory head before a review is admitted. */
export class ReaderReviews {
  constructor(private readonly pool: Pool) {}

  async write(principal: VerifiedPrincipal, input: ReviewIntent, key: string,
    proveRating: (head: { mainVersion: string | null; observation: string; revision: string },
      principalId: string) => Promise<RatingLink>,
    shelfDates: { startedOn: string | null; finishedOn: string | null },
    target: { mainVersion: string | null; realm: string | null; generic: boolean }): Promise<ReviewReceipt> {
    validateReviewIntent(input, key);
    const intent = { kind: 'set', ...input };
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, input.actingSubject);
      await lockKey(client, 'review-key', owner, key);
      const replay = await receipt<ReviewReceipt>(client, owner, key, intent);
      if (replay) return { ...replay, replayed: true };
      await lockKey(client, 'review-slot', owner, input.context, input.work);
      const prior = (await client.query<ReviewRow>(`SELECT ${rowColumns} FROM access.reader_review r
        WHERE principal_id = $1 AND context = $2 AND work = $3 FOR UPDATE`,
      [owner, input.context, input.work])).rows[0];
      if ((prior?.revision ?? null) !== input.expectedRevision) throw new ControlStale('Review changed');
      if (prior && !(await client.query(`SELECT 1 FROM access.reader_review r
        WHERE r.id = $1 AND ${reviewVisibleSql}`, [prior.id])).rowCount) {
        throw new ControlDenied('Review is restricted');
      }
      let linked: RatingLink | null = null;
      // Omission preserves a live review's retained evidence; null clears it.
      // A new or revived review with no supplied score remains unscored.
      if (input.rating === undefined && prior && !prior.deleted && prior.rating !== null) {
        linked = { mainVersion: prior.main_version, observation: prior.rating_observation!,
          revision: prior.rating_revision!, value: prior.rating, realm: prior.realm };
      }
      if (input.rating != null) {
        const head = (await client.query<{ main_version: string | null; observation: string; revision: string }>(target.generic ? `
          SELECT NULL AS main_version, h.observation, h.revision
          FROM access.target_rating_head h JOIN access.admission a ON a.id = h.admission_id
          WHERE h.principal_id = $1 AND h.context = $2 AND h.target = $3
            AND a.state = 'sealed' AND a.graph_outcome = 'succeeded' LIMIT 2 FOR SHARE OF h` : `
          SELECT h.main_version, h.observation, h.revision
          FROM access.rating_aggregate_head h JOIN access.admission a ON a.id = h.admission_id
          WHERE h.principal_id = $1 AND h.context = $2 AND h.work = $3
            AND h.target_release IS NULL AND a.state = 'sealed' AND a.graph_outcome = 'succeeded'
          LIMIT 2 FOR SHARE OF h`, [owner, input.context, input.work])).rows;
        if (head.length !== 1) throw new ControlDenied('An available standing rating is required');
        linked = await proveRating({ mainVersion: head[0]!.main_version,
          observation: head[0]!.observation, revision: head[0]!.revision }, owner);
        if (linked.mainVersion !== head[0]!.main_version || linked.observation !== head[0]!.observation
          || linked.revision !== head[0]!.revision || !Number.isInteger(linked.value)
          || linked.value !== input.rating || linked.realm !== target.realm
          || linked.value < 1 || linked.value > 10) throw new ControlDenied('Rating link changed');
      }
      const revision = randomUUID();
      let id: string;
      if (prior) {
        id = prior.id;
        if (prior.deleted) await client.query('DELETE FROM access.reader_review_vote WHERE review_id = $1', [id]);
        await client.query(`UPDATE access.reader_review SET acting_subject = $2, main_version = $3,
          rating_observation = $4, rating_revision = $5, rating = $6, realm = $7,
          language = $8, body = $9, spoiler = $10, started_on = $11, finished_on = $12,
          revision = $13, deleted = false, helpful_count = CASE WHEN deleted THEN 0 ELSE helpful_count END,
          created_at = CASE WHEN deleted THEN clock_timestamp() ELSE created_at END,
          updated_at = clock_timestamp() WHERE id = $1`,
        [id, input.actingSubject, target.mainVersion, linked?.observation ?? null, linked?.revision ?? null,
          linked?.value ?? null, target.realm, input.language, input.text, input.spoiler,
          shelfDates.startedOn, shelfDates.finishedOn, revision]);
      } else {
        id = randomUUID();
        await client.query(`INSERT INTO access.reader_review
          (id, principal_id, acting_subject, context, realm, work, main_version,
           rating_observation, rating_revision, rating, language, body, spoiler,
           started_on, finished_on, revision)
          VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,$12,$13,$14,$15,$16)`,
        [id, owner, input.actingSubject, input.context, target.realm, input.work,
          target.mainVersion, linked?.observation ?? null, linked?.revision ?? null, linked?.value ?? null,
          input.language, input.text, input.spoiler, shelfDates.startedOn, shelfDates.finishedOn, revision]);
      }
      await client.query(`INSERT INTO access.reader_review_revision
        (review_id, revision, acting_subject, rating_observation, rating_revision,
         rating, language, body, spoiler, started_on, finished_on, deleted)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,false)`,
      [id, revision, input.actingSubject, linked?.observation ?? null, linked?.revision ?? null,
        linked?.value ?? null, input.language, input.text, input.spoiler,
        shelfDates.startedOn, shelfDates.finishedOn]);
      await bumpCollection(client, input.context, input.work);
      await client.query(`INSERT INTO access.reader_review_event (review_id, revision, kind)
        VALUES ($1,$2,$3)`, [id, revision, !prior || prior.deleted ? 'created' : 'edited']);
      const result: ReviewReceipt = { profile: 'reader-review-receipt-v1', review: id,
        revision, deleted: false, replayed: false };
      await saveReceipt(client, owner, key, intent, result);
      return result;
    });
  }

  async delete(principal: VerifiedPrincipal, review: string, actingSubject: string,
    expectedRevision: string, key: string): Promise<ReviewReceipt> {
    if (!UUID.test(review) || !ID.test(actingSubject) || !UUID.test(expectedRevision) || !KEY.test(key)) {
      throw new ControlInvalid('Invalid review deletion');
    }
    const intent = { kind: 'delete', review, actingSubject, expectedRevision };
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, actingSubject);
      await lockKey(client, 'review-key', owner, key);
      const replay = await receipt<ReviewReceipt>(client, owner, key, intent);
      if (replay) return { ...replay, replayed: true };
      const row = (await client.query<ReviewRow>(`SELECT ${rowColumns} FROM access.reader_review r
        WHERE id = $1 FOR UPDATE`, [review])).rows[0];
      if (!row || row.principal_id !== owner || row.deleted) throw new ControlDenied('Review is unavailable');
      if (row.revision !== expectedRevision) throw new ControlStale('Review changed');
      const revision = randomUUID();
      await client.query('UPDATE access.reader_review SET deleted = true, revision = $2, updated_at = clock_timestamp() WHERE id = $1',
        [review, revision]);
      await client.query(`INSERT INTO access.reader_review_revision
        (review_id, revision, acting_subject, rating_observation, rating_revision,
         rating, language, body, spoiler, started_on, finished_on, deleted)
        VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$11,true)`,
      [review, revision, row.acting_subject, row.rating_observation, row.rating_revision,
        row.rating, row.language, row.body, row.spoiler, row.started_on, row.finished_on]);
      await client.query('DELETE FROM access.reader_review_vote WHERE review_id = $1', [review]);
      await bumpCollection(client, row.context, row.work);
      await client.query(`INSERT INTO access.reader_review_event (review_id, revision, kind)
        VALUES ($1,$2,'deleted')`, [review, revision]);
      const result: ReviewReceipt = { profile: 'reader-review-receipt-v1', review, revision,
        deleted: true, replayed: false };
      await saveReceipt(client, owner, key, intent, result);
      return result;
    });
  }

  async helpful(principal: VerifiedPrincipal, review: string, actingSubject: string,
    helpful: boolean, expectedRevision: string | null, key: string,
    disclose: (row: ReviewRow) => Promise<void>): Promise<HelpfulReceipt> {
    if (!UUID.test(review) || !ID.test(actingSubject) || !KEY.test(key)
      || expectedRevision !== null && !UUID.test(expectedRevision)) throw new ControlInvalid('Invalid helpful vote');
    const intent = { kind: 'helpful', review, actingSubject, helpful, expectedRevision };
    return controlTransaction(this.pool, async client => {
      const owner = await followPrincipal(client, principal, actingSubject);
      await lockKey(client, 'review-key', owner, key);
      const replay = await receipt<HelpfulReceipt>(client, owner, key, intent);
      if (replay) return { ...replay, replayed: true };
      const row = (await client.query<ReviewRow>(`SELECT ${rowColumns} FROM access.reader_review r
        WHERE id = $1 AND ${reviewVisibleSql} FOR UPDATE`, [review])).rows[0];
      if (!row || row.deleted) throw new ControlDenied('Review is unavailable');
      if (row.principal_id === owner) throw new ControlDenied('A reader cannot vote on their own review');
      const prior = (await client.query<{ revision: string; helpful: boolean }>(`
        SELECT revision, helpful FROM access.reader_review_vote
        WHERE principal_id = $1 AND review_id = $2 FOR UPDATE`, [owner, review])).rows[0];
      if ((prior?.revision ?? null) !== expectedRevision) throw new ControlStale('Helpful vote changed');
      await disclose(row);
      const revision = randomUUID();
      await client.query(`INSERT INTO access.reader_review_vote
        (principal_id, review_id, helpful, revision) VALUES ($1,$2,$3,$4)
        ON CONFLICT (principal_id, review_id) DO UPDATE
        SET helpful = EXCLUDED.helpful, revision = EXCLUDED.revision`, [owner, review, helpful, revision]);
      const count = row.helpful_count + Number(helpful) - Number(prior?.helpful ?? false);
      await client.query('UPDATE access.reader_review SET helpful_count = $2 WHERE id = $1', [review, count]);
      await bumpCollection(client, row.context, row.work);
      await client.query(`INSERT INTO access.reader_review_event (review_id, revision, kind)
        VALUES ($1,$2,'helpful-changed')`, [review, revision]);
      const result: HelpfulReceipt = { profile: 'reader-review-helpful-receipt-v1', review,
        revision, helpful, helpfulCount: count, replayed: false };
      await saveReceipt(client, owner, key, intent, result);
      return result;
    });
  }

  async collectionRevision(context: string, work: string): Promise<string | null> {
    return controlTransaction(this.pool, async client => {
      const row = (await client.query<{ revision: string }>(`
      SELECT revision FROM access.reader_review_collection WHERE context = $1 AND work = $2`,
      [context, work])).rows[0];
      return row?.revision ?? null;
    });
  }

  /** Every page uses an indexed P+1 seek. The caller binds the collection
   * generation into an encrypted cursor and checks it again before returning. */
  async page(query: ReviewPageQuery): Promise<ReviewRow[]> {
    if (!ID.test(query.context) || !ID.test(query.work) || query.limit < 1 || query.limit > REVIEW_COST.pageSize
      || query.language && (!LANGUAGE.test(query.language) || query.language.length > 35)
      || query.rating && (!Number.isInteger(query.rating) || query.rating < 1 || query.rating > 10)) {
      throw new ControlInvalid('Invalid review page');
    }
    const helpful = query.sort === 'helpful';
    const after = query.after;
    if (after && (!UUID.test(after.id) || !Number.isInteger(after.count) || after.count < 0
      || !Number.isFinite(Date.parse(after.time)))) throw new WorkReadMoved('Review cursor changed');
    const order = helpful ? 'r.helpful_count DESC, r.created_at DESC, r.id DESC'
      : 'r.created_at DESC, r.id DESC';
    const seek = !after ? '' : helpful
      ? 'AND (r.helpful_count, r.created_at, r.id) < ($7::integer,$8::timestamptz,$9::uuid)'
      : 'AND (r.created_at, r.id) < ($8::timestamptz,$9::uuid)';
    const values: unknown[] = [query.context, query.work, query.language ?? null,
      query.rating ?? null, query.limit + 1, query.ownPrincipal ?? null];
    if (after) values.push(after.count, after.time, after.id);
    const rows = await controlTransaction(this.pool, client => client.query<ReviewRow>(`SELECT ${rowColumns},
      coalesce(v.helpful,false) AS viewer_helpful, v.revision AS viewer_vote_revision
      FROM access.reader_review r JOIN access.authority_subject s
        ON s.id = r.acting_subject AND s.active
      LEFT JOIN access.reader_review_vote v
        ON v.review_id = r.id AND v.principal_id = $6
      WHERE r.context = $1 AND r.work = $2 AND NOT r.deleted AND ${reviewVisibleSql}
        AND ($3::text IS NULL OR r.language = $3)
        AND ($4::integer IS NULL OR r.rating = $4)
        AND ($6::uuid IS NULL OR r.principal_id <> $6)
        ${seek} ORDER BY ${order} LIMIT $5`,
    values));
    return rows.rows;
  }

  async own(principalId: string, context: string, work: string,
    filters: { language?: string; rating?: number }): Promise<ReviewRow | null> {
    const row = (await controlTransaction(this.pool, client => client.query<ReviewRow>(`SELECT ${rowColumns}
      FROM access.reader_review r JOIN access.authority_subject s ON s.id = r.acting_subject AND s.active
      WHERE r.principal_id = $1 AND r.context = $2 AND r.work = $3 AND NOT r.deleted
        AND ${reviewVisibleSql}
        AND ($4::text IS NULL OR r.language = $4)
        AND ($5::integer IS NULL OR r.rating = $5)`,
    [principalId, context, work, filters.language ?? null, filters.rating ?? null]))).rows[0];
    return row ?? null;
  }

  async byId(review: string, principalId: string | null): Promise<ReviewRow | null> {
    if (!UUID.test(review)) throw new ControlInvalid('Invalid review');
    return (await controlTransaction(this.pool, client => client.query<ReviewRow>(`SELECT ${rowColumns},
      coalesce(v.helpful,false) AS viewer_helpful, v.revision AS viewer_vote_revision
      FROM access.reader_review r JOIN access.authority_subject s
        ON s.id = r.acting_subject AND s.active
      LEFT JOIN access.reader_review_vote v
        ON v.review_id = r.id AND v.principal_id = $2
      WHERE r.id = $1 AND NOT r.deleted AND ${reviewVisibleSql}`,
    [review, principalId]))).rows[0] ?? null;
  }

  async quotes(realm: string, limit: number): Promise<ReviewRow[]> {
    if (!ID.test(realm) || limit < 1 || limit > REVIEW_COST.quoteSize) throw new ControlInvalid('Invalid quote page');
    return (await controlTransaction(this.pool, client => client.query<ReviewRow>(`SELECT ${rowColumns}
      FROM access.reader_review r JOIN access.authority_subject s ON s.id = r.acting_subject AND s.active
      WHERE r.realm = $1 AND NOT r.deleted AND NOT r.spoiler AND ${reviewVisibleSql}
      ORDER BY r.helpful_count DESC, r.created_at DESC, r.id DESC LIMIT $2`,
    [realm, limit]))).rows;
  }

  /** O(batch) sequence seek for relay consumers. Events carry references only;
   * a consumer must read the current review and public Work before display. */
  async eventsAfter(after: string, limit = REVIEW_COST.eventBatch): Promise<ReviewEvent[]> {
    if (!/^(0|[1-9][0-9]{0,18})$/.test(after)
      || !Number.isInteger(limit) || limit < 1 || limit > REVIEW_COST.eventBatch) {
      throw new ControlInvalid('Invalid review event cursor');
    }
    const rows = (await controlTransaction(this.pool, client => client.query<{
      sequence: string; id: string; review_id: string; revision: string; kind: ReviewEvent['kind'];
      context: string; work: string; realm: string | null; occurred_at: Date
    }>(`SELECT e.sequence::text AS sequence, e.id, e.review_id, e.revision, e.kind,
        r.context, r.work, r.realm, e.occurred_at
      FROM access.reader_review_event e JOIN access.reader_review r ON r.id = e.review_id
      WHERE e.sequence > $1::bigint ORDER BY e.sequence LIMIT $2`, [after, limit]))).rows;
    return rows.map(row => ({ sequence: row.sequence, id: row.id, review: row.review_id,
      revision: row.revision, kind: row.kind, context: row.context, work: row.work,
      realm: row.realm, occurredAt: row.occurred_at.toISOString() }));
  }
}

import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import type { JudgmentCounts } from './policy.ts';
import { projectJudgmentBadge } from './badge.ts';
import { declareConceptHint, type ConceptHintWrite } from './hint.ts';
import { judgmentContextKey, judgmentReceiptIri, validJudgmentValue,
  type JudgmentContext, type JudgmentDimension } from './schema.ts';

export class JudgmentDenied extends Error {}
export class JudgmentConflict extends Error {}
export class JudgmentStale extends Error {}
export class JudgmentUnavailable extends Error {}

interface ReceiptRow { id: string; principal_id: string; request_digest: string;
  statement: string; context_key: string; dimension: JudgmentDimension;
  revision: string; value: number | null }
interface HeadRow { fit_value: number | null; fit_revision: string;
  spoiler_value: number | null; spoiler_revision: string }
interface AggregateRow { fit_negative: string; fit_positive: string; spoiler_none: string;
  spoiler_minor: string; spoiler_major: string; generation: string }

export interface JudgmentWrite {
  statement: string; context: JudgmentContext; dimension: JudgmentDimension;
  value: number | null; expectedRevision: string; idempotencyKey: string; requestDigest: string;
}
export interface JudgmentResult {
  receipt: string; statement: string; context: JudgmentContext;
  dimension: JudgmentDimension; value: number | null; revision: string; replayed: boolean;
}

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const revision = /^(0|[1-9][0-9]*)$/;
const keyPattern = /^[A-Za-z0-9:_./-]{1,128}$/;
const toCount = (value: string): number => {
  const count = Number(value);
  if (!Number.isSafeInteger(count) || count < 0) throw new JudgmentUnavailable('judgment count exceeds safe range');
  return count;
};

async function principalId(client: PoolClient, principal: VerifiedPrincipal, lock: boolean): Promise<string> {
  const row = (await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active ${lock ? 'FOR SHARE' : ''}`,
  [principal.issuer, principal.subject])).rows[0];
  if (!row) throw new JudgmentDenied('active Account principal required');
  return row.id;
}

async function eligible(client: PoolClient, principalIdValue: string,
  context: JudgmentContext, lock: boolean): Promise<void> {
  if (context.kind === 'global') return;
  const row = (await client.query(`SELECT id FROM access.private_membership
    WHERE principal_id = $1 AND kind = 'realm' AND owner_subject = $2 AND state = 'joined'
    ${lock ? 'FOR SHARE' : ''}`, [principalIdValue, context.realm])).rows[0];
  if (!row) throw new JudgmentDenied('current Realm membership required');
}

async function recoveryOpen(client: PoolClient): Promise<void> {
  const row = (await client.query<{ open: boolean }>(
    'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
  if (row?.open !== true) throw new JudgmentUnavailable('Access is held for recovery');
}

function matchedReceipt(row: ReceiptRow, principalIdValue: string,
  input: JudgmentWrite, contextKey: string): JudgmentResult {
  if (row.principal_id !== principalIdValue || row.request_digest !== input.requestDigest
    || row.statement !== input.statement || row.context_key !== contextKey
    || row.dimension !== input.dimension) {
    throw new JudgmentConflict('idempotency key binds another judgment intent');
  }
  return { receipt: judgmentReceiptIri(row.id), statement: input.statement,
    context: input.context, dimension: row.dimension, value: row.value,
    revision: row.revision, replayed: true };
}

/** Access is the single write owner; the receipt, head, immutable revision and
 * aggregate commit in one PostgreSQL transaction. No graph projection can count
 * a public persona as an independent voter. */
export class AccessJudgments {
  constructor(private readonly pool: Pool) {}

  protectionCheck(statement: string, context: JudgmentContext, concept: string | null) {
    return projectJudgmentBadge(this.pool, statement, context, concept)
      .catch(() => { throw new JudgmentUnavailable('judgment badge projection unavailable'); });
  }

  declareHint(principal: VerifiedPrincipal, input: ConceptHintWrite) {
    return declareConceptHint(this.pool, principal, input);
  }

  private async connect(): Promise<PoolClient> {
    return this.pool.connect().catch(() => { throw new JudgmentUnavailable('Access judgment owner unavailable'); });
  }

  async replay(principal: VerifiedPrincipal, input: JudgmentWrite): Promise<JudgmentResult | null> {
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await recoveryOpen(client);
      const id = await principalId(client, principal, false);
      const row = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
      await client.query('COMMIT');
      return row ? matchedReceipt(row, id, input, judgmentContextKey(input.context)) : null;
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }

  async write(principal: VerifiedPrincipal, input: JudgmentWrite): Promise<JudgmentResult> {
    const contextKey = judgmentContextKey(input.context);
    if (!native.test(input.statement) || !validJudgmentValue(input.dimension, input.value)
      || !revision.test(input.expectedRevision) || !keyPattern.test(input.idempotencyKey)
      || !/^[0-9a-f]{64}$/.test(input.requestDigest)) throw new JudgmentDenied('invalid judgment intent');
    const client = await this.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '2s'");
      await client.query("SET LOCAL statement_timeout = '5s'");
      await recoveryOpen(client);
      const id = await principalId(client, principal, true);
      const prior = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
      if (prior) {
        const result = matchedReceipt(prior, id, input, contextKey);
        await client.query('COMMIT');
        return result;
      }
      await eligible(client, id, input.context, true);
      // Aggregate row lock serializes all voters of one target/population. A
      // second update of this principal then observes the first dimension head.
      await client.query(`INSERT INTO access.judgment_aggregate (statement, context_key)
        VALUES ($1, $2) ON CONFLICT DO NOTHING`, [input.statement, contextKey]);
      const aggregate = (await client.query<AggregateRow>(`SELECT * FROM access.judgment_aggregate
        WHERE statement = $1 AND context_key = $2 FOR UPDATE`, [input.statement, contextKey])).rows[0]!;
      // Another request for this target may have committed the same key while
      // this transaction waited on the aggregate lock.
      const raced = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
      if (raced) {
        const result = matchedReceipt(raced, id, input, contextKey);
        await client.query('COMMIT');
        return result;
      }
      await client.query(`INSERT INTO access.judgment_head (principal_id, statement, context_key)
        VALUES ($1, $2, $3) ON CONFLICT DO NOTHING`, [id, input.statement, contextKey]);
      const head = (await client.query<HeadRow>(`SELECT * FROM access.judgment_head
        WHERE principal_id = $1 AND statement = $2 AND context_key = $3 FOR UPDATE`,
      [id, input.statement, contextKey])).rows[0]!;
      const oldRevision = input.dimension === 'fit' ? head.fit_revision : head.spoiler_revision;
      if (oldRevision !== input.expectedRevision) throw new JudgmentStale('judgment dimension changed');
      const previous = input.dimension === 'fit' ? head.fit_value : head.spoiler_value;
      const nextRevision = (BigInt(oldRevision) + 1n).toString();
      const valueColumn = input.dimension === 'fit' ? 'fit_value' : 'spoiler_value';
      const revisionColumn = input.dimension === 'fit' ? 'fit_revision' : 'spoiler_revision';
      await client.query(`UPDATE access.judgment_head SET ${valueColumn} = $4,
        ${revisionColumn} = $5, updated_at = clock_timestamp()
        WHERE principal_id = $1 AND statement = $2 AND context_key = $3`,
      [id, input.statement, contextKey, input.value, nextRevision]);
      const counts = {
        fit_negative: toCount(aggregate.fit_negative), fit_positive: toCount(aggregate.fit_positive),
        spoiler_none: toCount(aggregate.spoiler_none), spoiler_minor: toCount(aggregate.spoiler_minor),
        spoiler_major: toCount(aggregate.spoiler_major),
      };
      const columnFor = (value: number | null) => input.dimension === 'fit'
        ? value === -1 ? 'fit_negative' : value === 1 ? 'fit_positive' : null
        : value === 0 ? 'spoiler_none' : value === 1 ? 'spoiler_minor'
          : value === 2 ? 'spoiler_major' : null;
      const oldColumn = columnFor(previous), newColumn = columnFor(input.value);
      if (oldColumn) counts[oldColumn]--;
      if (newColumn) counts[newColumn]++;
      await client.query(`UPDATE access.judgment_aggregate SET fit_negative = $3,
        fit_positive = $4, spoiler_none = $5, spoiler_minor = $6, spoiler_major = $7,
        generation = generation + 1, updated_at = clock_timestamp()
        WHERE statement = $1 AND context_key = $2`, [input.statement, contextKey,
      counts.fit_negative, counts.fit_positive, counts.spoiler_none,
      counts.spoiler_minor, counts.spoiler_major]);
      const receiptId = randomUUID();
      await client.query(`INSERT INTO access.judgment_receipt
        (id, principal_id, idempotency_key, request_digest, statement, context_key,
          dimension, revision, value) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [receiptId, id, input.idempotencyKey, input.requestDigest, input.statement,
        contextKey, input.dimension, nextRevision, input.value]);
      await client.query(`INSERT INTO access.judgment_revision
        (id, principal_id, statement, context_key, dimension, revision, value,
          previous_value, receipt_id) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9)`,
      [randomUUID(), id, input.statement, contextKey, input.dimension, nextRevision,
        input.value, previous, receiptId]);
      await client.query(`INSERT INTO access.judgment_outbox
        (id, statement, context_key, generation, receipt_id)
        VALUES ($1,$2,$3,$4,$5)`, [randomUUID(), input.statement, contextKey,
        (BigInt(aggregate.generation) + 1n).toString(), receiptId]);
      await client.query('COMMIT');
      return { receipt: judgmentReceiptIri(receiptId), statement: input.statement,
        context: input.context, dimension: input.dimension, value: input.value,
        revision: nextRevision, replayed: false };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      if ((error as { code?: string }).code === '23505') {
        // Distinct target aggregates do not share a row lock; the receipt's
        // principal/key uniqueness still gives a deterministic replay result.
        const id = await principalId(client, principal, false);
        const prior = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_receipt
          WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
        if (prior) return matchedReceipt(prior, id, input, contextKey);
        throw new JudgmentConflict('judgment key raced');
      }
      if ((error as { code?: string }).code === '55P03') throw new JudgmentUnavailable('judgment owner busy');
      throw error;
    } finally { client.release(); }
  }

  async read(principal: VerifiedPrincipal, statement: string,
    context: JudgmentContext, concept: string | null = null): Promise<{ counts: JudgmentCounts; viewer: {
      fit: number | null; fitRevision: string; spoiler: number | null;
      spoilerRevision: string } | null; generation: string; hintGeneration: string }> {
    const contextKey = judgmentContextKey(context);
    if (!native.test(statement)) throw new JudgmentDenied('invalid judgment target');
    const client = await this.connect();
    try {
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ');
      await recoveryOpen(client);
      const id = await principalId(client, principal, false);
      await eligible(client, id, context, false);
      const aggregate = (await client.query<AggregateRow>(`SELECT * FROM access.judgment_aggregate
        WHERE statement = $1 AND context_key = $2`, [statement, contextKey])).rows[0];
      const head = (await client.query<HeadRow>(`SELECT * FROM access.judgment_head
        WHERE principal_id = $1 AND statement = $2 AND context_key = $3`,
      [id, statement, contextKey])).rows[0];
      const hint = concept ? (await client.query<{ generation: string }>(`
        SELECT generation FROM access.judgment_concept_hint
        WHERE concept = $1 AND context_key = $2`, [concept, contextKey])).rows[0] : null;
      await client.query('COMMIT');
      return { counts: { fitNegative: toCount(aggregate?.fit_negative ?? '0'),
        fitPositive: toCount(aggregate?.fit_positive ?? '0'),
        spoilerNone: toCount(aggregate?.spoiler_none ?? '0'),
        spoilerMinor: toCount(aggregate?.spoiler_minor ?? '0'),
        spoilerMajor: toCount(aggregate?.spoiler_major ?? '0') },
      viewer: head ? { fit: head.fit_value, fitRevision: head.fit_revision,
        spoiler: head.spoiler_value, spoilerRevision: head.spoiler_revision } : null,
      generation: aggregate?.generation ?? '0', hintGeneration: hint?.generation ?? '0' };
    } catch (error) {
      await client.query('ROLLBACK').catch(() => undefined);
      throw error;
    } finally { client.release(); }
  }
}

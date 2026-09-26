import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { VerifiedPrincipal } from '../access/admission.ts';
import { judgmentContextKey, type ConceptHint, type JudgmentContext } from './schema.ts';

export class ConceptHintDenied extends Error {}
export class ConceptHintStale extends Error {}
export class ConceptHintConflict extends Error {}
export class ConceptHintUnavailable extends Error {}

export interface ConceptHintWrite {
  concept: string; context: JudgmentContext; hint: Exclude<ConceptHint, 'unknown'>;
  expectedGeneration: string; actingSubject: string;
  idempotencyKey: string; requestDigest: string;
}
export interface ConceptHintResult {
  concept: string; context: JudgmentContext; hint: Exclude<ConceptHint, 'unknown'>;
  generation: string; receipt: string; replayed: boolean;
}

interface ReceiptRow { id: string; principal_id: string; request_digest: string;
  concept: string; context_key: string; hint: Exclude<ConceptHint, 'unknown'>;
  generation: string }
const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
const decimal = /^(0|[1-9][0-9]*)$/;
const receiptIri = (id: string) => `urn:rezics:access-concept-hint-receipt:${id}`;

function receipt(row: ReceiptRow, id: string, input: ConceptHintWrite,
  key: string): ConceptHintResult {
  if (row.principal_id !== id || row.request_digest !== input.requestDigest
    || row.concept !== input.concept || row.context_key !== key || row.hint !== input.hint) {
    throw new ConceptHintConflict('idempotency key binds another concept hint');
  }
  return { concept: input.concept, context: input.context, hint: row.hint,
    generation: row.generation, receipt: receiptIri(row.id), replayed: true };
}

async function principalId(client: PoolClient, principal: VerifiedPrincipal): Promise<string> {
  const row = (await client.query<{ id: string }>(`SELECT id FROM access.principal
    WHERE account_issuer = $1 AND account_subject = $2 AND active FOR SHARE`,
  [principal.issuer, principal.subject])).rows[0];
  if (!row) throw new ConceptHintDenied('active Account principal required');
  return row.id;
}

/** A curator's current Statement-decision mandate in the same acceptance scope
 * authorizes concept hint declaration. A bearer scope alone grants no authority. */
async function curator(client: PoolClient, id: string, input: ConceptHintWrite): Promise<void> {
  const scope = input.context.kind === 'global' ? 'classification:decide:global'
    : `classification:decide:${input.context.realm}`;
  const row = (await client.query(`SELECT r.id FROM access.representation r
    JOIN access.authority_subject s ON s.id = r.subject_id AND s.active
    JOIN access.permission_grant g ON g.recipient_subject = r.subject_id
      AND g.issuer_subject = r.subject_id AND g.action = r.action
      AND g.active AND g.valid_until > clock_timestamp()
    JOIN access.scope_gate gate ON gate.id = g.scope_id AND gate.open AND gate.dispatch_open
    WHERE r.principal_id = $1 AND r.subject_id = $2 AND r.action = 'statement.decide'
      AND r.active AND r.valid_until > clock_timestamp() AND g.scope_id = $3
    LIMIT 1 FOR SHARE OF r, s, g, gate`, [id, input.actingSubject, scope])).rows[0];
  if (!row) throw new ConceptHintDenied('current curator authority required');
}

export async function declareConceptHint(pool: Pool, principal: VerifiedPrincipal,
  input: ConceptHintWrite): Promise<ConceptHintResult> {
  const key = judgmentContextKey(input.context);
  if (!native.test(input.concept) || !native.test(input.actingSubject)
    || !['not-spoiler', 'minor', 'major'].includes(input.hint)
    || !decimal.test(input.expectedGeneration)
    || !/^[A-Za-z0-9:_./-]{1,128}$/.test(input.idempotencyKey)
    || !/^[0-9a-f]{64}$/.test(input.requestDigest)) {
    throw new ConceptHintDenied('invalid concept hint declaration');
  }
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    await client.query("SET LOCAL lock_timeout = '2s'");
    await client.query("SET LOCAL statement_timeout = '5s'");
    const recovery = (await client.query<{ open: boolean }>(
      'SELECT open FROM access.recovery_fence WHERE id = true FOR SHARE')).rows[0];
    if (recovery?.open !== true) throw new ConceptHintUnavailable('Access is held for recovery');
    const id = await principalId(client, principal);
    let prior = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_concept_hint_receipt
      WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
    if (prior) {
      const result = receipt(prior, id, input, key);
      await client.query('COMMIT');
      return result;
    }
    await curator(client, id, input);
    await client.query(`INSERT INTO access.judgment_concept_hint (concept, context_key)
      VALUES ($1, $2) ON CONFLICT DO NOTHING`, [input.concept, key]);
    const head = (await client.query<{ generation: string }>(`SELECT generation
      FROM access.judgment_concept_hint WHERE concept = $1 AND context_key = $2 FOR UPDATE`,
    [input.concept, key])).rows[0]!;
    prior = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_concept_hint_receipt
      WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
    if (prior) {
      const result = receipt(prior, id, input, key);
      await client.query('COMMIT');
      return result;
    }
    if (head.generation !== input.expectedGeneration) throw new ConceptHintStale('concept hint changed');
    const next = (BigInt(head.generation) + 1n).toString();
    await client.query(`UPDATE access.judgment_concept_hint SET hint = $3,
      generation = $4, declared_by_principal = $5, updated_at = clock_timestamp()
      WHERE concept = $1 AND context_key = $2`, [input.concept, key, input.hint, next, id]);
    const receiptId = randomUUID();
    await client.query(`INSERT INTO access.judgment_concept_hint_receipt
      (id, principal_id, idempotency_key, request_digest, concept,
        context_key, hint, generation) VALUES ($1,$2,$3,$4,$5,$6,$7,$8)`,
    [receiptId, id, input.idempotencyKey, input.requestDigest,
      input.concept, key, input.hint, next]);
    await client.query('COMMIT');
    return { concept: input.concept, context: input.context, hint: input.hint,
      generation: next, receipt: receiptIri(receiptId), replayed: false };
  } catch (error) {
    await client.query('ROLLBACK').catch(() => undefined);
    if ((error as { code?: string }).code === '23505') {
      const id = await principalId(client, principal);
      const prior = (await client.query<ReceiptRow>(`SELECT * FROM access.judgment_concept_hint_receipt
        WHERE principal_id = $1 AND idempotency_key = $2`, [id, input.idempotencyKey])).rows[0];
      if (prior) return receipt(prior, id, input, key);
      throw new ConceptHintConflict('concept hint key raced');
    }
    throw error;
  } finally { client.release(); }
}

import { createHash } from 'node:crypto';

export type JudgmentDimension = 'fit' | 'spoiler';
export type FitValue = -1 | 1;
export type SpoilerValue = 0 | 1 | 2;
export type JudgmentContext = { kind: 'global' } | { kind: 'realm'; realm: string };
export type ConceptHint = 'unknown' | 'not-spoiler' | 'minor' | 'major';

const native = /^https:\/\/rezics\.com\/id\/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function judgmentContextKey(context: JudgmentContext): string {
  if (context.kind === 'global') return 'global';
  if (!native.test(context.realm)) throw new Error('invalid judgment Realm');
  return context.realm;
}

export function judgmentDigest(value: unknown): string {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex');
}

export function judgmentReceiptIri(id: string): string {
  return `urn:rezics:access-judgment-receipt:${id}`;
}

export function validJudgmentValue(dimension: JudgmentDimension, value: number | null): boolean {
  return value === null || (dimension === 'fit' ? value === -1 || value === 1
    : value === 0 || value === 1 || value === 2);
}

export const judgmentAccessTables = {
  judgment_head: ['principal_id', 'statement', 'context_key', 'fit_value', 'fit_revision',
    'spoiler_value', 'spoiler_revision', 'created_at', 'updated_at'],
  judgment_revision: ['id', 'principal_id', 'statement', 'context_key', 'dimension',
    'revision', 'value', 'previous_value', 'receipt_id', 'created_at'],
  judgment_receipt: ['id', 'principal_id', 'idempotency_key', 'request_digest', 'statement',
    'context_key', 'dimension', 'revision', 'value', 'created_at'],
  judgment_aggregate: ['statement', 'context_key', 'fit_negative', 'fit_positive',
    'spoiler_none', 'spoiler_minor', 'spoiler_major', 'generation', 'updated_at'],
  judgment_outbox: ['id', 'kind', 'statement', 'context_key', 'generation', 'receipt_id', 'created_at'],
  judgment_concept_hint: ['concept', 'context_key', 'hint', 'generation',
    'declared_by_principal', 'created_at', 'updated_at'],
  judgment_concept_hint_receipt: ['id', 'principal_id', 'idempotency_key', 'request_digest',
    'concept', 'context_key', 'hint', 'generation', 'created_at'],
  judgment_badge_projection: ['statement', 'context_key', 'source_event', 'generation',
    'concept', 'hint_generation', 'policy_generation', 'protection', 'status',
    'sample_size', 'distribution', 'updated_at'],
} as const;

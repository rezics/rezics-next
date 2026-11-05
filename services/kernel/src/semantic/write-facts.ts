import { jsonParameter } from '../sql/json.ts';
import type { PoolClient } from 'pg';
import insertFacts from './insert-facts.sql';

/** One subject's stored fact log, shared by creation and slot expansion. */
export const FACT_LIMIT = 512;

export type StoredFact = {
  slot_id: string;
  log_seq: number;
  operation: 'assert' | 'retract' | 'expand';
  kind: 'label' | 'description' | 'alias' | 'statement';
  language: string | null;
  property: string | null;
  statement_id: string | null;
  body: unknown;
  release: string | null;
  relation?: boolean;
};

export type FactWriter = {
  query(text: string, values?: readonly unknown[]): Promise<unknown>;
};

/** Refuses an unbounded fact log before any insert. Callers share this path. */
export async function writeFacts(
  client: FactWriter,
  input: {
    route: number;
    subject_id: string;
    transaction_id: string;
    facts: readonly StoredFact[];
  },
): Promise<void> {
  if (input.facts.length > FACT_LIMIT) throw new TypeError('A subject accepts at most 512 facts');
  await insertFacts.run(client as PoolClient, {
    route: input.route,
    subject_id: input.subject_id,
    transaction_id: input.transaction_id,
    facts: jsonParameter(input.facts),
  });
}

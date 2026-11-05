import { statementBytes } from '../sql/statement-bytes.ts';
/** Closed nine-axis declaration for the exact saved-rule point read. */
import { declareBound, withinCeiling, type Bound } from '@rezics/bounds';
import { FILTER_LIMITS } from '@rezics/filter';
import type { PoolClient } from 'pg';
import read from './collection-rules-read.sql';
import { COLLECTION_PUBLICATION_STEP_CEILING } from './collection-publication-bounds.ts';

type QueryClient = Pick<PoolClient, 'query'>;
type RuleReadInput = Readonly<{ route: number; collection_id: string }>;

// One admitted filter leaf can retain a primary 64-value operand and four 64-value qualifiers.
// Every accepted string is at most 256 UTF-8 bytes; quote/backslash escaping uses at most two
// bytes per source byte. The additional eight strings cover property/type and owner identifiers.
const maxEscapedStringBytes = 2 * 256 + 2;
const MAX_FILTER_JSON_BYTES =
  FILTER_LIMITS.leaves *
    ((FILTER_LIMITS.qualifiers + 1) * FILTER_LIMITS.in * maxEscapedStringBytes + 8 * maxEscapedStringBytes + 2048) +
  1024;
const MAX_RULE_PROJECTION_BYTES = MAX_FILTER_JSON_BYTES + 36 + 36 + 36 + 32 + 16 + 64;

export type CollectionRuleReadPlan = Readonly<{
  operation: 'collection.rule.read';
  input: RuleReadInput;
  total: Bound;
  withinExistingCeiling: boolean;
}>;

export function collectionRuleReadPlan(input: RuleReadInput): CollectionRuleReadPlan {
  const frozen = Object.freeze({ route: input.route, collection_id: input.collection_id });
  const total = declareBound({
    candidateKeys: 1,
    nativeRows: 1,
    identityMetadataRows: 0,
    emptySeeks: 1,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes:
      statementBytes(read) +
      Buffer.byteLength(JSON.stringify(frozen)) +
      Buffer.byteLength('[]') +
      2 +
      MAX_RULE_PROJECTION_BYTES,
    engineRequests: 0,
  });
  return Object.freeze({
    operation: 'collection.rule.read',
    input: frozen,
    total,
    withinExistingCeiling: withinCeiling(total, COLLECTION_PUBLICATION_STEP_CEILING),
  });
}

export function executeCollectionRuleRead(client: QueryClient, plan: CollectionRuleReadPlan) {
  return read.run(client, plan.input);
}

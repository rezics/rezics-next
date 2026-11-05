import { statementBytes } from '../database/statement-bytes.ts';
/** Closed nine-axis declarations for the existing saved-rule INSERT and CAS UPDATE statements. */
import { declareBound, withinCeiling, type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
import insert from './collection-rules-insert.sql';
import update from './collection-rules-update.sql';
import { COLLECTION_PUBLICATION_STEP_CEILING } from './collection-publication-bounds.ts';

type QueryClient = Pick<PoolClient, 'query'>;
type EditInput = Readonly<Record<string, string | number | null>>;
export type CollectionRuleEditPlan = Readonly<{
  operation: 'collection.rule.insert' | 'collection.rule.update';
  input: EditInput;
  total: Bound;
  withinExistingCeiling: boolean;
}>;

function plan(
  operation: CollectionRuleEditPlan['operation'],
  query: Readonly<{ sql: string }>,
  input: EditInput,
  returned: boolean,
): CollectionRuleEditPlan {
  const frozen = Object.freeze({ ...input });
  const total = declareBound({
    candidateKeys: 1,
    nativeRows: 1,
    identityMetadataRows: 0,
    emptySeeks: returned ? 1 : 0,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    // The filter is the exact original serialized JSON bind; UUID, time and metadata binds retain
    // their schema-valid inputs in the same snapshot instead of being repriced from a DTO.
    bytes:
      statementBytes(query) +
      Buffer.byteLength(JSON.stringify(frozen)) +
      (returned ? Buffer.byteLength(JSON.stringify({ revision: Number.MAX_SAFE_INTEGER })) : Buffer.byteLength('[]')),
    engineRequests: 0,
  });
  return Object.freeze({
    operation,
    input: frozen,
    total,
    withinExistingCeiling: withinCeiling(total, COLLECTION_PUBLICATION_STEP_CEILING()),
  });
}

export function collectionRuleInsertPlan(input: EditInput): CollectionRuleEditPlan {
  return plan('collection.rule.insert', insert, input, false);
}

export function collectionRuleUpdatePlan(input: EditInput): CollectionRuleEditPlan {
  return plan('collection.rule.update', update, input, true);
}

export function executeCollectionRuleInsert(client: QueryClient, value: CollectionRuleEditPlan) {
  if (value.operation !== 'collection.rule.insert') throw new TypeError('Foreign saved-rule INSERT plan');
  return insert.run(client, value.input as Parameters<typeof insert.run>[1]);
}

export function executeCollectionRuleUpdate(client: QueryClient, value: CollectionRuleEditPlan) {
  if (value.operation !== 'collection.rule.update') throw new TypeError('Foreign saved-rule UPDATE plan');
  return update.run(client, value.input as Parameters<typeof update.run>[1]);
}

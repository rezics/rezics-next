import type { CommandTransaction } from '../command/command.ts';
import { minimizeSemanticRecordPayload } from './retention-payload.ts';

export type RetentionKey = Readonly<{
  key: string;
  route: number;
  kind: 'candidate' | 'context' | 'zone';
  owner_id: string;
  record_id: string;
  generation: string;
  deleted_at: string;
  phase: 'local' | 'shared' | 'complete';
  fragment_store: number;
  fragment_key: string;
}>;
type Fragment = { store: string; key: string };
/** Each prefix is partition-leading and capped before payload filtering. Never walks subject revision history. */
export async function nextRecordFragment(tx: CommandTransaction, work: RetentionKey): Promise<Fragment | null> {
  const tables =
    work.kind === 'candidate'
      ? ['candidate', 'revision', 'fact', 'retraction', 'moderation', 'source_candidate', 'statement_disclosure']
      : ['context', 'context_extension'];
  const store = tables[work.fragment_store];
  if (!store) return null;
  let predicate: string;
  if (work.kind === 'context') predicate = 'route=$1 AND context_id=$2';
  else if (store === 'revision')
    predicate = `route=$1 AND subject_id=$2 AND revision=(
    SELECT revision FROM semantic.record_lifecycle WHERE route=$1 AND subject_id=$2 AND candidate_id=$3)`;
  else predicate = `route=$1 AND subject_id=$2 AND ${store === 'fact' ? 'statement_id' : 'candidate_id'}=$3`;
  // Parameter 3 remains typed even for the Context/revision branches.
  const found = await tx.query<{ key: string }>(
    `SELECT erasure_key::text AS key FROM semantic.${store}
    WHERE ${predicate} AND $3::uuid IS NOT NULL AND erasure_key>$4::bigint ORDER BY erasure_key LIMIT 1`,
    [work.route, work.owner_id, work.record_id, work.fragment_key],
  );
  return found.rows[0] ? { store, key: found.rows[0].key } : { store, key: '' };
}

export async function minimizeRecordFragment(
  tx: CommandTransaction,
  work: RetentionKey,
  fragment: Fragment,
  at: string,
) {
  await tx.query(
    `SELECT set_config('semantic.record_retention_key',$1,true),
    set_config('semantic.record_retention_store',$2,true),set_config('semantic.record_retention_fragment',$3,true),
    set_config('semantic.record_retention_at',$4,true)`,
    [work.key, fragment.store, fragment.key, at],
  );
  if (['candidate', 'revision', 'retraction', 'moderation'].includes(fragment.store)) {
    await minimizeSemanticRecordPayload(tx, fragment.store as 'candidate' | 'revision' | 'retraction' | 'moderation', {
      low: work.route,
      high: work.route,
      recordKey: fragment.key,
    });
  } else if (fragment.store === 'fact') {
    await tx.query(
      `UPDATE semantic.fact SET body='{}',operation='retract',release=NULL
      WHERE route=$1 AND subject_id=$2 AND statement_id=$3 AND erasure_key=$4`,
      [work.route, work.owner_id, work.record_id, fragment.key],
    );
  } else if (fragment.store === 'source_candidate') {
    await tx.query(
      `DELETE FROM semantic.source_candidate WHERE route=$1 AND subject_id=$2 AND candidate_id=$3
      AND erasure_key=$4 AND semantic.record_retention_mutation_allowed('source_candidate',route,erasure_key)`,
      [work.route, work.owner_id, work.record_id, fragment.key],
    );
  } else if (fragment.store === 'statement_disclosure') {
    await tx.query(
      `UPDATE semantic.statement_disclosure SET account_id=NULL,disclosed=false,
      source_order_key='',target_order_key='' WHERE route=$1 AND subject_id=$2 AND candidate_id=$3 AND erasure_key=$4
      AND semantic.record_retention_mutation_allowed('statement_disclosure',route,erasure_key)`,
      [work.route, work.owner_id, work.record_id, fragment.key],
    );
  } else if (fragment.store === 'context') {
    await tx.query(
      `UPDATE semantic.context SET labels='{}',settings_id=NULL,settings_release=NULL,defaults='{}'
      WHERE route=$1 AND context_id=$2 AND erasure_key=$3
      AND semantic.record_retention_mutation_allowed('context',route,erasure_key)`,
      [work.route, work.record_id, fragment.key],
    );
  } else if (fragment.store === 'context_extension') {
    await tx.query(
      `UPDATE semantic.context_extension SET body='{}' WHERE route=$1 AND context_id=$2 AND erasure_key=$3
      AND semantic.record_retention_mutation_allowed('context_extension',route,erasure_key)`,
      [work.route, work.record_id, fragment.key],
    );
  } else throw new TypeError('Unknown ordinary record fragment');
}

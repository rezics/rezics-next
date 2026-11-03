/** Local terminal disposition; shared native holds remain their actual owner's obligation. */
import { currentCommand, type CommandTransaction } from '../command/command.ts';
import { routeOf } from '../route/route.ts';
import type { CollectionCleanupPage } from './collection-retention.ts';
import type { CollectionOutputPublication } from './collection-source-output.ts';
import retireFence from './native-source-custody-retire-fence.sql';
import outputHead from './collection-source-output-head.sql';
import { retireNativeCollectionCapturePage } from './native-source-custody.ts';

// Fixed statements, each taking a single indexed parent and returning at most 100 rows.
const privatePages = [
  `WITH keys AS (SELECT generation,canonical_subject_id,stored_subject_id,driver,fact_id
    FROM library.canonical_source_reference WHERE route=$1 AND collection_id=$2
    ORDER BY generation,canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 100)
   DELETE FROM library.canonical_source_reference r USING keys k WHERE r.route=$1 AND r.collection_id=$2
    AND (r.generation,r.canonical_subject_id,r.stored_subject_id,r.driver,r.fact_id)=
        (k.generation,k.canonical_subject_id,k.stored_subject_id,k.driver,k.fact_id)`,
  `DELETE FROM library.canonical_source_head WHERE route=$1 AND collection_id=$2`,
  `WITH keys AS (SELECT generation FROM library.canonical_source_generation
    WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 100)
   DELETE FROM library.canonical_source_generation r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=k.generation`,
  `WITH keys AS (SELECT source_fence FROM library.canonical_source_scope
    WHERE route=$1 AND collection_id=$2 ORDER BY source_fence LIMIT 100)
   DELETE FROM library.canonical_source_scope r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.source_fence=k.source_fence`,
  `WITH keys AS (SELECT generation,basis_digest,canonical_subject_id,stored_subject_id,driver,fact_id
    FROM library.canonical_source_fact WHERE route=$1 AND collection_id=$2
    ORDER BY generation,basis_digest,canonical_subject_id,stored_subject_id,driver,fact_id LIMIT 100)
   DELETE FROM library.canonical_source_fact r USING keys k WHERE r.route=$1 AND r.collection_id=$2
    AND (r.generation,r.basis_digest,r.canonical_subject_id,r.stored_subject_id,r.driver,r.fact_id)=
        (k.generation,k.basis_digest,k.canonical_subject_id,k.stored_subject_id,k.driver,k.fact_id)`,
  `DELETE FROM library.canonical_source_state WHERE route=$1 AND collection_id=$2`,
  `WITH keys AS (SELECT generation,subject_id FROM library.collection_publication_staging_evidence
    WHERE route=$1 AND collection_id=$2 ORDER BY generation,subject_id LIMIT 100)
   DELETE FROM library.collection_publication_staging_evidence r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=k.generation AND r.subject_id=k.subject_id`,
  `WITH keys AS (SELECT generation FROM library.collection_publication_staging_seal
    WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 100)
   DELETE FROM library.collection_publication_staging_seal r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=k.generation`,
  `WITH keys AS (SELECT generation FROM library.collection_publication_staging
    WHERE route=$1 AND collection_id=$2 ORDER BY generation LIMIT 100)
   DELETE FROM library.collection_publication_staging r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=k.generation`,
];

/** Called only under the participant's terminal account fence and locked owning Collection. */
export async function purgeSavedCollectionPage(
  tx: CommandTransaction,
  input: { accountId: string; collectionId: string },
): Promise<CollectionCleanupPage | null> {
  const route = routeOf(input.collectionId)!;
  const keys = [route, input.collectionId];
  const row = (await tx.query<{
    membership_kind: string; state: string; visibility: string; source_generation: string;
  }>(`SELECT membership_kind,state,visibility,source_generation::text FROM library.collection
      WHERE route=$1 AND collection_id=$2`, keys)).rows[0];
  if (!row || row.membership_kind !== 'dynamic') return null;
  let frozen = (await tx.query<{ generation: string }>(
    'SELECT generation::text FROM library.collection_retained_output WHERE route=$1 AND collection_id=$2', keys,
  )).rows[0]?.generation ?? null;
  if (!frozen && row.state === 'active' && row.visibility === 'public') {
    // Read the actual committed publication before any writer hook can change its proof.
    const published = (await tx.query<CollectionOutputPublication>(outputHead.sql, [...keys, row.source_generation])).rows[0];
    if (published) {
      await tx.query(`INSERT INTO library.collection_retained_output
        (route,collection_id,generation,source_generation,members,member_fence,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
        [...keys, published.generation, row.source_generation, published.members, published.memberFence, currentCommand(tx).transactionId]);
      frozen = published.generation;
    }
  }
  const cleared = await tx.query(`UPDATE library.collection SET rule_filter=NULL,rule_sort=NULL,
    rule_release_digest=NULL,rule_revision=0 WHERE route=$1 AND collection_id=$2 AND rule_filter IS NOT NULL`, keys);
  if (cleared.rowCount) return { status: 'progress', removed: 1 };
  // Native identity plans retain exact old/new generation authority until their real control handoff.
  const identity = await tx.query(`SELECT 1 FROM library.identity_scope_plan
    WHERE route=$1 AND collection_id=$2 LIMIT 1`, keys);
  if (identity.rowCount) return { status: 'retained', removed: 0, custody: 'native_source_capture' };
  for (const sql of privatePages) {
    const result = await tx.query(sql, keys);
    if (result.rowCount) return { status: 'progress', removed: result.rowCount };
  }
  // Building B and unselected output are never public membership. Keep real held copies intact.
  const generation = (await tx.query<{ generation: string }>(`SELECT generation::text
    FROM library.collection_source_output o WHERE route=$1 AND collection_id=$2
      AND ($3::uuid IS NULL OR generation<>$3)
      AND NOT EXISTS(SELECT 1 FROM library.native_public_output_hold h
        WHERE h.route=o.route AND h.collection_id=o.collection_id AND h.output_generation=o.generation
          AND h.consumed_by IS NULL)
    ORDER BY generation LIMIT 1 FOR UPDATE`, [...keys, frozen])).rows[0]?.generation;
  if (generation) {
    const outputKeys = [...keys, generation];
    const removed = await tx.query(`WITH keys AS (SELECT subject_id FROM library.collection_source_output_member
      WHERE route=$1 AND collection_id=$2 AND generation=$3 ORDER BY subject_id LIMIT 100)
      DELETE FROM library.collection_source_output_member r USING keys k
      WHERE r.route=$1 AND r.collection_id=$2 AND r.generation=$3 AND r.subject_id=k.subject_id`, outputKeys);
    if (removed.rowCount) return { status: 'progress', removed: removed.rowCount };
    await tx.query('DELETE FROM library.collection_source_output_head WHERE route=$1 AND collection_id=$2 AND generation=$3', outputKeys);
    await tx.query('DELETE FROM library.collection_source_output_publication WHERE route=$1 AND collection_id=$2 AND generation=$3', outputKeys);
    await tx.query('DELETE FROM library.collection_source_output WHERE route=$1 AND collection_id=$2 AND generation=$3', outputKeys);
    return { status: 'progress', removed: 1 };
  }
  const captures = await tx.query(`SELECT 1 FROM library.native_source_capture WHERE route=$1 AND collection_id=$2 LIMIT 1`, keys);
  if (captures.rowCount) {
    const retired = await retireNativeCollectionCapturePage(tx, { ...input, episode: { kind: 'terminal' } });
    if ('removed' in retired && retired.removed) return { status: 'progress', removed: retired.removed };
    return { status: 'retained', removed: 0, custody: 'native_source_capture' };
  }
  const held = await tx.query(`SELECT 1 FROM library.native_public_output_hold
    WHERE route=$1 AND collection_id=$2 AND consumed_by IS NULL LIMIT 1`, keys);
  if (held.rowCount) return { status: 'retained', removed: 0, custody: 'collection_source_and_destination_disposition' };
  // No capture/hold can now lose its owner or publication authority.
  const history = await tx.query('DELETE FROM library.collection_listing_history WHERE route=$1 AND collection_id=$2', keys);
  if (history.rowCount) return { status: 'progress', removed: history.rowCount };
  if (frozen) {
    await tx.query('DELETE FROM library.collection_source_output_publication WHERE route=$1 AND collection_id=$2', keys);
    await tx.query('UPDATE library.collection_source_output SET account_id=NULL WHERE route=$1 AND collection_id=$2 AND generation=$3', [...keys, frozen]);
    await tx.query('UPDATE library.collection SET curator_account_id=NULL WHERE route=$1 AND collection_id=$2', keys);
    return { status: 'purged', removed: 1 };
  }
  // Drain any retained local associations before removing the terminal parent. No visibility rewrite.
  const references = await tx.query(`WITH keys AS (SELECT account_id,subject_id
    FROM library.builtin_state_reference_source WHERE route=$1 AND collection_id=$2
    ORDER BY subject_id LIMIT 100)
    DELETE FROM library.builtin_state_reference_source r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.account_id=k.account_id AND r.subject_id=k.subject_id`, keys);
  if (references.rowCount) return { status: 'progress', removed: references.rowCount };
  await tx.query('DELETE FROM library.builtin_collection_reference WHERE route=$1 AND collection_id=$2', keys);
  const children = await tx.query(`WITH keys AS (SELECT member_id FROM library.collection_member
    WHERE route=$1 AND collection_id=$2 ORDER BY member_id LIMIT 100)
    DELETE FROM library.collection_member r USING keys k
    WHERE r.route=$1 AND r.collection_id=$2 AND r.member_id=k.member_id`, keys);
  if (children.rowCount) return { status: 'progress', removed: children.rowCount };
  await tx.query(`DELETE FROM library.collection WHERE route=$1 AND collection_id=$2
    AND curator_account_id=$3`, [...keys, input.accountId]);
  // The ordinary delete trigger writes local identity history; terminal disposition consumes that exact key.
  await tx.query('DELETE FROM library.collection_listing_history WHERE route=$1 AND collection_id=$2', keys);
  await retireFence.run(tx, { route, collection_id: input.collectionId, account_id: input.accountId });
  return { status: 'purged', removed: 1 };
}

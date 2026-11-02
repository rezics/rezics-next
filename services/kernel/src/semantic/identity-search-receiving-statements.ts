import { receivingSqlKey } from './identity-search-receiving-work.ts';
import receivingJob from './identity-epoch-store-receiving-job.sql';
import receivingPlan from './identity-epoch-store-receiving-plan.sql';
import receivingLookup from './identity-epoch-store-receiving-lookup.sql';
import receivingSelection from './identity-receiving-selection-read.sql';
import searchProgressRead from './identity-search-receiving-progress-read.sql';
import searchProgressInsert from './identity-search-receiving-progress-insert.sql';
import searchProgressAdvance from './identity-search-receiving-progress-advance.sql';
import searchProgressRelease from './identity-search-receiving-progress-release.sql';
import searchUnreleased from './identity-search-receiving-unreleased.sql';
import nativeCommit from './identity-epoch-store-insert-native-commit.sql';
import partitionRead from '../partition/read.sql';
import commandTime from '../command/time.sql';
import commandFence from '../command/fence.sql';
import commandNoEffect from '../command/no-effect-fence.sql';
import type { WorkDimensions } from '../library/collection-source.ts';
import type { SearchReceivingWorkDeclaration } from './identity-search-receiving-work.ts';
import { searchNativeReceivingStatements } from '../search/identity-receiving-native-store.ts';
import { searchNativeReceivingSqlCost } from '../search/identity-receiving-native-work.ts';
import participantNext from '../search/identity-epoch-participant-next.sql';
import participantStep from '../search/identity-epoch-participant-step.sql';
import participantAdvance from '../search/identity-epoch-participant-advance.sql';
import participantReplay from '../search/identity-epoch-participant-replay.sql';
import participantJob from './identity-epoch-store-select-job.sql';
import participantAck from './identity-epoch-store-select-ack.sql';
import nativeDefinition from '../search/identity-receiving-native-definition.sql';
import {
  searchReceivingCaptureStatements,
  searchReceivingCaptureStatementCosts,
} from './identity-search-receiving-capture.ts';

/** Literal inventory used by production calls, including the private pre-COMMIT capture planner. */
export const receivingStatements = Object.freeze({
  inputBasis:
    'SELECT control_partition,terminal,generation,owner_epoch FROM semantic.identity_epoch_input WHERE partition_no=$1 AND job_id=$2 ORDER BY terminal LIMIT 2',
  originalMembership:
    'SELECT 1 FROM semantic.identity_epoch_original WHERE partition_no=$1 AND generation=$2 AND original=$3 AND terminal=$4 AND present',
  libraryReplay: `SELECT c.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_receiving_record r
       JOIN semantic.identity_epoch_native_commit c
         ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
       WHERE r.partition_no=$1 AND r.job_id=$2 AND r.job_epoch=$3 AND r.effect_key=$4 AND r.original=$5`,
  existingPlan:
    'SELECT binding_digest FROM semantic.identity_epoch_receiving_plan WHERE partition_no=$1 AND job_id=$2 AND effect_key=$3',
  completedStep: `SELECT 1 FROM semantic.identity_epoch_ack WHERE partition_no=$1 AND job_id=$2 AND step=$3
      AND progress->>'state'='complete'`,
  expectEffect: `INSERT INTO semantic.identity_epoch_effect_receipt(partition_no,job_id,step,effect_key,kind)
      VALUES($1,$2,$3,$4,$5)`,
  insertPlan: `INSERT INTO semantic.identity_epoch_receiving_plan(partition_no,job_id,job_epoch,effect_key,binding,binding_digest,transaction_id)
        VALUES($1,$2,$3,$4,$5,$6,$7)`,
  acceptedReplay: `SELECT r.transaction_id,r.binding_digest,c.epoch,c.position FROM semantic.identity_epoch_receiving_record r
      JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(r.partition_no,r.transaction_id)
      WHERE r.partition_no=$1 AND r.job_id=$2 AND r.effect_key=$3
      AND c.purpose='identity-receiving-record' AND c.xmin=r.xmin
      AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid`,
  acceptedGate: `SELECT pending_job,pending_epoch FROM semantic.identity_epoch_receiving_gate
        WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 FOR UPDATE`,
  retainGate: `INSERT INTO semantic.identity_epoch_receiving_gate(partition_no,owner_id,original,owner_epoch,pending_job,pending_epoch)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(partition_no,owner_id,original) DO UPDATE
      SET pending_job=EXCLUDED.pending_job,pending_epoch=EXCLUDED.pending_epoch
      WHERE semantic.identity_epoch_receiving_gate.owner_epoch=EXCLUDED.owner_epoch AND
       (semantic.identity_epoch_receiving_gate.pending_job IS NULL OR
        (semantic.identity_epoch_receiving_gate.pending_job,semantic.identity_epoch_receiving_gate.pending_epoch)=(EXCLUDED.pending_job,EXCLUDED.pending_epoch))
      RETURNING owner_id`,
  insertAccepted: `INSERT INTO semantic.identity_epoch_receiving_record
        (partition_no,job_id,job_epoch,effect_key,owner_id,original,owner_epoch,binding,binding_digest,plan,source_hold,transaction_id,native_hold)
        SELECT $1,$2,$3,$4,$5,$6,$7,$8,$9,$10,
          jsonb_build_object('partition',c.partition_no,'transactionId',c.transaction_id,
            'epoch',c.epoch,'position',c.position::text),$11,$12
        FROM semantic.identity_epoch_native_commit c
        WHERE c.partition_no=$1 AND c.transaction_id=$11 AND c.purpose='identity-receiving-record'`,
  lookupGate: `SELECT pending_job,pending_epoch FROM semantic.identity_epoch_receiving_gate
    WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 FOR UPDATE`,
  sameCommandApplied: `SELECT 1 FROM semantic.identity_epoch_receiving_effect e
        JOIN semantic.identity_epoch_native_commit c ON (c.partition_no,c.transaction_id)=(e.partition_no,e.transaction_id)
        JOIN semantic.identity_epoch_step s ON (s.partition_no,s.transaction_id)=(e.partition_no,e.transaction_id)
        WHERE e.partition_no=$1 AND e.job_id=$2 AND e.effect_key=$3 AND e.transaction_id=$4
        AND c.purpose=$5 AND c.xmin=e.xmin AND s.xmin=c.xmin
        AND s.job_id=e.job_id AND s.job_epoch=$6 AND s.step=$5 AND s.version=1
        AND s.scope_digest=$7 AND s.frontier=e.frontier AND s.native_epoch=c.epoch AND s.native_position=c.position`,
  insertApplied: `INSERT INTO semantic.identity_epoch_receiving_effect(partition_no,job_id,effect_key,transaction_id,frontier)
      VALUES($1,$2,$3,$4,$5)`,
  expectedApplied: `SELECT native_partition,native_epoch,native_position,native_transaction_id
      FROM semantic.identity_epoch_effect_receipt WHERE partition_no=$1 AND job_id=$2 AND step=$3 AND effect_key=$4 FOR UPDATE`,
  controlCustody: `SELECT c.transaction_id,c.epoch,c.position FROM semantic.identity_epoch_native_commit c
        JOIN semantic.identity_epoch_receiving_custody a ON (a.partition_no,a.transaction_id)=(c.partition_no,c.transaction_id)
        WHERE a.partition_no=$1 AND a.job_id=$2 AND a.effect_key=$3 AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin
        AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid`,
  acknowledgeApplied: `UPDATE semantic.identity_epoch_effect_receipt SET native_partition=$5,native_epoch=$6,native_position=$7,native_transaction_id=$8
      WHERE partition_no=$1 AND job_id=$2 AND step=$3 AND effect_key=$4 AND native_transaction_id IS NULL`,
  insertCustody: `INSERT INTO semantic.identity_epoch_receiving_custody(partition_no,job_id,effect_key,transaction_id) VALUES($1,$2,$3,$4)`,
  publishedCustody: `SELECT 1 FROM semantic.identity_epoch_effect_receipt e
       JOIN semantic.identity_epoch_receiving_custody a ON
        (a.partition_no,a.job_id,a.effect_key)=(e.partition_no,e.job_id,e.effect_key)
       JOIN semantic.identity_epoch_native_commit c ON
        (c.partition_no,c.transaction_id)=(a.partition_no,a.transaction_id)
       WHERE e.partition_no=$1 AND e.job_id=$2 AND e.step=$3 AND e.effect_key=$4
        AND (e.native_partition,e.native_epoch,e.native_position,e.native_transaction_id)=($5,$6,$7,$8)
        AND c.purpose='identity-receiving-custody' AND c.xmin=a.xmin
        AND c.xmin IS DISTINCT FROM pg_current_xact_id_if_assigned()::xid`,
  releaseGate: `UPDATE semantic.identity_epoch_receiving_gate SET pending_job=NULL,pending_epoch=NULL
      WHERE partition_no=$1 AND owner_id=$2 AND original=$3 AND owner_epoch=$4 AND pending_job=$5 AND pending_epoch=$6`,
});
/** Additional exact literals dispatched by the canonical command/read and role executors.
 * statement_timeout is the sole numeric template; all other statements compare exact normalized text.
 */
export const commonSearchReceivingStatements: readonly string[] = Object.freeze([
  ...new Map(
    [
      ...Object.entries(receivingStatements)
        .filter(([name]) => name !== 'libraryReplay')
        .map(([, sql]) => sql),
      ...Object.values(searchReceivingCaptureStatements),
      receivingJob.sql,
      receivingPlan.sql,
      receivingLookup.sql,
      receivingSelection.sql,
      searchProgressRead.sql,
      searchProgressInsert.sql,
      searchProgressAdvance.sql,
      searchProgressRelease.sql,
      searchUnreleased.sql,
      nativeCommit.sql,
      partitionRead.sql,
      commandTime.sql,
      commandFence.sql,
      commandNoEffect.sql,
      participantNext.sql,
      participantStep.sql,
      participantAdvance.sql,
      participantReplay.sql,
      participantJob.sql,
      participantAck.sql,
      nativeDefinition.sql,
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      'ROLLBACK',
      'COMMIT',
      "SET LOCAL lock_timeout = '200ms'",
      "SET LOCAL statement_timeout = '<remaining>ms'",
      "SELECT set_config('semantic.erasure_native_transaction',$1,true)",
      `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
      SELECT $1,$2,account_id,role FROM unnest($3::uuid[],$4::text[]) AS input(account_id,role) ON CONFLICT DO NOTHING`,
      `SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j
     JOIN semantic.erasure_locator l ON l.partition_no=j.partition_no AND l.store='identity_epoch_job' AND l.record_key=j.erasure_key
     WHERE j.partition_no=$1 AND j.job_id=$2 ORDER BY l.account_id,l.role LIMIT 9`,
    ].map((sql) => [receivingSqlKey(sql), sql] as const),
  ).values(),
]);

type Cost = readonly [rows: number, points: number, statements: number, bytes: number, emptySeeks: number];
/** Both statements have an explicit bounded raw size, independent of observed result rows. */
export const searchReceivingOwnedPageStatements = Object.freeze([
  Object.freeze({ sql: searchNativeReceivingStatements.copies.sql, kind: 'copies' as const }),
  Object.freeze({ sql: searchNativeReceivingStatements.insertCopies.sql, kind: 'insertCopies' as const }),
]);
const work = ([nativeRows, nativePoints, statements, bytes, emptySeeks]: Cost): WorkDimensions =>
  Object.freeze({
    candidateKeys: 0,
    identityMetadataRows: 0,
    nativeRows,
    nativePoints,
    witnessKeys: 0,
    statements,
    bytes,
    emptySeeks,
  });
/** Immediate costs below include FKs, sequence work and both operational queues. Their complete
 * original-role deferred capture is additionally traversed and reserved on the same client before
 * COMMIT by identity-search-receiving-capture.ts. It cannot be replaced by the maintenance roles.
 */
export const searchReceivingDeferredCaptureStatements = Object.freeze([
  receivingStatements.expectEffect,
  receivingStatements.insertPlan,
  receivingStatements.insertAccepted,
  receivingStatements.insertApplied,
  receivingStatements.acknowledgeApplied,
  receivingStatements.insertCustody,
  participantStep.sql,
]);
const receivingCost: Partial<Record<keyof typeof receivingStatements, Cost>> = {
  inputBasis: [2, 1, 1, 512, 1],
  originalMembership: [1, 1, 1, 256, 1],
  libraryReplay: [2, 2, 1, 512, 1],
  existingPlan: [1, 1, 1, 256, 1],
  completedStep: [1, 1, 1, 256, 1],
  expectEffect: [5, 5, 5, 1280, 0],
  insertPlan: [8, 8, 8, 8192, 0],
  insertAccepted: [7, 7, 7, 16384, 0],
  insertApplied: [6, 6, 6, 4096, 0],
  acknowledgeApplied: [3, 3, 3, 1024, 0],
  insertCustody: [6, 6, 6, 1536, 0],
  acceptedReplay: [2, 2, 1, 512, 1],
  acceptedGate: [1, 1, 1, 256, 1],
  retainGate: [1, 2, 1, 512, 0],
  lookupGate: [1, 1, 1, 256, 1],
  sameCommandApplied: [3, 3, 1, 4096, 1],
  expectedApplied: [1, 1, 1, 512, 1],
  controlCustody: [2, 2, 1, 512, 1],
  publishedCustody: [3, 3, 1, 512, 1],
  releaseGate: [1, 1, 1, 256, 0],
};

/** Capture-enabled owned inventory plus same-frame dynamic deferred capture. Source/release/projection SQL
 * still need their actual transitive declarations. This does not establish the foreign envelope.
 * Every supplied cost is an operation bound, never an observed rowCount refund.
 */
export function searchReceivingCapturedStatementCosts(): SearchReceivingWorkDeclaration['statements'] {
  const costs = new Map<string, Readonly<{ sql: string; work: WorkDimensions }>>();
  const add = (sql: string, cost: Cost) => costs.set(receivingSqlKey(sql), Object.freeze({ sql, work: work(cost) }));
  for (const entry of searchReceivingCaptureStatementCosts) costs.set(receivingSqlKey(entry.sql), entry);
  for (const [name, sql] of Object.entries(receivingStatements)) {
    const cost = receivingCost[name as keyof typeof receivingStatements];
    if (name !== 'libraryReplay' && cost) add(sql, cost);
  }
  for (const [sql, cost] of [
    [receivingJob.sql, [3, 3, 1, 2048, 1]],
    [receivingPlan.sql, [3, 3, 1, 8192, 1]],
    [receivingLookup.sql, [8, 8, 1, 16384, 1]],
    [receivingSelection.sql, [3, 3, 1, 512, 1]],
    [searchProgressRead.sql, [2, 2, 1, 2560, 1]],
    [searchProgressInsert.sql, [2, 2, 1, 512, 0]],
    [searchProgressAdvance.sql, [1, 1, 1, 2560, 0]],
    [searchProgressRelease.sql, [1, 1, 1, 512, 0]],
    [searchUnreleased.sql, [1, 1, 1, 256, 1]],
    [nativeCommit.sql, [2, 2, 1, 128, 0]],
    [partitionRead.sql, [1, 1, 1, 512, 1]],
    [commandTime.sql, [1, 1, 1, 128, 0]],
    [commandFence.sql, [2, 2, 1, 2048, 0]],
    [commandNoEffect.sql, [1, 1, 1, 256, 0]],
    [participantNext.sql, [6, 6, 1, 16384, 1]],
    [participantStep.sql, [6, 6, 6, 4096, 0]],
    [participantAdvance.sql, [7, 7, 1, 16384, 1]],
    [participantReplay.sql, [5, 5, 1, 4096, 1]],
    [participantJob.sql, [1, 1, 1, 4096, 1]],
    [participantAck.sql, [3, 1, 1, 8192, 1]],
    [nativeDefinition.sql, [3, 3, 1, 2048, 1]],
  ] satisfies readonly (readonly [string, Cost])[])
    add(sql, cost);
  for (const sql of [
    'BEGIN ISOLATION LEVEL SERIALIZABLE',
    'BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY',
    'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
    'ROLLBACK',
    'COMMIT',
    "SET LOCAL lock_timeout = '200ms'",
    "SET LOCAL statement_timeout = '<remaining>ms'",
  ])
    add(sql, [0, 0, 1, 0, 0]);
  add("SELECT set_config('semantic.erasure_native_transaction',$1,true)", [1, 0, 1, 128, 0]);
  add(
    `INSERT INTO semantic.erasure_source_role(partition_no,transaction_id,account_id,role)
      SELECT $1,$2,account_id,role FROM unnest($3::uuid[],$4::text[]) AS input(account_id,role) ON CONFLICT DO NOTHING`,
    [8, 8, 1, 2048, 0],
  );
  add(
    `SELECT l.account_id::text,l.role FROM semantic.identity_epoch_job j
     JOIN semantic.erasure_locator l ON l.partition_no=j.partition_no AND l.store='identity_epoch_job' AND l.record_key=j.erasure_key
     WHERE j.partition_no=$1 AND j.job_id=$2 ORDER BY l.account_id,l.role LIMIT 9`,
    [10, 2, 1, 2048, 1],
  );
  for (const [name, statement] of Object.entries(searchNativeReceivingStatements)) {
    const [rows, points, bytes] = searchNativeReceivingSqlCost[name as keyof typeof searchNativeReceivingSqlCost];
    add(statement.sql, [rows, points, 1, bytes, 0]);
  }
  return Object.freeze([...costs.values()]);
}

/** The original local subtotal deliberately cannot admit the capture graph. Only the installed
 * composer uses the capture-enabled inventory together with its same-client pre-COMMIT planner.
 * Keeping this distinction prevents a legacy subtotal from silently treating deferred work as zero.
 */
export function searchReceivingOwnedStatementCosts(): SearchReceivingWorkDeclaration['statements'] {
  const deferred = new Set(searchReceivingDeferredCaptureStatements.map(receivingSqlKey));
  return Object.freeze(
    searchReceivingCapturedStatementCosts().filter(({ sql }) => !deferred.has(receivingSqlKey(sql))),
  );
}

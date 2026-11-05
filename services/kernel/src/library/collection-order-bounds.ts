import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import accountShare from '../access/account-share.sql';
import eventFence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import readTime from '../command/time.sql';
import {
  GENERATED_ORDINAL_KEY_LENGTH,
  MAX_ORDINAL_KEY_LENGTH,
  ORDER_BATCH_SIZE,
  ORDER_WINDOW_SIZE,
} from './ordinal.ts';
import { WORK_STEP_DEADLINE_MS } from './command-support.ts';

const zero = (): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: 0,
    engineRequests: 0,
  });

const dimensions = (values: Partial<Bound>): Bound => declareBound({ ...zero(), ...values });
const bytes = (amount: number): Bound => dimensions({ bytes: amount });
const routeBytes = 5; // PostgreSQL integer route 0..65535, text format.
const partitionBytes = 4; // Core partition number 0..4095, text format.
const uuidBytes = 36;
const integerBytes = 10; // PostgreSQL signed integer domain, text format.
const bigintBytes = 19; // PostgreSQL signed bigint domain, text format.
const ordinalBytes = MAX_ORDINAL_KEY_LENGTH;
export const COLLECTION_ORDER_MAX_STEP = 2_147_483_647;

/** These are the exact SQL literals used by the Library repair callers. */
export const COLLECTION_ORDER_SQL = Object.freeze({
  parent: `SELECT curator_account_id AS "curatorAccountId", state, membership_kind AS "membershipKind",
       member_count AS "memberCount", revision, source_generation::text AS "sourceGeneration", order_epoch AS "orderEpoch"
     FROM library.collection WHERE route=$1 AND collection_id=$2 FOR UPDATE`,
  barrier: `SELECT 1 FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND state='active'`,
  beginRepair: `SELECT repair_id AS "repairId", step,state FROM library.collection_order_repair
     WHERE route=$1 AND collection_id=$2`,
  removeTerminalRepair: `DELETE FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3 AND state<>'active'`,
  originalMinimum: `SELECT ordinal_key AS key FROM library.collection_member WHERE route=$1 AND collection_id=$2
     ORDER BY ordinal_key,member_id LIMIT 1`,
  insertRepair: `INSERT INTO library.collection_order_repair
       (route,collection_id,repair_id,admitted_count,original_minimum,lower_key,upper_key,
        admitted_revision,admitted_source_generation,admitted_order_epoch,
        expected_revision,expected_source_generation,expected_order_epoch)
     VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,$8,$9,$10)`,
  lockRepair: `SELECT repair_id AS "repairId", admitted_count AS "admittedCount", original_minimum AS minimum,
           lower_key AS lower, upper_key AS upper, expected_revision AS revision,
           expected_source_generation::text AS "sourceGeneration", expected_order_epoch AS "orderEpoch",
           processed,step,after_key AS "afterKey",after_member_id AS "afterMemberId",state
         FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3 FOR UPDATE`,
  originals: `SELECT member_id AS "memberId",ordinal_key AS "ordinalKey",deletion_id IS NULL AS active
       FROM library.collection_member WHERE route=$1 AND collection_id=$2
         AND ordinal_key >= $3::text COLLATE "C"
         AND (ordinal_key,member_id) > ($4::text COLLATE "C",$5::uuid)
       ORDER BY ordinal_key,member_id LIMIT $6`,
  advanceRepair: `UPDATE library.collection_order_repair SET processed=$4,step=$5,after_key=$6,after_member_id=$7,
         expected_revision=expected_revision+1,expected_source_generation=expected_source_generation+1,
         expected_order_epoch=expected_order_epoch+1,writer_xid=pg_current_xact_id(),state=$8
       WHERE route=$1 AND collection_id=$2 AND repair_id=$3 AND state='active' AND step=$9
         AND expected_revision=$10 AND expected_source_generation=$11 AND expected_order_epoch=$12
       RETURNING repair_id`,
  rewriteOriginal: `UPDATE library.collection_member SET ordinal_key=$4,transaction_id=$5
         WHERE route=$1 AND collection_id=$2 AND member_id=$3 AND ordinal_key=$6 AND deletion_id IS NULL`,
  advanceParent: `UPDATE library.collection SET revision=revision+1,source_generation=source_generation+1,
         order_epoch=order_epoch+1,updated_at=$7::timestamptz,transaction_id=$8
       WHERE route=$1 AND collection_id=$2 AND state='active' AND member_count=$3
         AND revision=$4 AND source_generation=$5 AND order_epoch=$6 RETURNING collection_id`,
  removeExactRepair: 'DELETE FROM library.collection_order_repair WHERE route=$1 AND collection_id=$2 AND repair_id=$3',
});
export const COLLECTION_ORDER_WORKFLOW = 'library.collectionOrderRepair';

const sql = (query: string) => Buffer.byteLength(query, 'utf8');
const query = (text: string, inputBytes: number, projectedBytes: number, counts: Partial<Bound>): Bound =>
  sumBounds(dimensions({ statements: 1, ...counts }), bytes(sql(text) + inputBytes + projectedBytes));

const parentProjectionBytes = uuidBytes + 7 + 7 + integerBytes + integerBytes + bigintBytes + integerBytes;
const repairProjectionBytes =
  uuidBytes +
  integerBytes +
  3 * ordinalBytes +
  integerBytes +
  bigintBytes +
  integerBytes +
  integerBytes +
  integerBytes +
  ordinalBytes +
  uuidBytes +
  9;
const rawProjectionBytes = uuidBytes + ordinalBytes + 5;
const bindParent = routeBytes + uuidBytes;
const parentLock = query(COLLECTION_ORDER_SQL.parent, bindParent, parentProjectionBytes, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});
const beginRepairRead = query(COLLECTION_ORDER_SQL.beginRepair, bindParent, uuidBytes + integerBytes + 9, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});
const terminalRepairDelete = query(COLLECTION_ORDER_SQL.removeTerminalRepair, bindParent + uuidBytes, 0, {
  nativeRows: 1,
  nativePoints: 1,
});
const originalMinimum = query(COLLECTION_ORDER_SQL.originalMinimum, bindParent, ordinalBytes, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});
const repairInsert = query(
  COLLECTION_ORDER_SQL.insertRepair,
  routeBytes + 2 * uuidBytes + integerBytes + 3 * ordinalBytes + integerBytes + bigintBytes + integerBytes,
  0,
  { nativeRows: 1, nativePoints: 1 },
);
const activeBarrier = query(COLLECTION_ORDER_SQL.barrier, bindParent, 1, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});

const triggerParent = `SELECT curator_account_id,state FROM library.collection
    WHERE route=owner_route AND collection_id=owner_id FOR UPDATE`;
const triggerRepair = `SELECT * FROM library.collection_order_repair
    WHERE route=owner_route AND collection_id=owner_id AND state='active'`;
const triggerAccount = `SELECT state <> 'active' OR authn_fenced INTO terminal FROM access.account
      WHERE route=get_byte(uuid_send(curator),10)*256+get_byte(uuid_send(curator),11) AND account_id=curator`;
const triggerParentGuard = query(triggerParent, 0, uuidBytes + 7, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
});
// SELECT * is intentional in both migration triggers; derive the maximum row
// projection from the repair table's fixed integer/UUID/text/xid8 columns.
const repairTriggerProjectionBytes =
  routeBytes +
  2 * uuidBytes +
  integerBytes +
  3 * ordinalBytes +
  4 * integerBytes +
  2 * bigintBytes +
  2 * integerBytes +
  ordinalBytes +
  uuidBytes +
  9 +
  20;
const triggerRepairGuard = query(triggerRepair, 0, repairTriggerProjectionBytes, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
});
const triggerRepairMissing = query(triggerRepair, 0, 0, {
  candidateKeys: 1,
  nativePoints: 1,
  emptySeeks: 1,
});
const triggerAccountGuard = query(triggerAccount, 0, 5, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
});
const memberGuardTriggers = sumBounds(triggerParentGuard, triggerRepairGuard, triggerAccountGuard);
const memberUpdate = query(
  COLLECTION_ORDER_SQL.rewriteOriginal,
  routeBytes + 3 * uuidBytes + ordinalBytes + GENERATED_ORDINAL_KEY_LENGTH,
  0,
  { nativeRows: 1, nativePoints: 1, witnessKeys: 1 },
);
const progressUpdate = query(
  COLLECTION_ORDER_SQL.advanceRepair,
  routeBytes +
    2 * uuidBytes +
    integerBytes +
    integerBytes +
    ordinalBytes +
    uuidBytes +
    9 +
    integerBytes +
    integerBytes +
    bigintBytes +
    integerBytes,
  uuidBytes,
  { nativeRows: 1, nativePoints: 1 },
);
const parentUpdate = query(
  COLLECTION_ORDER_SQL.advanceParent,
  routeBytes + uuidBytes + integerBytes + integerBytes + bigintBytes + integerBytes + 29 + uuidBytes,
  uuidBytes,
  { nativeRows: 1, nativePoints: 1 },
);
const removeRepair = query(COLLECTION_ORDER_SQL.removeExactRepair, bindParent + uuidBytes, 0, {
  nativeRows: 1,
  nativePoints: 1,
});
const repairLock = query(COLLECTION_ORDER_SQL.lockRepair, bindParent + uuidBytes, repairProjectionBytes, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});
const accountShareCost = query(accountShare.sql, bindParent, 13, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});

const rawPage = (size: number): Bound => {
  const limitBytes = String(size).length;
  return query(
    COLLECTION_ORDER_SQL.originals,
    routeBytes + uuidBytes + ordinalBytes + ordinalBytes + uuidBytes + limitBytes,
    size * rawProjectionBytes,
    { candidateKeys: size, nativeRows: size, emptySeeks: size === 0 ? 1 : 0 },
  );
};
const rewriteRows = (active: number, completes: boolean): Bound =>
  sumBounds(
    repeatBound(memberUpdate, active),
    repeatBound(completes ? sumBounds(triggerParentGuard, triggerRepairMissing) : memberGuardTriggers, active),
  );

const accountLifecycleShare = accountShareCost;
const pageCurrentness = sumBounds(parentLock, repairLock, accountLifecycleShare);

const locatorBytes = Buffer.byteLength(
  JSON.stringify({ collectionId: '0'.repeat(uuidBytes), repairId: '0'.repeat(uuidBytes), step: 2_147_483_647 }),
);
const eventUpdatedBytes = Buffer.byteLength(
  JSON.stringify({
    type: 'com.rezics.library.collection.updated.v1',
    subject: '0'.repeat(uuidBytes),
    data: { collectionId: '0'.repeat(uuidBytes) },
    id: '0'.repeat(uuidBytes),
  }),
);
const eventRepairBytes = Buffer.byteLength(
  JSON.stringify({
    type: 'com.rezics.library.collection.order-repair.advanced.v1',
    subject: '0'.repeat(uuidBytes),
    data: { collectionId: '0'.repeat(uuidBytes), repairId: '0'.repeat(uuidBytes), step: 2_147_483_647 },
    id: '0'.repeat(uuidBytes),
  }),
);
const beginResultBytes = locatorBytes;
const retryLimit = COMMAND_STEP_RETRIES.maxAttempts;

const timeoutSql = `SET LOCAL statement_timeout = '${WORK_STEP_DEADLINE_MS}ms'`;
const lockTimeoutSql = "SET LOCAL lock_timeout = '200ms'";
const beginSql = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
const beginControl = dimensions({
  statements: 3,
  bytes: sql(beginSql) + sql(lockTimeoutSql) + sql(timeoutSql),
});
const pageControls = sumBounds(
  beginControl,
  query(readTime.sql, 24, 29, { nativeRows: 1, nativePoints: 1 }),
  dimensions({ statements: 1, bytes: sql(timeoutSql) }),
);
const commitControl = dimensions({ statements: 1, bytes: sql('COMMIT') });
const rollbackControl = dimensions({ statements: 1, bytes: sql('ROLLBACK') });
const eventFenceCost = (eventCount: number, eventBytes: number): Bound =>
  query(eventFence.sql, eventBytes + eventCount + 1 + uuidBytes + partitionBytes + 8, integerBytes + bigintBytes, {
    candidateKeys: 1,
    emptySeeks: 1,
    nativeRows: eventCount + 1,
    nativePoints: eventCount + 1,
  });
const noEffectCost = query(noEffectFence.sql, partitionBytes + uuidBytes + 4, integerBytes + bigintBytes, {
  candidateKeys: 1,
  nativeRows: 1,
  nativePoints: 1,
  emptySeeks: 1,
});

const pageData = (size: number, active: number, completes: boolean): Bound =>
  sumBounds(
    pageCurrentness,
    rawPage(size),
    rewriteRows(active, completes),
    progressUpdate,
    parentUpdate,
    // Active pages hit the lifecycle guard per rewritten occurrence and on the
    // parent CAS. A terminal page has already marked the capture complete, so its
    // triggers perform the bounded empty active-repair seek without account reads.
    repeatBound(completes ? triggerRepairMissing : sumBounds(triggerRepairGuard, triggerAccountGuard), 1),
    dimensions({
      nativeRows: 1,
      nativePoints: 1,
      bytes: GENERATED_ORDINAL_KEY_LENGTH * active,
    }), // Generated keys are 32 bytes; original stored keys remain capped at 48.
    dimensions({ bytes: Buffer.byteLength(JSON.stringify({ state: completes ? 'complete' : 'more' })) }),
  );

const stalePage = sumBounds(pageControls, pageCurrentness, noEffectCost, commitControl);
const terminalPage = sumBounds(
  pageControls,
  pageCurrentness,
  removeRepair,
  dimensions({ bytes: eventUpdatedBytes }),
  eventFenceCost(1, eventUpdatedBytes),
  commitControl,
);
const fullPageData = pageData(ORDER_WINDOW_SIZE, ORDER_WINDOW_SIZE, false);
const fullPageSuccess = sumBounds(
  pageControls,
  fullPageData,
  eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
  commitControl,
);
const shortPageSuccess = sumBounds(
  pageControls,
  pageData(ORDER_WINDOW_SIZE - 1, ORDER_WINDOW_SIZE - 1, true),
  eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
  commitControl,
);
const exhaustionSuccess = sumBounds(
  pageControls,
  pageData(0, 0, true),
  eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
  commitControl,
);
const changedFenceRollback = sumBounds(pageControls, pageCurrentness, rollbackControl);
const failedFullPage = sumBounds(
  pageControls,
  fullPageData,
  eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
  commitControl,
  rollbackControl,
);
const failedFullThenSuccess = sumBounds(repeatBound(failedFullPage, retryLimit - 1), fullPageSuccess);
const allFullAttemptsFail = repeatBound(failedFullPage, retryLimit);
const committedReplay = sumBounds(fullPageSuccess, repeatBound(stalePage, retryLimit - 1));

function maxBound(...values: readonly Bound[]): Bound {
  return declareBound(
    Object.fromEntries(BOUND_AXES.map((axis) => [axis, Math.max(...values.map((value) => value[axis]))])),
  );
}

const pageCeiling = maxBound(
  stalePage,
  terminalPage,
  changedFenceRollback,
  fullPageSuccess,
  shortPageSuccess,
  exhaustionSuccess,
  failedFullThenSuccess,
  allFullAttemptsFail,
  committedReplay,
);

const beginReuse = sumBounds(parentLock, beginRepairRead);
const beginEmpty = sumBounds(parentLock, beginRepairRead, terminalRepairDelete);
const beginFresh = sumBounds(parentLock, beginRepairRead, originalMinimum, repairInsert);
const beginReplaceTerminal = sumBounds(
  parentLock,
  beginRepairRead,
  terminalRepairDelete,
  originalMinimum,
  repairInsert,
);
const beginSqlCeiling = maxBound(beginReuse, beginEmpty, beginFresh, beginReplaceTerminal);
const barrierCeiling = sumBounds(parentLock, activeBarrier);
const continuationRequest = dimensions({
  engineRequests: 1,
  bytes:
    locatorBytes +
    Buffer.byteLength(
      JSON.stringify({
        workflowName: COLLECTION_ORDER_WORKFLOW,
        queueName: 'maintenance',
        workflowID: `${COLLECTION_ORDER_WORKFLOW}:${'0'.repeat(uuidBytes)}:2147483647`,
        workflowIDReusePolicy: 'return-existing',
      }),
    ),
});

export const COLLECTION_ORDER_DECLARATION = Object.freeze({
  status: 'finite-owner-declarations' as const,
  axes: BOUND_AXES,
  limits: Object.freeze({
    rawWindow: ORDER_WINDOW_SIZE,
    sourcePage: ORDER_BATCH_SIZE,
    repairStep: COLLECTION_ORDER_MAX_STEP,
    activeOccurrences: ORDER_WINDOW_SIZE,
    generatedKeyBytes: ORDER_WINDOW_SIZE * GENERATED_ORDINAL_KEY_LENGTH,
    storedKeyBytes: MAX_ORDINAL_KEY_LENGTH,
    memberCount: 2_147_483_647,
    retries: retryLimit,
    pageCommandReceipts: 0,
    deferredUniqueConstraintStatements: 0,
    occurrenceHistoryEventsPerRewrite: 0,
  }),
  terms: Object.freeze({
    barrier: barrierCeiling,
    beginSql: beginSqlCeiling,
    beginLocatorSerialization: dimensions({ bytes: beginResultBytes }),
    pageCurrentness,
    pageRawWindow: rawPage(ORDER_WINDOW_SIZE),
    pageActiveWrites: rewriteRows(ORDER_WINDOW_SIZE, false),
    pageFull: fullPageSuccess,
    pageShort: shortPageSuccess,
    pageExhaustion: exhaustionSuccess,
    pageStale: stalePage,
    pageTerminalCleanup: terminalPage,
    pageChangedFenceRollback: changedFenceRollback,
    pageRetryFailure: failedFullPage,
    continuationRequest,
  }),
  paths: Object.freeze({
    edit: Object.freeze({
      status: 'execution-binding-only' as const,
      missing:
        'The original actor command composition is not a complete nine-axis declaration. Its current Access preparation, authorization, receipt, result and transaction envelope remains to be derived.',
    }),
    barrier: Object.freeze({
      status: 'library-sql-only' as const,
      cost: barrierCeiling,
      ceiling: barrierCeiling,
      missing: 'The enclosing actor command has no whole-operation Bound admission port.',
    }),
    begin: Object.freeze({
      status: 'library-sql-only' as const,
      cost: beginSqlCeiling,
      ceiling: beginSqlCeiling,
      missing:
        'The ordinary actor-authorized runCommand path has no public whole-command Bound admission for Access preparation and authorization, account lifecycle share, authoritative time, receipt and History work, result serialization, event/outbox work, controls, and rollback/commit.',
    }),
    page: Object.freeze({
      status: 'complete-static-no-admission' as const,
      cost: pageCeiling,
      ceiling: pageCeiling,
      missing:
        'runCommand has no owner Bound admission port; this declaration describes bounded page work without reserving or funding dispatch. The committed outbox enqueue is a separately declared continuation request.',
    }),
    continuation: Object.freeze({
      status: 'payload-only' as const,
      cost: continuationRequest,
      ceiling: continuationRequest,
      missing: 'The DBOS client does not accept this nine-axis declaration for its durable enqueue transaction.',
    }),
  }),
});

if (
  !withinCeiling(barrierCeiling, barrierCeiling) ||
  !withinCeiling(beginSqlCeiling, beginSqlCeiling) ||
  !withinCeiling(pageCeiling, pageCeiling)
)
  throw new TypeError('Collection order declaration is not a finite ceiling');

/** A static ceiling check only. It does not authorize work, reserve a Source ledger or fund dispatch. */
export function withinCollectionOrderCeiling<T>(cost: unknown, ceiling: Bound, dispatch: () => T): T {
  const declared = declareBound(cost);
  if (!withinCeiling(declared, ceiling)) throw new TypeError('Collection order work exceeds its static ceiling');
  return dispatch();
}

export type CollectionOrderPath = keyof typeof COLLECTION_ORDER_DECLARATION.paths;

export function withCollectionOrderDeclaration<T>(path: CollectionOrderPath, dispatch: () => T): T {
  const declaration = COLLECTION_ORDER_DECLARATION.paths[path];
  if (!('cost' in declaration)) return dispatch();
  return withinCollectionOrderCeiling(declaration.cost, declaration.ceiling, dispatch);
}

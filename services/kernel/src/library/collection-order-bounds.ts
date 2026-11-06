import { memoizedValue } from '../memoized.ts';
import { BOUND_AXES, declareBound, repeatBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import { MEMBERSHIP_LIMIT } from '../access/membership-inverse.ts';
import { accessNativeDeclaration, type AccessWork } from '../access/work.ts';
import accountRead from '../access/account-read.sql';
import accountShare from '../access/account-share.sql';
import permissionAssignment from '../access/permission-assignment.sql';
import permissionCandidates from '../access/permission-candidates.sql';
import permissionCheck from '../access/permission-check.sql';
import permissionInverse from '../access/permission-inverse.sql';
import permissionMembership from '../access/permission-membership.sql';
import permissionTime from '../access/permission-time.sql';
import eventFence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import receiptRead from '../command/read-receipt.sql';
import readTime from '../command/time.sql';
import { COMMAND_HISTORY_KINDS } from '../history/record.ts';
import partitionRead from '../partition/read.sql';
import { COMMAND_STEP_RETRIES } from '../work/retries.ts';
import collectionAuthorization from './collection-store-collection-authorization.sql';
import collectionRead from './collection-store-collection-read.sql';
import memberInsert from './collection-store-collection-member-insert.sql';
import memberMove from './collection-store-collection-member-move.sql';
import memberNeighbors from './collection-store-collection-member-neighbors.sql';
import memberRead from './collection-store-collection-member-read.sql';
import membersRespace from './collection-store-collection-members-respace.sql';
import collectionDefer from './collection-batch-defer.sql';
import shelfAuthorizedCollection from './shelf-maintenance-authorized-collection.sql';
import {
  GENERATED_ORDINAL_KEY_LENGTH,
  MAX_ORDINAL_KEY_LENGTH,
  ORDER_BATCH_SIZE,
  ORDER_WINDOW_SIZE,
} from './ordinal.ts';
import { WORK_STEP_DEADLINE_MS } from './work-step-deadline.ts';
import { sessionShelfWork } from './session-operation-bounds.ts';

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
function ordinalBytes() {
  return memoizedValue(ordinalBytes, () => MAX_ORDINAL_KEY_LENGTH);
}
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
  editLeft: `SELECT member_id AS "memberId", ordinal_key AS "ordinalKey" FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key <= $3::text COLLATE "C"
       AND NOT (member_id=ANY($4::uuid[]))
     ORDER BY ordinal_key DESC, member_id DESC LIMIT $5`,
  editRight: `SELECT member_id AS "memberId", ordinal_key AS "ordinalKey" FROM library.collection_member
     WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND ordinal_key >= $3::text COLLATE "C"
       AND NOT (member_id=ANY($4::uuid[]))
     ORDER BY ordinal_key, member_id LIMIT $5`,
  editFence: `SELECT collection.revision::text || ':' || collection.source_generation::text || ':' ||
                collection.order_epoch::text || ':' || account.minimum_authn_epoch::text AS fence
       FROM library.collection AS collection JOIN access.account AS account
         ON account.route=collection.route AND account.account_id=collection.curator_account_id
       WHERE collection.route=$1 AND collection.collection_id=$2`,
  touchCollection: `UPDATE library.collection
        SET updated_at = $1::timestamptz, transaction_id = $2::uuid,
            revision = revision + $5::integer, source_generation = source_generation + $5::integer
      WHERE route = $3 AND collection_id = $4 AND state = 'active'
      RETURNING revision`,
  moveMemberSetting: "SELECT set_config('library.collection_structure_move_member', $1, true)",
});
export const COLLECTION_ORDER_WORKFLOW = 'library.collectionOrderRepair';
export const COLLECTION_ORDER_COMMAND_KINDS = Object.freeze({
  add: 'library.collection.member.add',
  move: 'library.collection.member.move',
  begin: 'library.collection.order.repair.begin',
});
const NOTE_LIMIT = 1_000;
const RECEIPT_KEY_CANDIDATES = 5;
const ACTOR_MEMBERS = 2;
const STRUCTURE_HISTORY_RETAINED = 1_000;
const STRUCTURE_HISTORY_OPERATIONS = 32;
const ACCESS_GRANT_ROLES = 1;
/** Existing native resolveSubject ceiling; add pays it once, move does not. */
function subjectDisclosure() {
  return memoizedValue(subjectDisclosure, () =>
    dimensions({
      candidateKeys: 1,
      nativeRows: 8_192,
      nativePoints: 128,
      statements: 128,
      bytes: 1024 * 1024,
    }),
  );
}

function commandHistoryAbsence(kind: string): Bound {
  if (Object.hasOwn(COMMAND_HISTORY_KINDS, kind))
    throw new TypeError(`${kind} is registered for History and cannot use an absent write`);
  return zero();
}

const sql = (query: string) => Buffer.byteLength(query, 'utf8');
const query = (text: string, inputBytes: number, projectedBytes: number, counts: Partial<Bound>): Bound =>
  sumBounds(dimensions({ statements: 1, ...counts }), bytes(sql(text) + inputBytes + projectedBytes));

const parentProjectionBytes = uuidBytes + 7 + 7 + integerBytes + integerBytes + bigintBytes + integerBytes;
function repairProjectionBytes() {
  return memoizedValue(
    repairProjectionBytes,
    () =>
      uuidBytes +
      integerBytes +
      3 * ordinalBytes() +
      integerBytes +
      bigintBytes +
      integerBytes +
      integerBytes +
      integerBytes +
      ordinalBytes() +
      uuidBytes +
      9,
  );
}
function rawProjectionBytes() {
  return memoizedValue(rawProjectionBytes, () => uuidBytes + ordinalBytes() + 5);
}
const bindParent = routeBytes + uuidBytes;
function parentLock() {
  return memoizedValue(parentLock, () =>
    query(COLLECTION_ORDER_SQL.parent, bindParent, parentProjectionBytes, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function beginRepairRead() {
  return memoizedValue(beginRepairRead, () =>
    query(COLLECTION_ORDER_SQL.beginRepair, bindParent, uuidBytes + integerBytes + 9, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function terminalRepairDelete() {
  return memoizedValue(terminalRepairDelete, () =>
    query(COLLECTION_ORDER_SQL.removeTerminalRepair, bindParent + uuidBytes, 0, {
      nativeRows: 1,
      nativePoints: 1,
    }),
  );
}
function originalMinimum() {
  return memoizedValue(originalMinimum, () =>
    query(COLLECTION_ORDER_SQL.originalMinimum, bindParent, ordinalBytes(), {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function repairInsert() {
  return memoizedValue(repairInsert, () =>
    query(
      COLLECTION_ORDER_SQL.insertRepair,
      routeBytes + 2 * uuidBytes + integerBytes + 3 * ordinalBytes() + integerBytes + bigintBytes + integerBytes,
      0,
      { nativeRows: 1, nativePoints: 1 },
    ),
  );
}
function activeBarrier() {
  return memoizedValue(activeBarrier, () =>
    query(COLLECTION_ORDER_SQL.barrier, bindParent, 1, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}

const triggerParent = `SELECT curator_account_id,state FROM library.collection
    WHERE route=owner_route AND collection_id=owner_id FOR UPDATE`;
const triggerRepair = `SELECT * FROM library.collection_order_repair
    WHERE route=owner_route AND collection_id=owner_id AND state='active'`;
const triggerAccount = `SELECT state <> 'active' OR authn_fenced INTO terminal FROM access.account
      WHERE route=get_byte(uuid_send(curator),10)*256+get_byte(uuid_send(curator),11) AND account_id=curator`;
function triggerParentGuard() {
  return memoizedValue(triggerParentGuard, () =>
    query(triggerParent, 0, uuidBytes + 7, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
    }),
  );
}
// SELECT * is intentional in both migration triggers; derive the maximum row
// projection from the repair table's fixed integer/UUID/text/xid8 columns.
function repairTriggerProjectionBytes() {
  return memoizedValue(
    repairTriggerProjectionBytes,
    () =>
      routeBytes +
      2 * uuidBytes +
      integerBytes +
      3 * ordinalBytes() +
      4 * integerBytes +
      2 * bigintBytes +
      2 * integerBytes +
      ordinalBytes() +
      uuidBytes +
      9 +
      20,
  );
}
function triggerRepairGuard() {
  return memoizedValue(triggerRepairGuard, () =>
    query(triggerRepair, 0, repairTriggerProjectionBytes(), {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
    }),
  );
}
function triggerRepairMissing() {
  return memoizedValue(triggerRepairMissing, () =>
    query(triggerRepair, 0, 0, {
      candidateKeys: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function triggerAccountGuard() {
  return memoizedValue(triggerAccountGuard, () =>
    query(triggerAccount, 0, 5, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
    }),
  );
}
function memberGuardTriggers() {
  return memoizedValue(memberGuardTriggers, () =>
    sumBounds(triggerParentGuard(), triggerRepairGuard(), triggerAccountGuard()),
  );
}
function memberUpdate() {
  return memoizedValue(memberUpdate, () =>
    query(
      COLLECTION_ORDER_SQL.rewriteOriginal,
      routeBytes + 3 * uuidBytes + ordinalBytes() + GENERATED_ORDINAL_KEY_LENGTH,
      0,
      { nativeRows: 1, nativePoints: 1, witnessKeys: 1 },
    ),
  );
}
function progressUpdate() {
  return memoizedValue(progressUpdate, () =>
    query(
      COLLECTION_ORDER_SQL.advanceRepair,
      routeBytes +
        2 * uuidBytes +
        integerBytes +
        integerBytes +
        ordinalBytes() +
        uuidBytes +
        9 +
        integerBytes +
        integerBytes +
        bigintBytes +
        integerBytes,
      uuidBytes,
      { nativeRows: 1, nativePoints: 1 },
    ),
  );
}
function parentUpdate() {
  return memoizedValue(parentUpdate, () =>
    query(
      COLLECTION_ORDER_SQL.advanceParent,
      routeBytes + uuidBytes + integerBytes + integerBytes + bigintBytes + integerBytes + 29 + uuidBytes,
      uuidBytes,
      { nativeRows: 1, nativePoints: 1 },
    ),
  );
}
function removeRepair() {
  return memoizedValue(removeRepair, () =>
    query(COLLECTION_ORDER_SQL.removeExactRepair, bindParent + uuidBytes, 0, {
      nativeRows: 1,
      nativePoints: 1,
    }),
  );
}
function repairLock() {
  return memoizedValue(repairLock, () =>
    query(COLLECTION_ORDER_SQL.lockRepair, bindParent + uuidBytes, repairProjectionBytes(), {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function accountShareCost() {
  return memoizedValue(accountShareCost, () =>
    query(accountShare.sql, bindParent, 13, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}

const rawPage = (size: number): Bound => {
  const limitBytes = String(size).length;
  return query(
    COLLECTION_ORDER_SQL.originals,
    routeBytes + uuidBytes + ordinalBytes() + ordinalBytes() + uuidBytes + limitBytes,
    size * rawProjectionBytes(),
    { candidateKeys: size, nativeRows: size, emptySeeks: size === 0 ? 1 : 0 },
  );
};
const rewriteRows = (active: number, completes: boolean): Bound =>
  sumBounds(
    repeatBound(memberUpdate(), active),
    repeatBound(completes ? sumBounds(triggerParentGuard(), triggerRepairMissing()) : memberGuardTriggers(), active),
  );

function accountLifecycleShare() {
  return memoizedValue(accountLifecycleShare, () => accountShareCost());
}
function pageCurrentness() {
  return memoizedValue(pageCurrentness, () => sumBounds(parentLock(), repairLock(), accountLifecycleShare()));
}

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
function retryLimit() {
  return memoizedValue(retryLimit, () => COMMAND_STEP_RETRIES.maxAttempts);
}

function timeoutSql() {
  return memoizedValue(timeoutSql, () => `SET LOCAL statement_timeout = '${WORK_STEP_DEADLINE_MS}ms'`);
}
const lockTimeoutSql = "SET LOCAL lock_timeout = '200ms'";
const beginSql = 'BEGIN ISOLATION LEVEL SERIALIZABLE';
function beginControl() {
  return memoizedValue(beginControl, () =>
    dimensions({
      statements: 3,
      bytes: sql(beginSql) + sql(lockTimeoutSql) + sql(timeoutSql()),
    }),
  );
}
function pageControls() {
  return memoizedValue(pageControls, () =>
    sumBounds(
      beginControl(),
      query(readTime.sql, 24, 29, { nativeRows: 1, nativePoints: 1 }),
      dimensions({ statements: 1, bytes: sql(timeoutSql()) }),
    ),
  );
}
function commitControl() {
  return memoizedValue(commitControl, () => dimensions({ statements: 1, bytes: sql('COMMIT') }));
}
function rollbackControl() {
  return memoizedValue(rollbackControl, () => dimensions({ statements: 1, bytes: sql('ROLLBACK') }));
}
const eventFenceCost = (eventCount: number, eventBytes: number): Bound =>
  query(eventFence.sql, eventBytes + eventCount + 1 + uuidBytes + partitionBytes + 8, integerBytes + bigintBytes, {
    candidateKeys: 1,
    emptySeeks: 1,
    nativeRows: eventCount + 1,
    nativePoints: eventCount + 1,
  });
function noEffectCost() {
  return memoizedValue(noEffectCost, () =>
    query(noEffectFence.sql, partitionBytes + uuidBytes + 4, integerBytes + bigintBytes, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}

const pageData = (size: number, active: number, completes: boolean): Bound =>
  sumBounds(
    pageCurrentness(),
    rawPage(size),
    rewriteRows(active, completes),
    progressUpdate(),
    parentUpdate(),
    // Active pages hit the lifecycle guard per rewritten occurrence and on the
    // parent CAS. A terminal page has already marked the capture complete, so its
    // triggers perform the bounded empty active-repair seek without account reads.
    repeatBound(completes ? triggerRepairMissing() : sumBounds(triggerRepairGuard(), triggerAccountGuard()), 1),
    dimensions({
      nativeRows: 1,
      nativePoints: 1,
      bytes: GENERATED_ORDINAL_KEY_LENGTH * active,
    }), // Generated keys are 32 bytes; original stored keys remain capped at 48.
    dimensions({ bytes: Buffer.byteLength(JSON.stringify({ state: completes ? 'complete' : 'more' })) }),
  );

function stalePage() {
  return memoizedValue(stalePage, () => sumBounds(pageControls(), pageCurrentness(), noEffectCost(), commitControl()));
}
function terminalPage() {
  return memoizedValue(terminalPage, () =>
    sumBounds(
      pageControls(),
      pageCurrentness(),
      removeRepair(),
      dimensions({ bytes: eventUpdatedBytes }),
      eventFenceCost(1, eventUpdatedBytes),
      commitControl(),
    ),
  );
}
function fullPageData() {
  return memoizedValue(fullPageData, () => pageData(ORDER_WINDOW_SIZE, ORDER_WINDOW_SIZE, false));
}
function fullPageSuccess() {
  return memoizedValue(fullPageSuccess, () =>
    sumBounds(pageControls(), fullPageData(), eventFenceCost(2, eventUpdatedBytes + eventRepairBytes), commitControl()),
  );
}
function shortPageSuccess() {
  return memoizedValue(shortPageSuccess, () =>
    sumBounds(
      pageControls(),
      pageData(ORDER_WINDOW_SIZE - 1, ORDER_WINDOW_SIZE - 1, true),
      eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
      commitControl(),
    ),
  );
}
function exhaustionSuccess() {
  return memoizedValue(exhaustionSuccess, () =>
    sumBounds(
      pageControls(),
      pageData(0, 0, true),
      eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
      commitControl(),
    ),
  );
}
function changedFenceRollback() {
  return memoizedValue(changedFenceRollback, () => sumBounds(pageControls(), pageCurrentness(), rollbackControl()));
}
function failedFullPage() {
  return memoizedValue(failedFullPage, () =>
    sumBounds(
      pageControls(),
      fullPageData(),
      eventFenceCost(2, eventUpdatedBytes + eventRepairBytes),
      commitControl(),
      rollbackControl(),
    ),
  );
}
function failedFullThenSuccess() {
  return memoizedValue(failedFullThenSuccess, () =>
    sumBounds(repeatBound(failedFullPage(), retryLimit() - 1), fullPageSuccess()),
  );
}
function allFullAttemptsFail() {
  return memoizedValue(allFullAttemptsFail, () => repeatBound(failedFullPage(), retryLimit()));
}
function committedReplay() {
  return memoizedValue(committedReplay, () => sumBounds(fullPageSuccess(), repeatBound(stalePage(), retryLimit() - 1)));
}

function maxBound(...values: readonly Bound[]): Bound {
  return declareBound(
    Object.fromEntries(BOUND_AXES.map((axis) => [axis, Math.max(...values.map((value) => value[axis]))])),
  );
}

function pageCeiling() {
  return memoizedValue(pageCeiling, () =>
    maxBound(
      stalePage(),
      terminalPage(),
      changedFenceRollback(),
      fullPageSuccess(),
      shortPageSuccess(),
      exhaustionSuccess(),
      failedFullThenSuccess(),
      allFullAttemptsFail(),
      committedReplay(),
    ),
  );
}

function beginReuse() {
  return memoizedValue(beginReuse, () => sumBounds(parentLock(), beginRepairRead()));
}
function beginEmpty() {
  return memoizedValue(beginEmpty, () => sumBounds(parentLock(), beginRepairRead(), terminalRepairDelete()));
}
function beginFresh() {
  return memoizedValue(beginFresh, () => sumBounds(parentLock(), beginRepairRead(), originalMinimum(), repairInsert()));
}
function beginReplaceTerminal() {
  return memoizedValue(beginReplaceTerminal, () =>
    sumBounds(parentLock(), beginRepairRead(), terminalRepairDelete(), originalMinimum(), repairInsert()),
  );
}
function beginSqlCeiling() {
  return memoizedValue(beginSqlCeiling, () =>
    maxBound(beginReuse(), beginEmpty(), beginFresh(), beginReplaceTerminal()),
  );
}
function barrierCeiling() {
  return memoizedValue(barrierCeiling, () => sumBounds(parentLock(), activeBarrier()));
}
function continuationRequest() {
  return memoizedValue(continuationRequest, () =>
    dimensions({
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
    }),
  );
}

const jsonSize = (value: unknown) => Buffer.byteLength(JSON.stringify(value));
const uuid = '0'.repeat(uuidBytes);
const timestamp = '\0'.repeat(64);
const actorAccount = { route: 65535, account_id: uuid };
const collectionPoint = { route: 65535, collection_id: uuid };
const memberPoint = { ...collectionPoint, member_id: uuid };
function memberResult() {
  return memoizedValue(memberResult, () => ({
    collectionId: uuid,
    id: uuid,
    subjectId: uuid,
    note: '\0'.repeat(NOTE_LIMIT),
    ordinalKey: '\0'.repeat(ordinalBytes()),
    addedAt: timestamp,
  }));
}
function memberResultBytes() {
  return memoizedValue(memberResultBytes, () => jsonSize(memberResult()));
}
const memberEventBytes = jsonSize({
  type: 'com.rezics.library.collection.member.changed.v1',
  subject: uuid,
  data: { collectionId: uuid, memberId: uuid, subjectId: uuid },
  id: uuid,
});
const httpAddBytes = jsonSize({
  collectionId: uuid,
  subjectId: uuid,
  note: '\0'.repeat(NOTE_LIMIT),
  after: uuid,
  position: 'after',
});
const httpMoveBytes = jsonSize({ collectionId: uuid, memberId: uuid, after: uuid });
const httpBeginBytes = jsonSize({
  collectionId: uuid,
  originalKind: COLLECTION_ORDER_COMMAND_KINDS.add,
  originalKey: '\0'.repeat(64),
  fence: `${'9'.repeat(integerBytes)}:${'9'.repeat(bigintBytes)}:${'9'.repeat(integerBytes)}:${'9'.repeat(bigintBytes)}`,
});

function fromAccess(work: AccessWork, statements: number, sqlText = ''): Bound {
  return declareBound({
    candidateKeys: work.keys,
    nativeRows: work.rows,
    identityMetadataRows: 0,
    emptySeeks: work.emptySeeks,
    nativePoints: work.points,
    witnessKeys: work.witnesses,
    statements,
    bytes: work.bytes + sql(sqlText),
    engineRequests: 0,
  });
}

function accessLeaf(
  operation: Parameters<typeof accessNativeDeclaration>[0],
  sqlText: string,
  input: unknown,
  shape: Parameters<typeof accessNativeDeclaration>[2],
  statements = 1,
): Bound {
  return fromAccess(accessNativeDeclaration(operation, input, shape).bound, statements, sqlText);
}

const accessMembers = ACTOR_MEMBERS;
function accessGroups() {
  return memoizedValue(accessGroups, () => accessMembers * MEMBERSHIP_LIMIT);
}
function accessRoles() {
  return memoizedValue(accessRoles, () => accessGroups() * 2);
}
const accessFormulaInput = {
  route: 65535,
  action: 'collection:update',
  resource_ids: [uuid],
  actor_id: uuid,
  principal_id: uuid,
  deadline: timestamp,
};
function accessPreparation() {
  return memoizedValue(accessPreparation, () =>
    sumBounds(
      accessLeaf('time', permissionTime.sql, { at: timestamp }, {}, 1),
      accessLeaf('account-state', accountRead.sql, actorAccount, { targets: 1 }, 1),
      accessLeaf(
        'inverse',
        permissionInverse.sql,
        { ...actorAccount, members: Array.from({ length: accessMembers }, () => actorAccount) },
        { members: accessMembers, groups: MEMBERSHIP_LIMIT },
        accessMembers,
      ),
      accessLeaf(
        'assignment',
        permissionAssignment.sql,
        { route: 65535, principal_id: uuid, request_id: uuid, actor_id: uuid, at: timestamp },
        {},
        1,
      ),
      accessLeaf(
        'membership',
        permissionMembership.sql,
        {
          route: 65535,
          organization_id: uuid,
          member_id: uuid,
          at: timestamp,
          pairs: Array.from({ length: MEMBERSHIP_LIMIT }, () => ({
            route: 65535,
            organization_id: uuid,
            member_id: uuid,
          })),
        },
        { groups: MEMBERSHIP_LIMIT },
        1,
      ),
      accessLeaf(
        'membership',
        permissionMembership.sql,
        {
          pairs: Array.from({ length: MEMBERSHIP_LIMIT }, () => ({ realmId: uuid, accountId: uuid })),
          at: timestamp,
        },
        { groups: MEMBERSHIP_LIMIT },
        1,
      ),
      accessLeaf(
        'candidates',
        permissionCandidates.sql,
        accessFormulaInput,
        {
          targets: 1,
          members: accessMembers,
          roles: accessRoles(),
          grantRoles: ACCESS_GRANT_ROLES,
          explicit: true,
          global: true,
          assignment: true,
        },
        1,
      ),
      accessLeaf(
        'formula',
        permissionCheck.sql,
        accessFormulaInput,
        {
          targets: 1,
          members: accessMembers,
          roles: accessRoles(),
          grantRoles: ACCESS_GRANT_ROLES,
          explicit: true,
          global: true,
          assignment: true,
        },
        1,
      ),
      query(collectionAuthorization.sql, bindParent, uuidBytes + 7 + 7 + 7 + 16 + 5, {
        candidateKeys: 1,
        nativeRows: 1,
        nativePoints: 1,
        emptySeeks: 1,
      }),
      sumBounds(
        ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map((text) =>
          dimensions({ statements: 1, bytes: sql(text) }),
        ),
        dimensions({ nativePoints: 2, emptySeeks: 2 }),
      ),
    ),
  );
}

function authorizationCollection() {
  return memoizedValue(authorizationCollection, () =>
    query(collectionAuthorization.sql, bindParent, uuidBytes + 7 + 7 + 7 + 16 + 5, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function collectionRow() {
  return memoizedValue(collectionRow, () =>
    query(
      collectionRead.sql,
      bindParent,
      jsonSize({
        id: uuid,
        curatorAccountId: uuid,
        title: '\0'.repeat(200),
        description: '\0'.repeat(2000),
        visibility: 'unlisted',
        presentationKind: '\0'.repeat(64),
        coverMediaId: uuid,
        state: 'deleted',
        revision: 2_147_483_647,
        memberCount: 2_147_483_647,
        orderEpoch: 2_147_483_647,
        membershipKind: 'dynamic',
        builtinKind: '\0'.repeat(64),
        hasSavedRule: true,
        createdAt: timestamp,
        updatedAt: timestamp,
      }),
      { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    ),
  );
}
function shelfCurator() {
  return memoizedValue(shelfCurator, () =>
    query(shelfAuthorizedCollection.sql, bindParent + uuidBytes, uuidBytes, {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function neighborSeek() {
  return memoizedValue(neighborSeek, () =>
    query(memberNeighbors.sql, routeBytes + uuidBytes + 5 + uuidBytes + uuidBytes, ordinalBytes() * 2 + 5, {
      candidateKeys: 3,
      nativeRows: 3,
      nativePoints: 3,
      emptySeeks: 3,
    }),
  );
}
function windowSide() {
  return memoizedValue(windowSide, () => ORDER_WINDOW_SIZE / 2);
}
const windowSeek = (text: string): Bound =>
  query(
    text,
    routeBytes + uuidBytes + ordinalBytes() + uuidBytes + String(windowSide()).length,
    windowSide() * (uuidBytes + ordinalBytes()),
    { candidateKeys: windowSide(), nativeRows: windowSide(), emptySeeks: windowSide() === 0 ? 1 : 0 },
  );
function placementFence() {
  return memoizedValue(placementFence, () =>
    query(COLLECTION_ORDER_SQL.editFence, bindParent, 4 * bigintBytes + 3, {
      candidateKeys: 2,
      nativeRows: 2,
      nativePoints: 2,
      emptySeeks: 2,
    }),
  );
}
function memberReadCost() {
  return memoizedValue(memberReadCost, () =>
    query(memberRead.sql, routeBytes + 2 * uuidBytes, memberResultBytes(), {
      candidateKeys: 1,
      nativeRows: 1,
      nativePoints: 1,
      emptySeeks: 1,
    }),
  );
}
function deferredConstraint() {
  return memoizedValue(deferredConstraint, () => query(collectionDefer.sql, 0, 0, {}));
}
function generatedWindowKeys() {
  return memoizedValue(generatedWindowKeys, () =>
    dimensions({ bytes: GENERATED_ORDINAL_KEY_LENGTH * (ORDER_WINDOW_SIZE + 1) }),
  );
}
function structurePosition() {
  return memoizedValue(structurePosition, () =>
    sumBounds(
      query(
        'SELECT member_id FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND member_id <> $3 AND ordinal_key < $4 ORDER BY ordinal_key DESC, member_id DESC LIMIT 1',
        bindParent + uuidBytes + ordinalBytes(),
        uuidBytes,
        { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
      ),
      query(
        'SELECT member_id FROM library.collection_member WHERE route=$1 AND collection_id=$2 AND deletion_id IS NULL AND member_id <> $3 AND ordinal_key > $4 ORDER BY ordinal_key, member_id LIMIT 1',
        bindParent + uuidBytes + ordinalBytes(),
        uuidBytes,
        { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
      ),
    ),
  );
}
function structureAppend() {
  return memoizedValue(structureAppend, () =>
    sumBounds(
      query(COLLECTION_ORDER_SQL.parent, bindParent, parentProjectionBytes, {
        candidateKeys: 1,
        nativeRows: 1,
        nativePoints: 1,
      }),
      structurePosition(),
      query(
        'INSERT INTO library.collection_structure_history_head (route, collection_id, next_change_no, unknown_before_tracking) VALUES ($1,$2,1,true) ON CONFLICT (route, collection_id) DO UPDATE SET next_change_no = library.collection_structure_history_head.next_change_no + 1 RETURNING next_change_no',
        bindParent,
        bigintBytes,
        { nativeRows: 2, nativePoints: 1 },
      ),
      query(
        'INSERT INTO library.collection_structure_history (route, collection_id, change_no, transaction_id, change_kind, member_id, subject_id, member_revision, before_state, after_state) VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10)',
        bindParent + uuidBytes + bigintBytes + uuidBytes + 16 + 2 * uuidBytes + bigintBytes + 2 * 32_768,
        0,
        { nativeRows: 1, nativePoints: 1 },
      ),
      query(
        'DELETE FROM library.collection_structure_history WHERE route=$1 AND collection_id=$2 AND change_no <= $3',
        bindParent + bigintBytes,
        0,
        { nativeRows: 1, nativePoints: 1 },
      ),
      query(
        'SELECT transaction_id FROM library.collection_structure_history WHERE route=$1 AND member_id=$2 GROUP BY transaction_id ORDER BY max(recorded_at) DESC, transaction_id DESC LIMIT 16',
        routeBytes + uuidBytes,
        STRUCTURE_HISTORY_OPERATIONS * uuidBytes,
        { candidateKeys: STRUCTURE_HISTORY_OPERATIONS, nativeRows: STRUCTURE_HISTORY_OPERATIONS },
      ),
      dimensions({ nativeRows: 1, nativePoints: 1, bytes: STRUCTURE_HISTORY_RETAINED }),
    ),
  );
}
function structurePending() {
  return memoizedValue(structurePending, () =>
    query(
      'INSERT INTO library.collection_structure_pending_change (transaction_id, route, collection_id, member_id, before_state) VALUES ($1,$2,$3,$4,$5) ON CONFLICT (transaction_id, route, collection_id, member_id) DO UPDATE SET before_state = EXCLUDED.before_state',
      uuidBytes + bindParent + uuidBytes + 32_768,
      0,
      { nativeRows: 1, nativePoints: 1 },
    ),
  );
}
function insertMemberCost() {
  return memoizedValue(insertMemberCost, () =>
    query(
      memberInsert.sql,
      routeBytes + 3 * uuidBytes + NOTE_LIMIT * 6 + ordinalBytes() + 29 + uuidBytes,
      memberResultBytes(),
      { nativeRows: 3, nativePoints: 2, witnessKeys: 1 },
    ),
  );
}
function moveMemberCost() {
  return memoizedValue(moveMemberCost, () =>
    query(memberMove.sql, routeBytes + 2 * uuidBytes + ordinalBytes() + uuidBytes, memberResultBytes(), {
      nativeRows: 1,
      nativePoints: 1,
      witnessKeys: 1,
    }),
  );
}
function moveSetting() {
  return memoizedValue(moveSetting, () =>
    query(COLLECTION_ORDER_SQL.moveMemberSetting, uuidBytes, uuidBytes, { nativeRows: 0 }),
  );
}
function touchStructural() {
  return memoizedValue(touchStructural, () =>
    query(COLLECTION_ORDER_SQL.touchCollection, 29 + uuidBytes + bindParent + 1, integerBytes, {
      nativeRows: 1,
      nativePoints: 1,
    }),
  );
}
const respaceBody = (count: number): Bound =>
  query(
    membersRespace.sql,
    routeBytes + uuidBytes + count * (uuidBytes + ordinalBytes() + 40) + 29 + uuidBytes,
    integerBytes * 2,
    { candidateKeys: count, nativeRows: 1 + count * 2, nativePoints: 1 + count, witnessKeys: count },
  );
const respaceRewrites = (count: number): Bound =>
  sumBounds(
    respaceBody(count),
    repeatBound(memberGuardTriggers(), count),
    repeatBound(
      query(COLLECTION_ORDER_SQL.parent, bindParent, parentProjectionBytes, {
        candidateKeys: 1,
        nativeRows: 1,
        nativePoints: 1,
      }),
      count,
    ),
  );

const receiptLookup = (responseBytes: number): Bound =>
  query(
    receiptRead.sql,
    partitionBytes + 7 + uuidBytes + 40 + RECEIPT_KEY_CANDIDATES * (4 + 64),
    64 + integerBytes + bigintBytes + uuidBytes + responseBytes + 9,
    {
      candidateKeys: RECEIPT_KEY_CANDIDATES,
      nativeRows: RECEIPT_KEY_CANDIDATES,
      nativePoints: RECEIPT_KEY_CANDIDATES,
      emptySeeks: RECEIPT_KEY_CANDIDATES,
    },
  );
const actorReceiptFence = (eventCount: number, eventBytes: number, responseBytes: number): Bound =>
  query(
    eventFence.sql,
    eventBytes +
      eventCount +
      1 +
      uuidBytes +
      partitionBytes +
      jsonSize({
        principal: { kind: 'account', id: uuid },
        kind: COLLECTION_ORDER_COMMAND_KINDS.add,
        key: `rk1.255.${'f'.repeat(64)}`,
        digest: 'f'.repeat(44),
        response: null,
      }) +
      responseBytes +
      jsonSize({ principal: { kind: 'account', id: uuid }, clientId: uuid, requestedBy: uuid }),
    integerBytes + bigintBytes,
    {
      candidateKeys: 1,
      emptySeeks: 3,
      nativeRows: 4 + 6 + 4 + 4,
      nativePoints: 1 + 5 + 3 + 3,
    },
  );
function actorNoEffectFence() {
  return memoizedValue(actorNoEffectFence, () =>
    query(
      noEffectFence.sql,
      partitionBytes +
        uuidBytes +
        jsonSize({
          principal: { kind: 'account', id: uuid },
          kind: COLLECTION_ORDER_COMMAND_KINDS.begin,
          key: `rk1.255.${'f'.repeat(64)}`,
          digest: 'f'.repeat(44),
          response: { collectionId: uuid, repairId: uuid, step: 0 },
        }),
      integerBytes + bigintBytes,
      { candidateKeys: 1, nativeRows: 1 + 4, nativePoints: 1 + 3, emptySeeks: 1 },
    ),
  );
}
function actorTimeMint() {
  return memoizedValue(actorTimeMint, () =>
    sumBounds(
      ...[
        'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
        "SET LOCAL statement_timeout = '200ms'",
        'COMMIT',
        'ROLLBACK',
      ].map((text) => dimensions({ statements: 1, bytes: sql(text) })),
      query(readTime.sql, 24, 29, { nativeRows: 1, nativePoints: 1 }),
    ),
  );
}
function actorControls() {
  return memoizedValue(actorControls, () =>
    sumBounds(
      beginControl(),
      query(readTime.sql, 24, 29, { nativeRows: 1, nativePoints: 1 }),
      dimensions({ statements: 1, bytes: sql(timeoutSql()) }),
    ),
  );
}
function partitionProbe() {
  return memoizedValue(partitionProbe, () =>
    query(
      partitionRead.sql,
      partitionBytes,
      jsonSize({
        partitionNo: 4095,
        node: uuid,
        writeState: 'fenced',
        movedTo: '9'.repeat(integerBytes),
        epoch: 2_147_483_647,
        position: '-9223372036854775808',
      }),
      { candidateKeys: 1, nativeRows: 1, nativePoints: 1, emptySeeks: 1 },
    ),
  );
}
function actorRecovery() {
  return memoizedValue(actorRecovery, () =>
    repeatBound(sumBounds(actorTimeMint(), partitionProbe()), 1 + Math.ceil(WORK_STEP_DEADLINE_MS / 25)),
  );
}
function shelfWrite() {
  return memoizedValue(shelfWrite, () =>
    sumBounds(sessionShelfWork(65535, uuid, true), shelfCurator(), accountShareCost()),
  );
}
const currentAuthorization = (includeBarrier: boolean): Bound =>
  sumBounds(
    authorizationCollection(),
    accountShareCost(),
    collectionRow(),
    shelfWrite(),
    ...(includeBarrier ? [barrierCeiling()] : []),
  );
const actorEnvelope = (
  kind: string,
  requestBytes: number,
  responseBytes: number,
  eventBytes: number,
  includeBarrier: boolean,
): Bound =>
  sumBounds(
    commandHistoryAbsence(kind),
    actorTimeMint(),
    accessPreparation(),
    actorControls(),
    currentAuthorization(includeBarrier),
    receiptLookup(responseBytes),
    actorReceiptFence(1, eventBytes, responseBytes),
    commitControl(),
    rollbackControl(),
    actorRecovery(),
    dimensions({ bytes: requestBytes + 3 * responseBytes + eventBytes }),
  );

function addPlacementDirect() {
  return memoizedValue(addPlacementDirect, () => neighborSeek());
}
function addPlacementWindow() {
  return memoizedValue(addPlacementWindow, () =>
    sumBounds(neighborSeek(), windowSeek(COLLECTION_ORDER_SQL.editLeft), windowSeek(COLLECTION_ORDER_SQL.editRight)),
  );
}
function addPlacementFailed() {
  return memoizedValue(addPlacementFailed, () => sumBounds(addPlacementWindow(), placementFence()));
}
function addInsert() {
  return memoizedValue(addInsert, () => sumBounds(insertMemberCost(), memberGuardTriggers(), structureAppend()));
}
const addRespace = (count: number) => sumBounds(deferredConstraint(), respaceRewrites(count), generatedWindowKeys());
function addSuccessDirect() {
  return memoizedValue(addSuccessDirect, () =>
    sumBounds(
      actorEnvelope(COLLECTION_ORDER_COMMAND_KINDS.add, httpAddBytes, memberResultBytes(), memberEventBytes, true),
      subjectDisclosure(),
      addPlacementDirect(),
      addInsert(),
    ),
  );
}
function addSuccessRespace() {
  return memoizedValue(addSuccessRespace, () =>
    sumBounds(
      actorEnvelope(COLLECTION_ORDER_COMMAND_KINDS.add, httpAddBytes, memberResultBytes(), memberEventBytes, true),
      subjectDisclosure(),
      addPlacementWindow(),
      addRespace(ORDER_WINDOW_SIZE - 2),
      addInsert(),
    ),
  );
}
function addFailed() {
  return memoizedValue(addFailed, () =>
    sumBounds(
      actorTimeMint(),
      accessPreparation(),
      actorControls(),
      currentAuthorization(true),
      receiptLookup(memberResultBytes()),
      subjectDisclosure(),
      addPlacementFailed(),
      rollbackControl(),
      commandHistoryAbsence(COLLECTION_ORDER_COMMAND_KINDS.add),
      dimensions({ bytes: httpAddBytes }),
    ),
  );
}
function addReplay() {
  return memoizedValue(addReplay, () =>
    sumBounds(
      actorTimeMint(),
      accessPreparation(),
      actorControls(),
      currentAuthorization(true),
      receiptLookup(memberResultBytes()),
      commitControl(),
      commandHistoryAbsence(COLLECTION_ORDER_COMMAND_KINDS.add),
      dimensions({ bytes: httpAddBytes + memberResultBytes() }),
    ),
  );
}
function movePlacementDirect() {
  return memoizedValue(movePlacementDirect, () => sumBounds(memberReadCost(), neighborSeek()));
}
function movePlacementWindow() {
  return memoizedValue(movePlacementWindow, () => sumBounds(memberReadCost(), addPlacementWindow()));
}
function movePlacementFailed() {
  return memoizedValue(movePlacementFailed, () => sumBounds(memberReadCost(), addPlacementFailed()));
}
function moveWrite() {
  return memoizedValue(moveWrite, () =>
    sumBounds(
      moveSetting(),
      moveMemberCost(),
      moveSetting(),
      memberGuardTriggers(),
      structurePending(),
      structureAppend(),
      touchStructural(),
    ),
  );
}
function moveSuccessDirect() {
  return memoizedValue(moveSuccessDirect, () =>
    sumBounds(
      actorEnvelope(COLLECTION_ORDER_COMMAND_KINDS.move, httpMoveBytes, memberResultBytes(), memberEventBytes, true),
      movePlacementDirect(),
      moveWrite(),
    ),
  );
}
function moveSuccessRespace() {
  return memoizedValue(moveSuccessRespace, () =>
    sumBounds(
      actorEnvelope(COLLECTION_ORDER_COMMAND_KINDS.move, httpMoveBytes, memberResultBytes(), memberEventBytes, true),
      movePlacementWindow(),
      addRespace(ORDER_WINDOW_SIZE - 2),
      moveWrite(),
    ),
  );
}
function moveFailed() {
  return memoizedValue(moveFailed, () =>
    sumBounds(
      actorTimeMint(),
      accessPreparation(),
      actorControls(),
      currentAuthorization(true),
      receiptLookup(memberResultBytes()),
      movePlacementFailed(),
      rollbackControl(),
      commandHistoryAbsence(COLLECTION_ORDER_COMMAND_KINDS.move),
      dimensions({ bytes: httpMoveBytes }),
    ),
  );
}
function moveReplay() {
  return memoizedValue(moveReplay, () =>
    sumBounds(
      actorTimeMint(),
      accessPreparation(),
      actorControls(),
      currentAuthorization(true),
      receiptLookup(memberResultBytes()),
      commitControl(),
      commandHistoryAbsence(COLLECTION_ORDER_COMMAND_KINDS.move),
      dimensions({ bytes: httpMoveBytes + memberResultBytes() }),
    ),
  );
}
function editCeiling() {
  return memoizedValue(editCeiling, () =>
    maxBound(
      addSuccessDirect(),
      addSuccessRespace(),
      addFailed(),
      addReplay(),
      moveSuccessDirect(),
      moveSuccessRespace(),
      moveFailed(),
      moveReplay(),
    ),
  );
}

const beginEventBytes = eventRepairBytes;
function beginEnvelope() {
  return memoizedValue(beginEnvelope, () =>
    actorEnvelope(COLLECTION_ORDER_COMMAND_KINDS.begin, httpBeginBytes, beginResultBytes, beginEventBytes, false),
  );
}
function beginSuccess() {
  return memoizedValue(beginSuccess, () => sumBounds(beginEnvelope(), beginFresh()));
}
function beginReuseCommand() {
  return memoizedValue(beginReuseCommand, () =>
    sumBounds(
      actorTimeMint(),
      accessPreparation(),
      actorControls(),
      currentAuthorization(false),
      receiptLookup(beginResultBytes),
      beginReuse(),
      actorNoEffectFence(),
      commitControl(),
      commandHistoryAbsence(COLLECTION_ORDER_COMMAND_KINDS.begin),
      dimensions({ bytes: httpBeginBytes + beginResultBytes }),
    ),
  );
}
function beginEmptyCommand() {
  return memoizedValue(beginEmptyCommand, () =>
    sumBounds(
      actorTimeMint(),
      accessPreparation(),
      actorControls(),
      currentAuthorization(false),
      receiptLookup(beginResultBytes),
      beginEmpty(),
      rollbackControl(),
      commandHistoryAbsence(COLLECTION_ORDER_COMMAND_KINDS.begin),
      dimensions({ bytes: httpBeginBytes }),
    ),
  );
}
function beginReplaceCommand() {
  return memoizedValue(beginReplaceCommand, () => sumBounds(beginEnvelope(), beginReplaceTerminal()));
}
function beginActorCeiling() {
  return memoizedValue(beginActorCeiling, () =>
    maxBound(beginSuccess(), beginReuseCommand(), beginEmptyCommand(), beginReplaceCommand()),
  );
}
function failedAddAndBegin() {
  return memoizedValue(failedAddAndBegin, () => sumBounds(addFailed(), beginActorCeiling()));
}
function failedMoveAndBegin() {
  return memoizedValue(failedMoveAndBegin, () => sumBounds(moveFailed(), beginActorCeiling()));
}

export function COLLECTION_ORDER_DECLARATION() {
  return memoizedValue(COLLECTION_ORDER_DECLARATION, () =>
    Object.freeze({
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
        retries: retryLimit(),
        pageCommandReceipts: 0,
        deferredUniqueConstraintStatements: 0,
        occurrenceHistoryEventsPerRewrite: 0,
        commandHistoryWrites: 0,
        receiptKeyCandidates: RECEIPT_KEY_CANDIDATES,
        accessMemberships: MEMBERSHIP_LIMIT,
      }),
      terms: Object.freeze({
        barrier: barrierCeiling(),
        beginSql: beginSqlCeiling(),
        beginLocatorSerialization: dimensions({ bytes: beginResultBytes }),
        accessPreparation: accessPreparation(),
        addFailed: addFailed(),
        addSuccessDirect: addSuccessDirect(),
        addSuccessRespace: addSuccessRespace(),
        addReplay: addReplay(),
        moveFailed: moveFailed(),
        moveSuccessDirect: moveSuccessDirect(),
        moveSuccessRespace: moveSuccessRespace(),
        moveReplay: moveReplay(),
        beginSuccess: beginSuccess(),
        beginReuse: beginReuseCommand(),
        beginEmpty: beginEmptyCommand(),
        failedAddAndBegin: failedAddAndBegin(),
        failedMoveAndBegin: failedMoveAndBegin(),
        retryAdd: addSuccessRespace(),
        retryMove: moveSuccessRespace(),
        pageCurrentness: pageCurrentness(),
        pageRawWindow: rawPage(ORDER_WINDOW_SIZE),
        pageActiveWrites: rewriteRows(ORDER_WINDOW_SIZE, false),
        pageFull: fullPageSuccess(),
        pageShort: shortPageSuccess(),
        pageExhaustion: exhaustionSuccess(),
        pageStale: stalePage(),
        pageTerminalCleanup: terminalPage(),
        pageChangedFenceRollback: changedFenceRollback(),
        pageRetryFailure: failedFullPage(),
        continuationRequest: continuationRequest(),
      }),
      paths: Object.freeze({
        edit: Object.freeze({
          status: 'complete-static-no-admission' as const,
          cost: editCeiling(),
          ceiling: editCeiling(),
          missing:
            'runCommand has no owner Bound admission port; this declaration describes bounded actor add/move work without reserving or funding dispatch.',
        }),
        barrier: Object.freeze({
          status: 'library-sql-only' as const,
          cost: barrierCeiling(),
          ceiling: barrierCeiling(),
          missing: 'The enclosing actor command has no whole-operation Bound admission port.',
        }),
        begin: Object.freeze({
          status: 'complete-static-no-admission' as const,
          cost: beginActorCeiling(),
          ceiling: beginActorCeiling(),
          missing:
            'runCommand has no owner Bound admission port; this declaration describes bounded actor begin work without reserving or funding dispatch.',
        }),
        page: Object.freeze({
          status: 'complete-static-no-admission' as const,
          cost: pageCeiling(),
          ceiling: pageCeiling(),
          missing:
            'runCommand has no owner Bound admission port; this declaration describes bounded page work without reserving or funding dispatch. The committed outbox enqueue is a separately declared continuation request.',
        }),
        continuation: Object.freeze({
          status: 'payload-only' as const,
          cost: continuationRequest(),
          ceiling: continuationRequest(),
          missing: 'The DBOS client does not accept this nine-axis declaration for its durable enqueue transaction.',
        }),
      }),
    }),
  );
}

/** A static ceiling check only. It does not authorize work, reserve a Source ledger or fund dispatch. */
export function withinCollectionOrderCeiling<T>(cost: unknown, ceiling: Bound, dispatch: () => T): T {
  const declared = declareBound(cost);
  if (!withinCeiling(declared, ceiling)) throw new TypeError('Collection order work exceeds its static ceiling');
  return dispatch();
}

export type CollectionOrderPath = keyof ReturnType<typeof COLLECTION_ORDER_DECLARATION>['paths'];

export function withCollectionOrderDeclaration<T>(path: CollectionOrderPath, dispatch: () => T): T {
  const declaration = COLLECTION_ORDER_DECLARATION().paths[path];
  if (!('cost' in declaration)) return dispatch();
  return withinCollectionOrderCeiling(declaration.cost, declaration.ceiling, dispatch);
}

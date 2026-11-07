/** Closed eight-axis bodies for the original-home source reader and reversal settlement.
 * Runtime debits the reader body once. Admission repeats it at the Source original/prepare/
 * checkpoint/finish schedule. Core command controls are a separate selected profile, debit once.
 */
import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { COMMAND_DISPATCH_ALLOWANCE } from '../command/dispatch-lifetime.ts';
import { IDENTITY_SOURCE_ORIGINAL_SCHEDULE } from '../semantic/identity-source-maintenance-config.ts';
import acceptedAccountClaim from '../semantic/identity-epoch-binding-accepted-account.sql';
import retainedReference from '../semantic/identity-source-consumer-custody-select.sql';
import {
  originalControlWork,
  originalWorkVector,
  scaleOriginalControl,
  sumOriginalControl,
  type AccessWorkDimensions,
} from './core/index.ts';
import { ACCOUNT_IDENTITY_FENCE_SQL } from './agent-verification-identity-literals.ts';
import intentRead from './agent-verification-identity-read.sql';
import technicalRead from './agent-verification-identity-technical-read.sql';
import settlementRead from './agent-verification-identity-reversal-read.sql';
import obligations from './agent-verification-identity-reversal-obligations.sql';

export type AccountIdentityWorkDeclaration = Readonly<{
  work: AccessWorkDimensions;
  engineRequests: 0;
}>;

const declare = (work: AccessWorkDimensions): AccountIdentityWorkDeclaration => {
  originalWorkVector(work);
  return Object.freeze({ work, engineRequests: 0 as const });
};

export { ACCOUNT_IDENTITY_FENCE_SQL };

/** Subject-only technical role inventory; LIMIT 2 refuses a widened payload. */
export const ACCOUNT_IDENTITY_TECHNICAL_ROLE_SQL = `SELECT role_account_id::text AS account_id,roles FROM access.agent_identity_technical_role
     WHERE route=$1 AND account_id=$2 AND direction=$3 AND receipt_id=$4
     ORDER BY role_account_id LIMIT 2 FOR SHARE`;

function sqlWork(
  statement: string | { sql: string; source?: string },
  rows: number,
  points: number,
  emptySeeks: number,
  extraBytes: number,
): AccessWorkDimensions {
  return originalControlWork(rows, points, 1, statementBytes(statement) + extraBytes, emptySeeks);
}

function selectedCoreControl(): AccessWorkDimensions {
  const selected =
    COMMAND_DISPATCH_ALLOWANCE.profile === 'single-no-effect'
      ? COMMAND_DISPATCH_ALLOWANCE.effect
      : COMMAND_DISPATCH_ALLOWANCE.total;
  originalWorkVector(selected.work);
  return selected.work;
}

export function ACCOUNT_IDENTITY_FENCE_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_FENCE_DECLARATION, () =>
    declare(sqlWork(ACCOUNT_IDENTITY_FENCE_SQL, 1, 1, 1, 4 + 36 + 64)),
  );
}

export function ACCOUNT_IDENTITY_INTENT_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_INTENT_DECLARATION, () =>
    declare(sqlWork(intentRead, 2, 2, 2, 4 + 36 + 32 + 36 + 8192)),
  );
}

export function ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION, () =>
    declare(sqlWork(technicalRead, 3, 3, 3, 4 + 36 + 32 + 36 + 8192)),
  );
}

export function ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION, () =>
    declare(sqlWork(acceptedAccountClaim, 5, 5, 1, 4 + 36 + 64 + 8192 + 36)),
  );
}

export function ACCOUNT_IDENTITY_ROLE_INVENTORY_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_ROLE_INVENTORY_DECLARATION, () =>
    declare(sqlWork(ACCOUNT_IDENTITY_TECHNICAL_ROLE_SQL, 2, 2, 2, 4 + 36 + 32 + 36)),
  );
}

/** Technical fallback: receiver + accepted binding + role inventory. Three statements. */
export function ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION, () =>
    declare(
      sumOriginalControl(
        ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION().work,
        ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION().work,
        ACCOUNT_IDENTITY_ROLE_INVENTORY_DECLARATION().work,
      ),
    ),
  );
}

/** One original-home reader body. Fence + intent + technical fallback; Core stays outside. */
export function ACCOUNT_IDENTITY_SOURCE_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_SOURCE_DECLARATION, () =>
    declare(
      sumOriginalControl(
        ACCOUNT_IDENTITY_FENCE_DECLARATION().work,
        ACCOUNT_IDENTITY_INTENT_DECLARATION().work,
        ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION().work,
      ),
    ),
  );
}

/** Source disposition names this getter; it is the same reader body, not a second price. */
export const ACCOUNT_IDENTITY_ORIGINAL_SOURCE_DECLARATION = ACCOUNT_IDENTITY_SOURCE_DECLARATION;

function sourceAdmissionCalls(): number {
  const schedule = IDENTITY_SOURCE_ORIGINAL_SCHEDULE.source;
  const calls = schedule.original + schedule.prepare + schedule.checkpoint + schedule.finish;
  if (!Number.isSafeInteger(calls) || calls < 1) throw new RangeError('Invalid Accounts source admission multiplicity');
  return calls;
}

/** Admission repeats the reader body at original/prepare/checkpoint/finish; Core debits once. */
export function ACCOUNT_IDENTITY_SOURCE_ADMISSION_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_SOURCE_ADMISSION_DECLARATION, () =>
    declare(
      sumOriginalControl(
        scaleOriginalControl(ACCOUNT_IDENTITY_SOURCE_DECLARATION().work, sourceAdmissionCalls()),
        selectedCoreControl(),
      ),
    ),
  );
}

export function ACCOUNT_IDENTITY_SETTLEMENT_SELECT_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_SETTLEMENT_SELECT_DECLARATION, () =>
    declare(sqlWork(settlementRead, 4, 4, 1, 4 + 36 + 36 + 36)),
  );
}

export function ACCOUNT_IDENTITY_RETAINED_REFERENCE_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_RETAINED_REFERENCE_DECLARATION, () =>
    declare(sqlWork(retainedReference, 6, 6, 1, 4 + 64 + 64 + 8 + 36 + 36 + 8 + 36 + 4 + 64)),
  );
}

export function ACCOUNT_IDENTITY_OBLIGATION_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_OBLIGATION_DECLARATION, () =>
    declare(sqlWork(obligations, 4, 4, 1, 4 + 64 + 36 + 36 + 8)),
  );
}

/** One receipt's technical + bound + receiver recheck walk inside settlementFor. */
export function ACCOUNT_IDENTITY_SETTLEMENT_RECEIPT_WALK_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_SETTLEMENT_RECEIPT_WALK_DECLARATION, () =>
    declare(
      sumOriginalControl(
        ACCOUNT_IDENTITY_TECHNICAL_FALLBACK_DECLARATION().work,
        ACCOUNT_IDENTITY_ACCEPTED_BINDING_DECLARATION().work,
        ACCOUNT_IDENTITY_OBLIGATION_DECLARATION().work,
        ACCOUNT_IDENTITY_TECHNICAL_READ_DECLARATION().work,
      ),
    ),
  );
}

function settlementBody(): AccessWorkDimensions {
  return sumOriginalControl(
    ACCOUNT_IDENTITY_SETTLEMENT_SELECT_DECLARATION().work,
    ACCOUNT_IDENTITY_RETAINED_REFERENCE_DECLARATION().work,
    scaleOriginalControl(ACCOUNT_IDENTITY_SETTLEMENT_RECEIPT_WALK_DECLARATION().work, 2),
  );
}

/** Read runs settlementFor under the selected Core no-effect profile. */
export function ACCOUNT_IDENTITY_REVERSAL_READ_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_REVERSAL_READ_DECLARATION, () =>
    declare(sumOriginalControl(selectedCoreControl(), settlementBody())),
  );
}

/** Verify re-locks settlementFor inside the live command; Core is not charged again. */
export function ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION() {
  return memoizedValue(ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION, () => declare(settlementBody()));
}

/** Source disposition names this getter; it is settlementFor, not a second walk. */
export const ACCOUNT_IDENTITY_REVERSAL_SETTLEMENT_DECLARATION = ACCOUNT_IDENTITY_REVERSAL_VERIFY_DECLARATION;

export function accountIdentityNativeStep(work: AccessWorkDimensions) {
  originalWorkVector(work);
  return Object.freeze({
    rows: work.nativeRows,
    points: work.nativePoints,
    statements: work.statements,
    bytes: work.bytes,
    engineRequests: 0 as const,
  });
}

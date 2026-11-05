import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type { PoolClient, QueryResultRow } from 'pg';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import { routeOf } from '../route/route.ts';
import type { Loan } from './loan-model.ts';

export const MAX_OPEN_LOAN_PAGE = 100;
export const MAX_HISTORY_LOAN_PAGE = 50;
export const MAX_LOAN_PRESENTATION_ROWS = MAX_OPEN_LOAN_PAGE;
export const MAX_LOAN_GENERATION = 2_147_483_647;

type Operand = string | number | null;
type Point = Readonly<{ route: number; accountId: string; id: string }>;
type Generation = Readonly<{ route: number; accountId: string }>;

/** Local native SQL only. Enclosing admission, command and presentation work is independent. */
export type LoanNativePlan<Row extends QueryResultRow> = Readonly<{
  kind:
    | 'copy-lock'
    | 'loan-copy'
    | 'loan-lock'
    | 'open-loan'
    | 'generation'
    | 'advance-generation'
    | 'insert'
    | 'update';
  sql: string;
  operands: readonly Operand[];
  total: Bound;
  // Retain the result type without carrying a mutable result or execution evidence.
  result?: Row;
}>;

const bytes = (value: number): Bound =>
  declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 0,
    bytes: value,
    engineRequests: 0,
  });

/** All operands are native scalar values; freeze their detached positional representation. */
function plan<Row extends QueryResultRow>(
  kind: LoanNativePlan<Row>['kind'],
  sql: string,
  input: readonly Operand[],
  nativeRows: number,
  nativePoints: number,
  projection: Record<string, Operand> | null,
  candidates = 0,
): LoanNativePlan<Row> {
  const operands = Object.freeze([...input]);
  return Object.freeze({
    kind,
    sql,
    operands,
    total: sumBounds(
      declareBound({
        candidateKeys: candidates,
        nativeRows,
        // These statements have no identity producer, witness or Search dispatch.
        identityMetadataRows: 0,
        witnessKeys: 0,
        engineRequests: 0,
        nativePoints,
        statements: 1,
        // A failed write/lock and an empty probe retain their miss slot.
        emptySeeks: nativePoints,
        bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(operands)) + 2,
      }),
      repeatBound(bytes(projection === null ? 0 : Buffer.byteLength(JSON.stringify(projection)) + 1), 1),
    ),
  });
}

const pointOperands = ({ route, accountId, id }: Point) => [route, accountId, id] as const;
const uuid = 'f'.repeat(36);

export function loanCopyLockPlan(input: Point): LoanNativePlan<{ copy_id: string }> {
  return plan(
    'copy-lock',
    'SELECT copy_id FROM library.copy WHERE route=$1 AND account_id=$2 AND copy_id=$3 FOR UPDATE',
    pointOperands(input),
    1,
    1,
    { copy_id: uuid },
  );
}

export function loanCopyLocatorPlan(input: Point): LoanNativePlan<{ copyId: string }> {
  return plan(
    'loan-copy',
    'SELECT copy_id::text AS "copyId" FROM library.copy_loan WHERE route=$1 AND account_id=$2 AND loan_id=$3',
    pointOperands(input),
    1,
    1,
    { copyId: uuid },
  );
}

export function loanLockPlan(input: Point): LoanNativePlan<{ loan_id: string }> {
  return plan(
    'loan-lock',
    'SELECT loan_id FROM library.copy_loan WHERE route=$1 AND account_id=$2 AND loan_id=$3 FOR UPDATE',
    pointOperands(input),
    1,
    1,
    { loan_id: uuid },
  );
}

export function loanOpenProbePlan(input: Point): LoanNativePlan<{ loan_id: string }> {
  // The partial UNIQUE index proves one row independently of the explicit LIMIT.
  // Count both its point result and the LIMIT node, even on an empty result.
  return plan(
    'open-loan',
    `SELECT loan_id FROM library.copy_loan WHERE route=$1 AND account_id=$2 AND copy_id=$3
            AND returned_on IS NULL LIMIT 1`,
    pointOperands(input),
    2,
    1,
    { loan_id: uuid },
    1,
  );
}

export function loanGenerationPlan(input: Generation): LoanNativePlan<{ generation: number }> {
  return plan(
    'generation',
    'SELECT generation FROM library.copy_loan_generation WHERE route=$1 AND account_id=$2',
    [input.route, input.accountId],
    1,
    1,
    { generation: MAX_LOAN_GENERATION },
  );
}

export function loanAdvanceGenerationPlan(input: Generation): LoanNativePlan<{ generation: number }> {
  // INSERT/ON CONFLICT can visit the old and new tuple and both primary-index
  // entries. The generation table has no FK, trigger or other secondary index.
  return plan(
    'advance-generation',
    `INSERT INTO library.copy_loan_generation(route,account_id,generation) VALUES($1,$2,2)
     ON CONFLICT (route,account_id) DO UPDATE SET generation=library.copy_loan_generation.generation+1
       WHERE library.copy_loan_generation.generation < 2147483647
     RETURNING generation`,
    [input.route, input.accountId],
    4,
    2,
    { generation: MAX_LOAN_GENERATION },
  );
}

export function loanInsertPlan(
  loan: Loan,
  command: Readonly<{ time: string; transactionId: string }>,
): LoanNativePlan<QueryResultRow> {
  // Fresh rows reach the heap, primary key, open-copy uniqueness, due and owner
  // indexes. The history index excludes them. There are no loan FKs/triggers.
  return plan(
    'insert',
    `INSERT INTO library.copy_loan
             (route,loan_id,account_id,copy_id,direction,counterparty_kind,counterparty_name,counterparty_person_id,
              started_on,due_on,returned_on,revision,created_at,updated_at,transaction_id)
           VALUES ($1,$2,$3,$4,$5,$6,$7,$8,$9,$10,NULL,1,$11,$11,$12)`,
    [
      routeOf(loan.accountId),
      loan.id,
      loan.accountId,
      loan.copyId,
      loan.direction,
      loan.counterparty.kind,
      loan.counterparty.kind === 'name' ? loan.counterparty.name : null,
      loan.counterparty.kind === 'person' ? loan.counterparty.personId : null,
      loan.startedOn,
      loan.dueOn,
      command.time,
      command.transactionId,
    ],
    5,
    5,
    null,
  );
}

export function loanUpdatePlan(
  current: Loan,
  next: Loan,
  command: Readonly<{ time: string; transactionId: string }>,
): LoanNativePlan<QueryResultRow> {
  // Count old/new heap tuples and old/new index entries. Extend retains four
  // indexes (primary/open/due/owner); return replaces open/due with history.
  // A failed revision CAS consumes the same declaration; it never refunds rows.
  const indexEntries = next.returnedOn === null ? 4 + 4 : 4 + 3;
  return plan(
    'update',
    `UPDATE library.copy_loan
        SET due_on=$4, returned_on=$5, revision=$6, updated_at=$7, transaction_id=$8
      WHERE route=$1 AND account_id=$2 AND loan_id=$3 AND revision=$9 AND returned_on IS NULL`,
    [
      routeOf(current.accountId),
      current.accountId,
      current.id,
      next.dueOn,
      next.returnedOn,
      next.revision,
      command.time,
      command.transactionId,
      current.revision,
    ],
    2 + indexEntries,
    1 + indexEntries,
    null,
  );
}

/** Consume before dispatch on the caller's live frame and original client. No new admission. */
export function executeLoanNative<Row extends QueryResultRow>(
  client: Pick<PoolClient, 'query'>,
  declaration: LoanNativePlan<Row>,
) {
  const dispatch = () => client.query<Row>(declaration.sql, [...declaration.operands]);
  const association = currentCommandWorkAssociation();
  // Explicit nine/eight-axis translation: every leaf here executes only SQL.
  // engineRequests remains in the public declaration, with native evidence zero.
  const { engineRequests: _engineRequests, ...work } = declaration.total;
  return association ? association.run(`library.loan.${declaration.kind}`, work, dispatch) : dispatch();
}

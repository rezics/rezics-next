import { memoizedValue } from '../memoized.ts';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import type { PoolClient, QueryResultRow } from 'pg';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import { routeOf } from '../route/route.ts';
import type { Actor } from '../request/access.ts';
import { MAX_LOAN_PARTY_SCALARS, MAX_LOAN_REVISION, type Loan } from './loan-model.ts';

export const MAX_OPEN_LOAN_PAGE = 100;
export const MAX_HISTORY_LOAN_PAGE = 50;
export const MAX_LOAN_GENERATION = 2_147_483_647;

export type LoanHttpOperation = 'list' | 'create' | 'extend' | 'return';
export type LoanHttpWorkContext = Readonly<{
  operation: LoanHttpOperation;
  request: Request;
  actor: Actor;
  deadline: number;
  input: unknown;
  workerAllowance: 0;
}>;
export type LoanHttpWorkOwner = <T>(context: LoanHttpWorkContext, dispatch: () => Promise<T>) => Promise<T>;

/** The route forwards the existing request frame; only its manifest owner can bind funding. */
export function withLoanHttpWork<T>(
  owner: LoanHttpWorkOwner | undefined,
  context: LoanHttpWorkContext,
  dispatch: () => Promise<T>,
): Promise<T> {
  return owner ? owner(context, dispatch) : dispatch();
}

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
    | 'update'
    | 'copy-read'
    | 'loan-read'
    | 'loan-cursor'
    | 'loan-page-first'
    | 'loan-page-dated'
    | 'loan-page-undated'
    | 'loan-history-first'
    | 'loan-history-next';
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
  projectionRows = 1,
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
      repeatBound(bytes(projection === null ? 0 : Buffer.byteLength(JSON.stringify(projection)) + 1), projectionRows),
    ),
  });
}

const pointOperands = ({ route, accountId, id }: Point) => [route, accountId, id] as const;
const uuid = 'f'.repeat(36);
function copyProjection() {
  return memoizedValue(copyProjection, () => ({
    copyId: uuid,
    accountId: uuid,
    subjectId: uuid,
    revision: MAX_LOAN_REVISION,
    kind: 'k'.repeat(64),
    status: 's'.repeat(64),
    disposedOn: '9999-12-31',
    deletionId: uuid,
  }));
}
// Copy writers admit only the existing 1..64 ASCII vocabulary IDs. Loan names
// admit 300 Unicode scalars, so four UTF-8 bytes per scalar bounds their JSON
// projection without changing the private operand.
function loanProjection() {
  return memoizedValue(loanProjection, () => ({
    loanId: uuid,
    accountId: uuid,
    copyId: uuid,
    direction: 'borrowed',
    counterpartyKind: 'name',
    counterpartyName: '\u{1f9ed}'.repeat(MAX_LOAN_PARTY_SCALARS),
    counterpartyPersonId: uuid,
    startedOn: '9999-12-31T00:00:00.000Z',
    dueOn: '9999-12-31T00:00:00.000Z',
    returnedOn: '9999-12-31T00:00:00.000Z',
    revision: MAX_LOAN_REVISION,
    copySubjectId: uuid,
    copyRevision: MAX_LOAN_REVISION,
    copyKind: 'k'.repeat(64),
    copyStatus: 's'.repeat(64),
    copyDisposedOn: '9999-12-31',
    copyDeletionId: uuid,
  }));
}

const loanColumns = `l.loan_id::text AS "loanId", l.account_id::text AS "accountId", l.copy_id::text AS "copyId",
       l.direction, l.counterparty_kind AS "counterpartyKind", l.counterparty_name AS "counterpartyName",
       l.counterparty_person_id::text AS "counterpartyPersonId", l.started_on AS "startedOn", l.due_on AS "dueOn",
       l.returned_on AS "returnedOn", l.revision`;
const pageColumns = `p.loan_id::text AS "loanId", p.account_id::text AS "accountId", p.copy_id::text AS "copyId",
       p.direction, p.counterparty_kind AS "counterpartyKind", p.counterparty_name AS "counterpartyName",
       p.counterparty_person_id::text AS "counterpartyPersonId", p.started_on AS "startedOn", p.due_on AS "dueOn",
       p.returned_on AS "returnedOn", p.revision`;
const copyJoin = `LEFT JOIN LATERAL (
  SELECT c.subject_id::text AS "copySubjectId", c.revision AS "copyRevision", c.kind AS "copyKind",
         c.status AS "copyStatus", c.disposed_on AS "copyDisposedOn", c.deletion_id::text AS "copyDeletionId"
    FROM library.copy c
   WHERE c.route=p.route AND c.account_id=p.account_id AND c.copy_id=p.copy_id LIMIT 1
) c ON true`;

export type LoanPageSeek = Readonly<{
  day: string;
  id: string;
  undated?: boolean;
}>;
export type LoanNativeRow = QueryResultRow & {
  loanId: string;
  accountId: string;
  copyId: string;
  direction: 'lent' | 'borrowed';
  counterpartyKind: 'name' | 'person';
  counterpartyName: string | null;
  counterpartyPersonId: string | null;
  startedOn: string | Date;
  dueOn: string | Date | null;
  returnedOn: string | Date | null;
  revision: number;
  copySubjectId: string | null;
  copyRevision: number | null;
  copyKind: string | null;
  copyStatus: string | null;
  copyDisposedOn: string | Date | null;
  copyDeletionId: string | null;
};
export type LoanPageInput = Readonly<{
  route: number;
  accountId: string;
  filter: 'open' | 'history';
  limit: number;
  after: LoanPageSeek | null;
}>;

export function loanCopyReadPlan(input: Point): LoanNativePlan<{ copyId: string }> {
  return plan(
    'copy-read',
    `SELECT copy_id::text AS "copyId", account_id::text AS "accountId", subject_id::text AS "subjectId",
            revision, kind, status, disposed_on::text AS "disposedOn", deletion_id::text AS "deletionId"
       FROM library.copy WHERE route=$1 AND account_id=$2 AND copy_id=$3`,
    pointOperands(input),
    1,
    1,
    copyProjection(),
  );
}

export function loanReadPlan(input: Point): LoanNativePlan<LoanNativeRow> {
  return plan(
    'loan-read',
    `SELECT ${loanColumns},
            c.subject_id::text AS "copySubjectId", c.revision AS "copyRevision", c.kind AS "copyKind",
            c.status AS "copyStatus", c.disposed_on AS "copyDisposedOn", c.deletion_id::text AS "copyDeletionId"
       FROM library.copy_loan l
       LEFT JOIN library.copy c ON c.route=l.route AND c.account_id=l.account_id AND c.copy_id=l.copy_id
      WHERE l.route=$1 AND l.account_id=$2 AND l.loan_id=$3`,
    pointOperands(input),
    2,
    2,
    loanProjection(),
  );
}

export function loanCursorDuePlan(input: Point): LoanNativePlan<{ dueOn: string | Date | null }> {
  return plan(
    'loan-cursor',
    'SELECT due_on AS "dueOn" FROM library.copy_loan WHERE route=$1 AND account_id=$2 AND loan_id=$3',
    pointOperands(input),
    1,
    1,
    { dueOn: '9999-12-31T00:00:00.000Z' },
  );
}

function pageProjection(): Record<string, Operand> {
  return loanProjection();
}

function pagePlan(
  kind: LoanNativePlan<LoanNativeRow>['kind'],
  sql: string,
  operands: readonly Operand[],
  candidates: number,
  branches: number,
  pageRows: number,
): LoanNativePlan<LoanNativeRow> {
  // Each raw candidate is one bounded index result. Only the final page is
  // joined to current copies, one exact copy-primary-key probe per row.
  return plan(kind, sql, operands, candidates + pageRows, branches + pageRows, pageProjection(), candidates, pageRows);
}

export function loanPagePlan(input: LoanPageInput): LoanNativePlan<LoanNativeRow> {
  const { route, accountId, filter, after, limit } = input;
  const owner = [route, accountId] as const;
  if (filter === 'open' && after?.undated) {
    const sql = `WITH page AS (
      SELECT l.route,l.loan_id,l.account_id,l.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
             l.counterparty_person_id,l.started_on,l.due_on,l.returned_on,l.revision
        FROM library.copy_loan l
       WHERE l.route=$1 AND l.account_id=$2 AND l.returned_on IS NULL AND l.due_on IS NULL AND l.loan_id>$3::uuid
       ORDER BY l.due_on ASC NULLS LAST,l.loan_id ASC LIMIT $4
    )
    SELECT ${pageColumns}, c."copySubjectId",c."copyRevision",c."copyKind",c."copyStatus",c."copyDisposedOn",c."copyDeletionId"
      FROM page p ${copyJoin}
     ORDER BY p.due_on ASC NULLS LAST,p.loan_id ASC`;
    return pagePlan('loan-page-undated', sql, [route, accountId, after.id, limit], limit, 1, limit);
  }

  if (filter === 'open' && after) {
    const sql = `WITH candidates AS (
      (SELECT l.route,l.loan_id,l.account_id,l.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
              l.counterparty_person_id,l.started_on,l.due_on,l.returned_on,l.revision
         FROM library.copy_loan l
        WHERE l.route=$1 AND l.account_id=$2 AND l.returned_on IS NULL AND l.due_on IS NOT NULL
          AND (l.due_on,l.loan_id)>($3::date,$4::uuid)
        ORDER BY l.due_on ASC NULLS LAST,l.loan_id ASC LIMIT $5)
      UNION ALL
      (SELECT l.route,l.loan_id,l.account_id,l.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
              l.counterparty_person_id,l.started_on,l.due_on,l.returned_on,l.revision
         FROM library.copy_loan l
         WHERE l.route=$1 AND l.account_id=$2 AND l.returned_on IS NULL AND l.due_on IS NULL
        ORDER BY l.due_on ASC NULLS LAST,l.loan_id ASC LIMIT $5)
    ), page AS (
      SELECT * FROM candidates ORDER BY due_on ASC NULLS LAST,loan_id ASC LIMIT $5
    )
    SELECT ${pageColumns}, c."copySubjectId",c."copyRevision",c."copyKind",c."copyStatus",c."copyDisposedOn",c."copyDeletionId"
      FROM page p ${copyJoin}
     ORDER BY p.due_on ASC NULLS LAST,p.loan_id ASC`;
    return pagePlan('loan-page-dated', sql, [route, accountId, after.day, after.id, limit], limit * 2, 2, limit);
  }

  if (filter === 'history' && after) {
    const sql = `WITH page AS (
      SELECT l.route,l.loan_id,l.account_id,l.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
             l.counterparty_person_id,l.started_on,l.due_on,l.returned_on,l.revision
        FROM library.copy_loan l
       WHERE l.route=$1 AND l.account_id=$2 AND l.returned_on IS NOT NULL
         AND (l.returned_on,l.loan_id)<($3::date,$4::uuid)
       ORDER BY l.returned_on DESC,l.loan_id DESC LIMIT $5
    )
    SELECT ${pageColumns}, c."copySubjectId",c."copyRevision",c."copyKind",c."copyStatus",c."copyDisposedOn",c."copyDeletionId"
      FROM page p ${copyJoin}
     ORDER BY p.returned_on DESC,p.loan_id DESC`;
    return pagePlan('loan-history-next', sql, [route, accountId, after.day, after.id, limit], limit, 1, limit);
  }

  if (filter === 'open') {
    const sql = `WITH page AS (
      SELECT l.route,l.loan_id,l.account_id,l.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
             l.counterparty_person_id,l.started_on,l.due_on,l.returned_on,l.revision
        FROM library.copy_loan l
       WHERE l.route=$1 AND l.account_id=$2 AND l.returned_on IS NULL
       ORDER BY l.due_on ASC NULLS LAST,l.loan_id ASC LIMIT $3
    )
    SELECT ${pageColumns}, c."copySubjectId",c."copyRevision",c."copyKind",c."copyStatus",c."copyDisposedOn",c."copyDeletionId"
      FROM page p ${copyJoin}
     ORDER BY p.due_on ASC NULLS LAST,p.loan_id ASC`;
    return pagePlan('loan-page-first', sql, [...owner, limit], limit, 1, limit);
  }

  const sql = `WITH page AS (
    SELECT l.route,l.loan_id,l.account_id,l.copy_id,l.direction,l.counterparty_kind,l.counterparty_name,
           l.counterparty_person_id,l.started_on,l.due_on,l.returned_on,l.revision
      FROM library.copy_loan l
     WHERE l.route=$1 AND l.account_id=$2 AND l.returned_on IS NOT NULL
     ORDER BY l.returned_on DESC,l.loan_id DESC LIMIT $3
  )
  SELECT ${pageColumns}, c."copySubjectId",c."copyRevision",c."copyKind",c."copyStatus",c."copyDisposedOn",c."copyDeletionId"
    FROM page p ${copyJoin}
   ORDER BY p.returned_on DESC,p.loan_id DESC`;
  return pagePlan('loan-history-first', sql, [...owner, limit], limit, 1, limit);
}

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

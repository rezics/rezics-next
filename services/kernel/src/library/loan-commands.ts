import type { Pool, PoolClient } from 'pg';
import { readAccount } from '../access/account-data.ts';
import { GrantDeniedError } from '../access/grant-commands.ts';
import {
  authoritativeTimeValue,
  commandAttemptDeadline,
  type CommandAttempt,
  type CommandTransaction,
} from '../command/command.ts';
import { systemClock, type KernelClock } from '../clock.ts';
import { withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem-error.ts';
import { type AccountActor, type Access, type Actor } from '../request/access.ts';
import { deadlineFor, withRequestDeadline } from '../request/deadline.ts';
import { newId, partitionOf, routeOf } from '../route/route.ts';
import { decodeCursor, encodeCursor, type CursorBinding } from '../tokens/cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import { admitEntryAttempt } from './entry-lifecycle.ts';
import {
  createLibraryCommandRunner,
  LibraryNotFoundError,
  sameAccountRoute,
  WORK_STEP_DEADLINE_MS,
} from './command-support.ts';
import {
  assertLoanCopyOperand,
  createLoanRecord,
  extendLoanRecord,
  loanState,
  LoanConflictError,
  LoanNotFoundError,
  parseLoanCreate,
  parseLoanExtend,
  parseLoanReturn,
  returnLoanRecord,
  type Loan,
  type LoanState,
} from './loan-model.ts';
import { loanDueBoundary, type LoanDueBoundary } from './loan-date.ts';
import { readLibraryProfileSource } from './profile-source.ts';
import { hasCopyStatus } from './profile.ts';
import { readIdentityMappings } from '../semantic/identity-adapters/read.ts';
import { readSubjectSummaries } from '../semantic/summaries.ts';
import type { LibraryProfileSource } from './profile-source.ts';

import {
  executeLoanNative,
  loanAdvanceGenerationPlan,
  loanCopyLocatorPlan,
  loanCopyLockPlan,
  loanCopyReadPlan,
  loanCursorDuePlan,
  loanGenerationPlan,
  loanInsertPlan,
  loanLockPlan,
  loanOpenProbePlan,
  loanPagePlan,
  loanReadPlan,
  loanUpdatePlan,
  type LoanNativeRow,
  MAX_HISTORY_LOAN_PAGE,
  MAX_OPEN_LOAN_PAGE,
} from './loan-operation-bounds.ts';
const UNDATED_SORT_DAY = '9999-12-31';
const LOAN_EVENT = 'com.rezics.library.copy-loan.changed.v1';
const SOFT_SEMANTIC_FAILURES = new Set(['semantic_not_ready', 'dependency_unavailable']);

type Dependencies = { pool: Pool; access: Access; routeKey: Uint8Array; tokens: KeyRing; clock?: KernelClock };
type CopyRow = {
  id: string;
  accountId: string;
  subjectId: string;
  revision: number;
  kind: string | null;
  status: string;
  disposedOn: string | null;
  deletionId: string | null;
};
type LoanRow = LoanNativeRow;
export type LoanFilter = 'open' | 'history';
export type LoanAction = Readonly<{ allowed: boolean; reason: 'returned' | 'copy_unavailable' | null }>;
export type LoanPageItem = Readonly<{
  loan: Loan;
  state: LoanState;
  viewer: Readonly<{ state: 'owner' }>;
  actions: Readonly<{ extend: LoanAction; return: LoanAction }>;
  copy: Readonly<{
    state: 'available' | 'deleted' | 'missing';
    id: string;
    revision: number | null;
    kind: string | null;
    status: string | null;
    subjectId: string | null;
  }>;
}>;
export type LoanPage = Readonly<{
  filter: LoanFilter;
  boundary: LoanDueBoundary;
  generation: number;
  items: readonly LoanPageItem[];
  nextCursor: string | null;
}>;

type PreparedCreate = Readonly<{
  copy: CopyRow | null;
  source: LibraryProfileSource | null;
  personAdmitted: boolean;
  error: unknown | null;
}>;

function requireActor(actor: Actor, action: string): AccountActor {
  if (actor.kind !== 'account' || routeOf(actor.accountId) === null || !actor.scopes.includes(action))
    throw new GrantDeniedError();
  return actor;
}

async function admitAccount(client: Pick<PoolClient, 'query'>, owner: AccountActor): Promise<void> {
  const route = routeOf(owner.accountId);
  if (route === null) throw new GrantDeniedError();
  const current = await readAccount(client, route, owner.accountId);
  if (!current || current.kind !== 'actor' || current.state !== 'active' || current.fenced)
    throw new GrantDeniedError();
}

async function readOnly<T>(pool: Pool, owner: AccountActor, body: (client: PoolClient) => Promise<T>): Promise<T> {
  return withConnection(pool, async (client) => {
    await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    try {
      await admitAccount(client, owner);
      const value = await body(client);
      await client.query('COMMIT');
      return value;
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    }
  });
}

function copyView(row: Record<string, unknown> | undefined): CopyRow | null {
  if (!row) return null;
  return {
    id: String(row.copyId),
    accountId: String(row.accountId),
    subjectId: String(row.subjectId),
    revision: Number(row.revision),
    kind: typeof row.kind === 'string' ? row.kind : null,
    status: String(row.status),
    disposedOn: row.disposedOn == null ? null : String(row.disposedOn),
    deletionId: row.deletionId == null ? null : String(row.deletionId),
  };
}

async function readCopy(client: Pick<PoolClient, 'query'>, route: number, accountId: string, copyId: string) {
  const result = await executeLoanNative(client, loanCopyReadPlan({ route, accountId, id: copyId }));
  return copyView(result.rows[0]);
}

async function lockCopy(tx: CommandTransaction, route: number, accountId: string, copyId: string) {
  await executeLoanNative(tx, loanCopyLockPlan({ route, accountId, id: copyId }));
  return readCopy(tx, route, accountId, copyId);
}

function dateText(value: string | Date | null): string | null {
  if (value === null) return null;
  return value instanceof Date ? value.toISOString().slice(0, 10) : value;
}

function loanFromRow(row: LoanRow): Loan {
  const counterparty =
    row.counterpartyKind === 'name'
      ? { kind: 'name' as const, name: row.counterpartyName! }
      : { kind: 'person' as const, personId: row.counterpartyPersonId! };
  return Object.freeze({
    id: row.loanId,
    accountId: row.accountId,
    copyId: row.copyId,
    direction: row.direction,
    counterparty: Object.freeze(counterparty),
    startedOn: dateText(row.startedOn)!,
    dueOn: dateText(row.dueOn),
    returnedOn: dateText(row.returnedOn),
    revision: Number(row.revision),
  });
}

function rowItem(row: LoanRow, boundary: LoanDueBoundary): LoanPageItem {
  const loan = loanFromRow(row);
  const state = loanState(loan, boundary);
  const available = row.copySubjectId !== null && row.copyDeletionId === null && row.copyDisposedOn === null;
  const reason = state === 'returned' ? 'returned' : available ? null : 'copy_unavailable';
  const action = Object.freeze({ allowed: reason === null, reason });
  return Object.freeze({
    loan,
    state,
    viewer: Object.freeze({ state: 'owner' as const }),
    actions: Object.freeze({ extend: action, return: action }),
    copy: Object.freeze({
      state:
        row.copySubjectId === null
          ? 'missing'
          : row.copyDeletionId !== null
            ? 'deleted'
            : available
              ? 'available'
              : 'missing',
      id: row.copyId,
      revision: row.copyRevision === null ? null : Number(row.copyRevision),
      kind: row.copyKind,
      status: row.copyStatus,
      subjectId: row.copySubjectId,
    }),
  });
}

function cursorBinding(accountId: string, filter: LoanFilter): CursorBinding {
  return {
    operation: 'copy-loan.list',
    parameters: {
      accountId,
      filter,
      order: filter === 'open' ? 'dueOn-asc-loanId-asc' : 'returnedOn-desc-loanId-desc',
      lifetime: 'generation-15m-v1',
    },
  };
}

function cursorAfter(tokens: KeyRing, binding: CursorBinding, token: string, generation: number, filter: LoanFilter) {
  const cursor = decodeCursor(tokens, binding, token);
  if (!cursor.ok || typeof cursor.after[0] !== 'string' || typeof cursor.after[1] !== 'string')
    throw new ProblemError('invalid_cursor');
  if (cursor.epoch !== generation) throw new ProblemError('stale_cursor');
  const day = cursor.after[0];
  if (!/^\d{4}-\d{2}-\d{2}$/.test(day) || routeOf(cursor.after[1]) === null) throw new ProblemError('invalid_cursor');
  if (filter === 'open') {
    if (day > UNDATED_SORT_DAY || cursor.after.length < 2 || cursor.after.length > 3)
      throw new ProblemError('invalid_cursor');
    if (cursor.after.length === 2)
      return {
        day,
        id: cursor.after[1],
        undated: day === UNDATED_SORT_DAY ? null : false,
      };
    const dueState = cursor.after[2];
    if ((dueState !== 'dated' && dueState !== 'undated') || (day !== UNDATED_SORT_DAY && dueState === 'undated'))
      throw new ProblemError('invalid_cursor');
    return { day, id: cursor.after[1], undated: dueState === 'undated' };
  }
  if (cursor.after.length !== 2) throw new ProblemError('invalid_cursor');
  return { day, id: cursor.after[1], undated: false };
}

async function bumpGeneration(tx: CommandTransaction, route: number, accountId: string): Promise<number> {
  const result = await executeLoanNative(tx, loanAdvanceGenerationPlan({ route, accountId }));
  if (!result.rows[0]) throw new LoanConflictError('revision_exhausted');
  return Number(result.rows[0].generation);
}

function event(accountId: string, loanId: string) {
  return { type: LOAN_EVENT, subject: accountId, data: { loanId } };
}

async function readLoan(tx: Pick<PoolClient, 'query'>, route: number, accountId: string, loanId: string) {
  const result = await executeLoanNative(tx, loanReadPlan({ route, accountId, id: loanId }));
  return result.rows[0] ?? null;
}

async function lockLoan(tx: CommandTransaction, route: number, accountId: string, loanId: string): Promise<Loan> {
  const initial = await executeLoanNative(tx, loanCopyLocatorPlan({ route, accountId, id: loanId }));
  const copyId = initial.rows[0]?.copyId;
  if (!copyId) throw new LoanNotFoundError();
  // Use the same lock order as copy disposal and loan creation: exact copy, then loan.
  await lockCopy(tx, route, accountId, copyId);
  await executeLoanNative(tx, loanLockPlan({ route, accountId, id: loanId }));
  const row = await readLoan(tx, route, accountId, loanId);
  if (!row) throw new LoanNotFoundError();
  if (
    row.returnedOn === null &&
    (row.copySubjectId === null ||
      row.copyDeletionId !== null ||
      row.copyDisposedOn !== null ||
      row.copyStatus !== 'owned')
  )
    throw new LoanConflictError('copy_unavailable');
  return loanFromRow(row);
}

async function updateLoan(
  tx: CommandTransaction,
  current: Loan,
  next: Loan,
  command: { transactionId: string; time: string },
): Promise<void> {
  const result = await executeLoanNative(tx, loanUpdatePlan(current, next, command));
  if (result.rowCount !== 1) throw new LoanConflictError('stale_revision');
}

async function currentCopyForPreparation(pool: Pool, owner: AccountActor, route: number, copyId: string) {
  return readOnly(pool, owner, (client) => readCopy(client, route, owner.accountId, copyId));
}

async function personReferenceAdmitted(
  deps: Dependencies,
  actor: Actor,
  personId: string,
  deadline: number,
): Promise<boolean> {
  const accountRoute = actor.kind === 'account' ? routeOf(actor.accountId) : null;
  const personRoute = routeOf(personId);
  if (accountRoute === null || personRoute === null || partitionOf(personRoute) !== partitionOf(accountRoute))
    return false;
  const before = await readIdentityMappings(deps.pool, [personId]);
  const mapping = before[0];
  if (mapping?.state !== 'mapped') return false;
  const summary = (
    await readSubjectSummaries({ pool: deps.pool, routeKey: deps.routeKey, access: deps.access, actor, deadline }, [
      mapping.terminal,
    ])
  ).get(mapping.terminal);
  const after = await readIdentityMappings(deps.pool, [personId]);
  if (stableJson(before) !== stableJson(after)) return false;
  return Boolean(
    summary &&
    (summary.type === 'schema:Person' ||
      summary.types.includes('schema:Person') ||
      summary.types.includes('foaf:Person')),
  );
}

function stableJson(value: unknown): string {
  return JSON.stringify(value, (_key, item: unknown) => (typeof item === 'bigint' ? item.toString() : item)) ?? '';
}

export async function loanPeopleDisplay(
  deps: Dependencies,
  actor: Actor,
  personIds: readonly string[],
  deadline: number,
  languages: readonly string[] = [],
): Promise<Map<string, string | null>> {
  const selected = [...new Set(personIds)];
  if (!selected.length) return new Map();
  const concealed = () => new Map(selected.map((id) => [id, null]));
  try {
    const before = await readIdentityMappings(deps.pool, selected);
    const mappings = new Map(selected.map((id, index) => [id, before[index]!]));
    const terminals = [...new Set(before.flatMap((mapping) => (mapping.state === 'mapped' ? [mapping.terminal] : [])))];
    const summaries = await readSubjectSummaries(
      { pool: deps.pool, routeKey: deps.routeKey, access: deps.access, actor, deadline },
      terminals,
      { languages },
    );
    const after = await readIdentityMappings(deps.pool, selected);
    const stable = new Map(
      selected.map((id, index) => [id, stableJson(mappings.get(id)) === stableJson(after[index])]),
    );
    return new Map(
      selected.map((id) => {
        const mapping = mappings.get(id);
        const summary = mapping?.state === 'mapped' ? summaries.get(mapping.terminal) : null;
        const isPerson =
          summary &&
          (summary.type === 'schema:Person' ||
            summary.types.includes('schema:Person') ||
            summary.types.includes('foaf:Person'));
        return [id, stable.get(id) && isPerson ? (summary.label?.value ?? null) : null];
      }),
    );
  } catch (error) {
    if (error instanceof ProblemError && SOFT_SEMANTIC_FAILURES.has(error.code)) return concealed();
    throw error;
  }
}

export function createLoanCommands(config: Dependencies) {
  const { pool, access, routeKey, tokens, clock = systemClock } = config;
  const runner = createLibraryCommandRunner({ pool, clock });

  async function createLoan(actor: Actor, input: unknown, requestKey: string, deadline?: number) {
    const owner = requireActor(actor, 'copy:create');
    const parsed = parseLoanCreate(input);
    const route = sameAccountRoute(owner.accountId, parsed.copyId);
    const operationDeadline = deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(operationDeadline, () =>
      runner.ownAccountPrepared<PreparedCreate, Loan>(
        owner,
        {
          action: 'copy:create',
          kind: 'library.copy-loan.create',
          requestKey,
          input: parsed,
          deadline: operationDeadline,
          async prepare(attempt: CommandAttempt) {
            const deadline = commandAttemptDeadline(attempt);
            await admitEntryAttempt(config, owner, 'copy:create', attempt, deadline);
            const copy = await currentCopyForPreparation(pool, owner, route, parsed.copyId);
            if (!copy) return { copy: null, source: null, personAdmitted: false, error: null };
            try {
              const source = await readLibraryProfileSource(
                { pool, access, actor: owner, at: attempt.time, deadline },
                copy.subjectId,
              );
              let personAdmitted = true;
              if (parsed.counterparty.kind === 'person')
                personAdmitted = await personReferenceAdmitted(config, owner, parsed.counterparty.personId, deadline);
              return { copy, source, personAdmitted, error: null };
            } catch (error) {
              return { copy, source: null, personAdmitted: false, error };
            }
          },
        },
        async (tx, command, prepared) => {
          if (prepared.error) throw prepared.error;
          if (!prepared.copy || !prepared.source) throw new LibraryNotFoundError();
          const copy = await lockCopy(tx, route, owner.accountId, parsed.copyId);
          assertLoanCopyOperand(owner.accountId, parsed, copy);
          if (
            !copy ||
            copy.subjectId !== prepared.copy.subjectId ||
            copy.deletionId !== null ||
            copy.status !== 'owned'
          )
            throw new LoanConflictError('copy_unavailable');
          if (
            prepared.source.subjectId !== copy.subjectId ||
            prepared.source.kind !== 'supported' ||
            copy.kind === null ||
            !hasCopyStatus(prepared.source.profile, copy.kind, 'owned')
          )
            throw new ProblemError('unsupported_library_profile');
          if (parsed.counterparty.kind === 'person' && !prepared.personAdmitted) throw new LoanNotFoundError();
          const existing = await executeLoanNative(
            tx,
            loanOpenProbePlan({ route, accountId: owner.accountId, id: parsed.copyId }),
          );
          if (existing.rows.length) throw new LoanConflictError('copy_unavailable');
          const loan = createLoanRecord({ id: newId(route), accountId: owner.accountId }, parsed);
          const time = authoritativeTimeValue(command.time);
          await executeLoanNative(tx, loanInsertPlan(loan, { time, transactionId: command.transactionId }));
          await bumpGeneration(tx, route, owner.accountId);
          return { value: loan, events: [event(owner.accountId, loan.id)] };
        },
      ),
    );
  }

  async function extendLoan(actor: Actor, loanId: string, input: unknown, requestKey: string, deadline?: number) {
    const owner = requireActor(actor, 'copy:update');
    const parsed = parseLoanExtend(input);
    const route = sameAccountRoute(owner.accountId, loanId);
    const operationDeadline = deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(operationDeadline, () =>
      runner.ownAccountPrepared(
        owner,
        {
          action: 'copy:update',
          kind: 'library.copy-loan.extend',
          requestKey,
          input: { loanId, ...parsed },
          deadline: operationDeadline,
          prepare: (attempt) =>
            admitEntryAttempt(config, owner, 'copy:update', attempt, commandAttemptDeadline(attempt)),
        },
        async (tx, command) => {
          const current = await lockLoan(tx, route, owner.accountId, loanId);
          const next = extendLoanRecord(current, parsed);
          await updateLoan(tx, current, next, {
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
          });
          await bumpGeneration(tx, route, owner.accountId);
          return { value: next, events: [event(owner.accountId, loanId)] };
        },
      ),
    );
  }

  async function returnLoan(actor: Actor, loanId: string, input: unknown, requestKey: string, deadline?: number) {
    const owner = requireActor(actor, 'copy:update');
    const parsed = parseLoanReturn(input);
    const route = sameAccountRoute(owner.accountId, loanId);
    const boundary = loanDueBoundary(clock());
    const operationDeadline = deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(operationDeadline, () =>
      runner.ownAccountPrepared(
        owner,
        {
          action: 'copy:update',
          kind: 'library.copy-loan.return',
          requestKey,
          input: { loanId, ...parsed },
          deadline: operationDeadline,
          prepare: (attempt) =>
            admitEntryAttempt(config, owner, 'copy:update', attempt, commandAttemptDeadline(attempt)),
        },
        async (tx, command) => {
          const current = await lockLoan(tx, route, owner.accountId, loanId);
          const next = returnLoanRecord(current, parsed, boundary);
          await updateLoan(tx, current, next, {
            transactionId: command.transactionId,
            time: authoritativeTimeValue(command.time),
          });
          await bumpGeneration(tx, route, owner.accountId);
          return { value: next, events: [event(owner.accountId, loanId)] };
        },
      ),
    );
  }

  async function listLoans(
    actor: Actor,
    input: { filter: LoanFilter; cursor?: string; limit: number },
    deadline?: number,
  ): Promise<LoanPage> {
    const owner = requireActor(actor, 'copy:list');
    const route = routeOf(owner.accountId)!;
    const filter = input.filter;
    const maxPage = filter === 'open' ? MAX_OPEN_LOAN_PAGE : MAX_HISTORY_LOAN_PAGE;
    const size = Math.max(1, Math.min(maxPage, input.limit));
    const binding = cursorBinding(owner.accountId, filter);
    const boundary = loanDueBoundary(clock());
    const cursor = input.cursor;
    const operationDeadline = deadline ?? deadlineFor(WORK_STEP_DEADLINE_MS);
    return withRequestDeadline(operationDeadline, () =>
      readOnly(pool, owner, async (client) => {
        const generationRow = await executeLoanNative(
          client,
          loanGenerationPlan({ route, accountId: owner.accountId }),
        );
        const generation = Number(generationRow.rows[0]?.generation ?? 1);
        let after = cursor ? cursorAfter(tokens, binding, cursor, generation, filter) : null;
        if (after?.undated === null) {
          const cursorRow = await executeLoanNative(
            client,
            loanCursorDuePlan({ route, accountId: owner.accountId, id: after.id }),
          );
          const dueOn = cursorRow.rows[0]?.dueOn;
          if (dueOn === undefined) throw new Error('A generation-current legacy loan cursor has no retained loan');
          after = { ...after, undated: dueOn === null };
        }
        const rows = await executeLoanNative(
          client,
          loanPagePlan({
            route,
            accountId: owner.accountId,
            filter,
            after: after
              ? {
                  day: after.day,
                  id: after.id,
                  undated: after.undated ?? false,
                }
              : null,
            limit: size + 1,
          }),
        );
        const visible = rows.rows.slice(0, size);
        const last = visible.at(-1);
        const nextCursor =
          rows.rows.length > size && last
            ? encodeCursor(tokens, binding, {
                epoch: generation,
                after: [
                  filter === 'open' ? (dateText(last.dueOn) ?? UNDATED_SORT_DAY) : dateText(last.returnedOn)!,
                  last.loanId,
                  ...(filter === 'open' ? [last.dueOn === null ? 'undated' : 'dated'] : []),
                ],
              })
            : null;
        return Object.freeze({
          filter,
          boundary,
          generation,
          items: Object.freeze(visible.map((row) => rowItem(row, boundary))),
          nextCursor,
        });
      }),
    );
  }

  return { createLoan, extendLoan, returnLoan, listLoans };
}

import { BOUND_AXES, declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import { AsyncLocalStorage } from 'node:async_hooks';
import { currentCommandWorkAssociation, currentLibraryOperationAccounting } from '../command/work-context.ts';
import type { WorkDimensions } from './collection-source.ts';
import accountShare from '../access/account-share.sql';
import accountCommandState from '../access/account-command-state.sql';
import timeRead from '../command/time.sql';
import receiptRead from '../command/read-receipt.sql';
import eventFence from '../command/fence.sql';
import noEffectFence from '../command/no-effect-fence.sql';
import partitionRead from '../partition/read.sql';
import subjectReference from '../semantic/read-subject-reference.sql';
import summariesRead from '../semantic/summaries-read.sql';
import representativesRead from '../semantic/summaries-representative-editions.sql';
import coverReferences from '../content/read-cover-reference.sql';
import sourceFences from '../content/read-source-fences.sql';
import mappingOwners from '../semantic/identity-epoch-read-owners.sql';
import mappingSources from '../semantic/identity-epoch-read-sources.sql';
import mappingPending from '../semantic/identity-epoch-read-pending.sql';
import mappingCurrent from '../semantic/identity-terminal-closure-current.sql';
import labelInsert from './label-store-insert.sql';
import labelRead from './label-store-read.sql';
import labelRename from './label-store-rename.sql';
import labelLifecycle from './label-store-lifecycle.sql';
import cataloguePage from './label-catalogue-page.sql';
import cataloguePrefix from './label-catalogue-prefix.sql';
import assignmentGuard from './label-assignment-guard.sql';
import assignmentParents from './label-assignment-parents.sql';
import assignmentReservations from './label-assignment-reservations.sql';
import assignmentReclaim from './label-assignment-reclaim.sql';
import assignmentSet from './label-assignment-set.sql';
import assignmentRead from './label-assignment-read.sql';
import assignmentUnassign from './label-assignment-unassign.sql';
import assignmentLabelPage from './label-assignment-label-page.sql';
import assignmentSubjectPage from './label-assignment-subject-page.sql';
import entryTiles from './library-entry-tiles.sql';
import activeSessions from './shelf-active.sql';
import generationRead from './shelf-maintenance-gate-read.sql';

/** Public page and storage ceilings remain owned by the label contracts. */
export const LABEL_PAGE_DEFAULT = 20;
export const LABEL_PAGE_MAX = 100;
export const LABEL_SUBJECT_RESERVATIONS = 32;
export const LABEL_NAME_SCALARS = 100;

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
const work = (value: Partial<Bound>): Bound => declareBound({ ...zero(), ...value });
const bytes = (value: number): Bound => work({ bytes: value });
const uuid = 'f'.repeat(36);
const timestamp = '\u0000'.repeat(64);
const labelRow = Object.freeze({
  id: uuid,
  name: '\u{10ffff}'.repeat(LABEL_NAME_SCALARS),
  revision: 2_147_483_647,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp,
  purgeAfter: timestamp,
});
const labelCreateRow = Object.freeze({
  id: uuid,
  name: '\u{10ffff}'.repeat(LABEL_NAME_SCALARS),
  revision: 1,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
  purgeAfter: null,
});
const catalogueRow = Object.freeze({
  id: uuid,
  name: '\u{10ffff}'.repeat(LABEL_NAME_SCALARS),
  revision: 2_147_483_647,
  deletedAt: timestamp,
});
const assignmentRow = Object.freeze({
  route: 65_535,
  accountId: uuid,
  subjectId: uuid,
  labelId: uuid,
  id: uuid,
  revision: 2_147_483_647,
  slotNo: 31,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp,
  purgeAfter: timestamp,
  transactionId: uuid,
  identityMatches: false,
  started: false,
  expired: false,
});
const assignmentSetRow = Object.freeze({
  id: uuid,
  labelId: uuid,
  subjectId: uuid,
  revision: 2_147_483_647,
  slotNo: 31,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: null,
  purgeAfter: null,
});
const assignmentUnassignRow = Object.freeze({
  route: 65_535,
  accountId: uuid,
  subjectId: uuid,
  labelId: uuid,
  id: uuid,
  revision: 2_147_483_647,
  slotNo: null,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp,
  purgeAfter: timestamp,
  transactionId: uuid,
});
const assignmentPageRow = Object.freeze({
  id: uuid,
  labelId: uuid,
  subjectId: uuid,
  revision: 2_147_483_647,
  slotNo: 31,
  deletedAt: timestamp,
});
const reservationRow = Object.freeze({
  id: uuid,
  labelId: uuid,
  subjectId: uuid,
  revision: 2_147_483_647,
  slotNo: 31,
  createdAt: timestamp,
  updatedAt: timestamp,
  deletedAt: timestamp,
  purgeAfter: timestamp,
  desired: false,
});
const entryTileRow = Object.freeze({
  subjectId: uuid,
  state: 'x'.repeat(64),
  revision: 2_147_483_646,
  createdAt: timestamp,
  updatedAt: timestamp,
  incarnationId: uuid,
  lastActivityAt: timestamp,
  finishedAt: timestamp,
});
// Definition unit identifiers are 64 ASCII characters; profile decimals are 12+6 digits.
const numericText = `${'9'.repeat(12)}.${'9'.repeat(6)}`;
const activeSessionRow = Object.freeze({
  id: uuid,
  subjectId: uuid,
  versionSubjectId: uuid,
  mode: 'cursor_position',
  unit: 'x'.repeat(64),
  total: null,
  amount: null,
  locator: 'x'.repeat(256),
  position: numericText,
  completedUnitCount: 0,
  state: 'active',
  revision: 2_147_483_647,
  startedAt: timestamp,
  completedAt: null,
});

// Every operand and projection passed here is an internal JSON value; the assertion
// keeps TypeScript from widening JSON.stringify's result to undefined.
const encoded = (value: unknown) => Buffer.byteLength(JSON.stringify(value)!);
const projectionBytes = (row: object, count: number) => repeatBound(bytes(encoded(row) + 1), count);

function sqlBound<I>(
  sql: string,
  input: I,
  rows: Readonly<{
    candidateKeys: number;
    nativeRows: number;
    points: number;
    emptySeeks: number;
    witnesses?: number;
    output: object;
    outputRows: number;
  }>,
  extraBindBytes = 0,
): Bound {
  return sumBounds(
    work({
      candidateKeys: rows.candidateKeys,
      nativeRows: rows.nativeRows,
      nativePoints: rows.points,
      emptySeeks: rows.emptySeeks,
      witnessKeys: rows.witnesses ?? 0,
      statements: 1,
    }),
    bytes(Buffer.byteLength(sql) + encoded(input) + extraBindBytes),
    projectionBytes(rows.output, rows.outputRows),
    bytes(2),
  );
}

function uuidArrayBytes(count: number): number {
  // JSON.stringify serializes each UUID as 38 bytes and joins values with commas.
  return count === 0 ? 2 : 2 + count * 38 + count - 1;
}

function expandedString(value: string, width: number): number {
  return Math.max(0, Buffer.byteLength(JSON.stringify('\u0000'.repeat(width))) - encoded(value));
}

function immutable<T>(value: T): T {
  if (value !== null && typeof value === 'object') {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
function detached<T>(value: T): T {
  return immutable(JSON.parse(JSON.stringify(value)) as T);
}

export type LabelSqlPlan<I> = Readonly<{
  kind: string;
  sql: string;
  input: Readonly<I>;
  bound: Bound;
}>;

/** A detached SQL leaf. Bind JSON overbounds PostgreSQL text parameters and is the exact caller input. */
export function labelSqlPlan<I>(
  kind: string,
  sql: string,
  input: I,
  rows: Readonly<{
    candidateKeys: number;
    nativeRows: number;
    points: number;
    emptySeeks: number;
    witnesses?: number;
    output: object;
    outputRows: number;
  }>,
): LabelSqlPlan<I> {
  const frozen = detached(input);
  const bound = sqlBound(sql, frozen, rows);
  return Object.freeze({ kind, sql, input: frozen, bound });
}

/** Execute and consume the exact detached operands on the existing native request ledger. */
export function executeLabelSql<I, T>(plan: LabelSqlPlan<I>, run: (input: Readonly<I>) => Promise<T>): Promise<T> {
  if (activeLabelOperation.getStore() || enclosingLabelAttempt.getStore() || currentLibraryOperationAccounting())
    return run(plan.input);
  const association = currentCommandWorkAssociation();
  return association
    ? association.run(`library.${plan.kind}`, labelWorkDimensions(plan.bound), () => run(plan.input))
    : run(plan.input);
}

export type LabelOperationComponent = Readonly<{ kind: string; bound: Bound }>;
const activeLabelOperation = new AsyncLocalStorage<LabelOperationPlan>();
const enclosingLabelAttempt = new AsyncLocalStorage<Bound>();

export type LabelOperationPlan = Readonly<{
  kind: string;
  branch: string;
  input: Readonly<Record<string, unknown>>;
  leaves: readonly LabelSqlPlan<unknown>[];
  components: readonly LabelOperationComponent[];
  /** False when the outer native command or an owner-owned disclosure remains to be composed. */
  complete: boolean;
  total: Bound;
}>;

function operation(
  kind: string,
  branch: string,
  input: Record<string, unknown>,
  leaves: readonly LabelSqlPlan<unknown>[],
  extra: readonly LabelOperationComponent[] = [],
  complete = false,
): LabelOperationPlan {
  const frozen = detached(input);
  const components = [...leaves.map((leaf) => Object.freeze({ kind: leaf.kind, bound: leaf.bound })), ...extra];
  const total = sumBounds(...components.map((component) => component.bound));
  return Object.freeze({
    kind,
    branch,
    input: frozen,
    leaves: Object.freeze([...leaves]),
    components: Object.freeze(components),
    complete,
    total,
  });
}

function component(kind: string, bound: Bound): LabelOperationComponent {
  return Object.freeze({ kind, bound });
}

function alternative(...branches: readonly Bound[]): Bound {
  const values = branches.length ? branches : [zero()];
  return declareBound(
    Object.fromEntries(BOUND_AXES.map((axis) => [axis, Math.max(...values.map((value) => value[axis]))])),
  );
}

function controlSql(sql: string): Bound {
  return work({ statements: 1, bytes: Buffer.byteLength(sql) });
}

/** Name a bound supplied by the owner that executes the corresponding branch. */
export function labelOperationComponent(kind: string, bound: Bound): LabelOperationComponent {
  return component(kind, declareBound(bound));
}

/** Compose owner declarations without changing the operation's immutable SQL operands. */
export function composeLabelOperation(
  base: LabelOperationPlan,
  owners: readonly LabelOperationComponent[],
  complete: boolean,
): LabelOperationPlan {
  const components = Object.freeze([...base.components, ...owners]);
  return Object.freeze({
    ...base,
    components,
    complete,
    total: sumBounds(...components.map((item) => item.bound)),
  });
}

/** One native command attempt: preparation, authorization, receipt, body, fence, rollback and serialization.
 * Deadline-scoped retries are counted in request evidence; they are not a finite request envelope.
 */
export function labelCommandAttemptComponent(
  kind: string,
  input: unknown,
  response: object,
  receiptKeys = 1,
): LabelOperationComponent {
  const receipt = {
    principal: { kind: 'account', id: uuid },
    kind,
    key: 'rk1.255.' + 'f'.repeat(43),
    digest: 'f'.repeat(64),
    response,
  };
  const accountInput = { route: 65_535, account_id: uuid };
  const share = sqlBound(accountShare.sql, accountInput, {
    candidateKeys: 1,
    nativeRows: 1,
    points: 1,
    emptySeeks: 1,
    output: { state: 'deleted', fenced: true },
    outputRows: 1,
  });
  const account = sqlBound(accountCommandState.sql, accountInput, {
    candidateKeys: 1,
    nativeRows: 1,
    points: 1,
    emptySeeks: 1,
    output: { kind: 'organization', state: 'deleted', fenced: true, minimumAuthnEpoch: '-9223372036854775808' },
    outputRows: 1,
  });
  const time = sqlBound(
    timeRead.sql,
    { at: timestamp },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 0, output: { value: timestamp }, outputRows: 1 },
  );
  const keys = Array.from({ length: Math.max(1, receiptKeys) }, () => receipt.key);
  const receiptBound = sqlBound(
    receiptRead.sql,
    {
      partition_no: 4095,
      principal_kind: 'account',
      principal_id: uuid,
      command_kind: kind,
      idempotency_keys: keys,
    },
    {
      candidateKeys: keys.length,
      nativeRows: 1,
      points: keys.length,
      emptySeeks: keys.length,
      output: {
        requestDigest: 'f'.repeat(64),
        epoch: 2_147_483_647,
        position: '-9223372036854775808',
        transactionId: uuid,
        response: null,
        payloadState: 'retained',
      },
      outputRows: 1,
    },
  );
  const event = {
    type: 'com.rezics.library.label.changed.v1',
    subject: uuid,
    id: uuid,
    data: { labelId: uuid },
  };
  const fenceBound = sqlBound(
    eventFence.sql,
    {
      partition_no: 4095,
      transaction_id: uuid,
      receipt,
      basis: { principal: { kind: 'account', id: uuid }, clientId: uuid, requestedBy: uuid },
      events: [event],
    },
    {
      candidateKeys: 18,
      nativeRows: 18,
      points: 18,
      emptySeeks: 1,
      output: { epoch: 2_147_483_647, position: '-9223372036854775808' },
      outputRows: 1,
    },
  );
  const noEffect = sqlBound(
    noEffectFence.sql,
    { partition_no: 4095, transaction_id: uuid, receipt },
    {
      candidateKeys: 5,
      nativeRows: 5,
      points: 4,
      emptySeeks: 1,
      output: { epoch: 2_147_483_647, position: '-9223372036854775808' },
      outputRows: 1,
    },
  );
  const partition = sqlBound(
    partitionRead.sql,
    { partition_no: 4095 },
    {
      candidateKeys: 1,
      nativeRows: 1,
      points: 1,
      emptySeeks: 1,
      output: {
        partitionNo: 4095,
        node: '',
        writeState: 'draining',
        movedTo: '',
        epoch: 2_147_483_647,
        position: '-9223372036854775808',
      },
      outputRows: 1,
    },
  );
  const transaction = sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL SERIALIZABLE',
      "SET LOCAL lock_timeout = '200ms'",
      "SET LOCAL statement_timeout = '5000ms'",
      "SET LOCAL statement_timeout = '5000ms'",
    ].map(controlSql),
  );
  const readOnly = sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      "SET LOCAL statement_timeout = '200ms'",
      'COMMIT',
      'ROLLBACK',
    ].map(controlSql),
  );
  const terminal = alternative(controlSql('COMMIT'), sumBounds(controlSql('ROLLBACK'), partition));
  const responseBytes = encoded(response);
  return component(
    'command.attempt',
    sumBounds(
      transaction,
      readOnly,
      time,
      share,
      account,
      receiptBound,
      alternative(sumBounds(fenceBound, bytes(responseBytes)), noEffect),
      terminal,
      bytes(encoded(input) + 2 * responseBytes),
    ),
  );
}

/** Read-snapshot owner work around a page's native storage leaves. */
export function labelSnapshotComponent(kind: string, input: unknown, responseBytes: number): LabelOperationComponent {
  const accountInput = { route: 65_535, account_id: uuid };
  return component(
    kind,
    sumBounds(
      controlSql('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY'),
      controlSql('COMMIT'),
      controlSql('ROLLBACK'),
      sqlBound(accountCommandState.sql, accountInput, {
        candidateKeys: 1,
        nativeRows: 1,
        points: 1,
        emptySeeks: 1,
        output: { kind: 'organization', state: 'deleted', fenced: true, minimumAuthnEpoch: '-9223372036854775808' },
        outputRows: 1,
      }),
      sqlBound(
        partitionRead.sql,
        { partition_no: 4095 },
        {
          candidateKeys: 1,
          nativeRows: 1,
          points: 1,
          emptySeeks: 1,
          output: {
            partitionNo: 4095,
            node: '',
            writeState: 'active',
            movedTo: '',
            epoch: 2_147_483_647,
            position: '-9223372036854775808',
          },
          outputRows: 1,
        },
      ),
      bytes(encoded(input) + responseBytes),
    ),
  );
}

/** Inline owner queries that already execute on the operation's native client. */
export function labelOwnerSqlComponent(
  kind: string,
  input: unknown,
  output: object,
  statements: number,
  rows: number,
): LabelOperationComponent {
  return component(
    kind,
    work({
      candidateKeys: rows,
      nativeRows: rows,
      emptySeeks: rows,
      nativePoints: rows,
      statements,
      bytes: encoded(input) + encoded(output) + statements * 1024,
    }),
  );
}

/** Bounded Semantic summary/observation producer for at most `count` displayed Subjects. */
export function labelSummaryObservationBound(count: number): Bound {
  const n = Math.max(0, count);
  if (n === 0) return zero();
  const subjects = Array.from({ length: n }, () => uuid);
  const reference = sqlBound(
    subjectReference.sql,
    { route: 65_535, subject_id: uuid },
    {
      candidateKeys: 1,
      nativeRows: 1,
      points: 1,
      emptySeeks: 1,
      output: { id: uuid, redirect: uuid },
      outputRows: 1,
    },
  );
  const mappingInput = subjects;
  const owners = sqlBound(
    mappingOwners.sql,
    mappingInput,
    {
      candidateKeys: n,
      nativeRows: 4 * n,
      points: n,
      emptySeeks: n,
      output: { partition_no: 4095, terminal: uuid },
      outputRows: n,
    },
    encoded(mappingInput) - encoded([]),
  );
  const sources = sqlBound(
    mappingSources.sql,
    mappingInput,
    {
      candidateKeys: n,
      nativeRows: 8 * n,
      points: n,
      emptySeeks: n,
      output: { partition_no: 4095, terminal: uuid, source_revision: '-9223372036854775808' },
      outputRows: n,
    },
    encoded(mappingInput) - encoded([]),
  );
  const pending = sqlBound(
    mappingPending.sql,
    mappingInput,
    {
      candidateKeys: n,
      nativeRows: 4 * n,
      points: n,
      emptySeeks: n,
      output: { partition_no: 4095, terminal: uuid, pending_job: uuid, pending_epoch: '-9223372036854775808' },
      outputRows: n,
    },
    encoded(mappingInput) - encoded([]),
  );
  const current = sqlBound(
    mappingCurrent.sql,
    mappingInput,
    {
      candidateKeys: n,
      nativeRows: 16 * n,
      points: 4 * n,
      emptySeeks: 4 * n,
      output: { partition_no: 4095, terminal: uuid, redirected: true },
      outputRows: n,
    },
    encoded(mappingInput) - encoded([]),
  );
  const selected = 12 * n;
  const representatives = sqlBound(
    representativesRead.sql,
    { partition_no: 4095, subjects: subjects.map((id) => ({ route: 65_535, id })) },
    {
      candidateKeys: selected,
      nativeRows: (1 + 5 * 12) * n,
      points: n,
      emptySeeks: n,
      output: { id: uuid, slot_id: uuid, ordinal: 12 },
      outputRows: selected,
    },
  );
  const slots = 2 * n + selected;
  const candidates = 32 * slots;
  const fallback = n;
  const labels = 65 * n + fallback;
  const summaries = sqlBound(
    summariesRead.sql,
    {
      partition_no: 4095,
      context_id: uuid,
      subjects: subjects.map((id) => ({ route: 65_535, id, image: uuid, original: uuid })),
      representatives: subjects.map((id) => ({ id, slot_id: uuid })),
      label_languages: ['en'],
      display_fallback: true,
    },
    {
      candidateKeys: n + candidates + labels + fallback,
      nativeRows: 5 * n + 6 * labels + 9 * slots + 12 * candidates + 3 * fallback,
      points: n + labels + 3 * slots + 5 * candidates + fallback,
      emptySeeks: n + labels + 3 * slots + 5 * candidates + fallback,
      output: { id: uuid, type: '', labels: {}, original: '', choices: [] },
      outputRows: n,
    },
    6 * RELEASE_LIMITS.bytes,
  );
  const covers = sqlBound(
    coverReferences.sql,
    { partition: 4095, routes: Array.from({ length: n }, () => 65_535), media_ids: subjects },
    {
      candidateKeys: 13 * n,
      nativeRows: 23 * n,
      points: 2 * n,
      emptySeeks: 2 * n,
      output: { mediaId: uuid, width: 2560, height: 2560 },
      outputRows: n,
    },
  );
  const fences = sqlBound(
    sourceFences.sql,
    {
      partition: 4095,
      tuples: subjects.map((id) => ({ route: 65_535, source: id, external_id: id, field_group: 'image' })),
    },
    {
      candidateKeys: n,
      nativeRows: 5 * n,
      points: n,
      emptySeeks: n,
      output: { route: 65_535, source: '', takenDown: false },
      outputRows: n,
    },
  );
  return sumBounds(
    repeatBound(reference, 4 * n),
    owners,
    sources,
    pending,
    current,
    representatives,
    summaries,
    covers,
    fences,
  );
}

/** Keep one attempt declaration across Core retries so nested SQL does not reserve again. */
export function withLabelCommandAttempt<T>(total: Bound | undefined, dispatch: () => Promise<T>): Promise<T> {
  if (!total || enclosingLabelAttempt.getStore()) return dispatch();
  return enclosingLabelAttempt.run(total, dispatch);
}

/** Charge one complete attempt at native prepare. Reached retries are counted separately in request evidence. */
export function consumeLabelCommandAttempt(plan: Readonly<{ operation: string; total: Bound }>): Promise<void> {
  if (currentLibraryOperationAccounting()) return Promise.resolve();
  const association = currentCommandWorkAssociation();
  return association
    ? association.run(plan.operation, labelWorkDimensions(plan.total), async () => undefined)
    : Promise.resolve();
}

/** Reserve one closed operation once, then execute its leaves on the caller's existing native resources. */
export async function executeLabelOperation<T>(plan: LabelOperationPlan, body: () => Promise<T>): Promise<T> {
  if (activeLabelOperation.getStore() || enclosingLabelAttempt.getStore() || currentLibraryOperationAccounting())
    return activeLabelOperation.getStore() ? body() : activeLabelOperation.run(plan, body);
  const association = currentCommandWorkAssociation();
  const reservation = association?.reserve(`library.${plan.kind}.${plan.branch}`, labelWorkDimensions(plan.total));
  let settled = false;
  const settle = () => {
    if (settled) return;
    settled = true;
    reservation?.settle();
  };
  try {
    const result = await activeLabelOperation.run(plan, body);
    settle();
    return result;
  } catch (error) {
    settle();
    throw error;
  }
}

const parentInput = (route: number, accountId: string, labelId: string) =>
  Object.freeze({ route, account_id: accountId, label_id: labelId });
const labelPoint = (route: number, accountId: string, labelId: string, includeDeleted = false) =>
  labelSqlPlan(
    'label.point',
    labelRead.sql,
    { ...parentInput(route, accountId, labelId), include_deleted: includeDeleted },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: labelRow, outputRows: 1 },
  );

export function labelCreatePlan(input: {
  route: number;
  accountId: string;
  labelId: string;
  name: string;
  transactionId: string;
  time: string;
}): LabelOperationPlan {
  const leaf = labelSqlPlan(
    'label.create',
    labelInsert.sql,
    {
      route: input.route,
      account_id: input.accountId,
      label_id: input.labelId,
      name: input.name,
      transaction_id: input.transactionId,
      time: input.time,
    },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 0, output: labelCreateRow, outputRows: 1 },
  );
  return operation('label.create', 'fresh', input, [leaf]);
}

export function labelRenamePlan(input: {
  route: number;
  accountId: string;
  labelId: string;
  name: string;
  revision: number;
  transactionId: string;
  time: string;
  unchanged?: boolean;
  includeRead?: boolean;
}): LabelOperationPlan {
  const read = labelPoint(input.route, input.accountId, input.labelId);
  const rename = labelSqlPlan(
    'label.rename',
    labelRename.sql,
    {
      route: input.route,
      account_id: input.accountId,
      label_id: input.labelId,
      name: input.name,
      revision: input.revision,
      transaction_id: input.transactionId,
      time: input.time,
    },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: labelRow, outputRows: 1 },
  );
  return operation(
    'label.rename',
    input.unchanged ? 'no-change' : input.unchanged === false ? 'changed' : 'changed-or-no-change',
    input,
    input.unchanged ? (input.includeRead ? [read] : []) : [...(input.includeRead ? [read] : []), rename],
  );
}

export function labelLifecyclePlan(input: {
  route: number;
  accountId: string;
  labelId: string;
  revision: number;
  transactionId: string;
  time: string;
  restore: boolean;
  includeRead?: boolean;
}): LabelOperationPlan {
  const read = labelPoint(input.route, input.accountId, input.labelId, true);
  const lifecycle = labelSqlPlan(
    input.restore ? 'label.restore' : 'label.delete',
    labelLifecycle.sql,
    {
      route: input.route,
      account_id: input.accountId,
      label_id: input.labelId,
      revision: input.revision,
      transaction_id: input.transactionId,
      time: input.time,
      restore: input.restore,
    },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: labelRow, outputRows: 1 },
  );
  return operation(input.restore ? 'label.restore' : 'label.delete', input.restore ? 'restore' : 'delete', input, [
    ...(input.includeRead ? [read] : []),
    lifecycle,
  ]);
}

export function labelCataloguePlan(input: {
  route: number;
  accountId: string;
  prefix?: string;
  upper?: string | null;
  afterName?: string;
  afterLabelId: string;
  limit: number;
}): LabelOperationPlan {
  const params =
    input.prefix === undefined
      ? { route: input.route, account_id: input.accountId, after_label_id: input.afterLabelId, limit: input.limit }
      : {
          route: input.route,
          account_id: input.accountId,
          prefix: input.prefix,
          upper: input.upper ?? null,
          after_name: input.afterName ?? input.prefix,
          after_label_id: input.afterLabelId,
          limit: input.limit,
        };
  const sql = input.prefix === undefined ? cataloguePage : cataloguePrefix;
  const leaf = labelSqlPlan(
    input.prefix === undefined ? 'label.catalogue.page' : 'label.catalogue.prefix',
    sql.sql,
    params,
    {
      candidateKeys: input.limit,
      nativeRows: input.limit,
      points: 1,
      emptySeeks: 1,
      output: catalogueRow,
      outputRows: input.limit,
    },
  );
  const continuation =
    input.prefix !== undefined && input.afterLabelId !== '00000000-0000-0000-0000-000000000000'
      ? [
          component(
            'label.catalogue.continuation-name',
            labelPoint(input.route, input.accountId, input.afterLabelId).bound,
          ),
        ]
      : [];
  return operation(
    'label.catalogue',
    input.prefix === undefined ? 'page' : input.afterName ? 'next-prefix' : 'prefix',
    input,
    [leaf],
    continuation,
  );
}

export function labelEntryTilesPlan(input: { route: number; accountId: string; subjectIds: readonly string[] }) {
  const params = { route: input.route, account_id: input.accountId, subject_ids: [...input.subjectIds] };
  return labelSqlPlan('assignment.full.entry-tiles', entryTiles.sql, params, {
    candidateKeys: params.subject_ids.length,
    nativeRows: params.subject_ids.length,
    points: params.subject_ids.length,
    emptySeeks: params.subject_ids.length,
    output: entryTileRow,
    outputRows: params.subject_ids.length,
  });
}

export function labelActiveSessionsPlan(input: { route: number; accountId: string; subjectIds: readonly string[] }) {
  const params = { route: input.route, account_id: input.accountId, subject_ids: [...input.subjectIds] };
  return labelSqlPlan('assignment.full.active-sessions', activeSessions.sql, params, {
    candidateKeys: params.subject_ids.length,
    nativeRows: params.subject_ids.length,
    points: params.subject_ids.length,
    emptySeeks: params.subject_ids.length,
    output: activeSessionRow,
    outputRows: params.subject_ids.length,
  });
}

export function labelAssignmentSetPlan(input: {
  route: number;
  accountId: string;
  subjectId: string;
  labelId: string;
  expectedSource?: { labelId: string; assignmentId: string; revision: number; labelRevision: number };
  restore?: boolean;
  time: string;
  transactionId: string;
}): LabelOperationPlan {
  const tuple = {
    route: input.route,
    account_id: input.accountId,
    subject_id: input.subjectId,
    label_id: input.labelId,
  };
  const guard = labelSqlPlan(
    'assignment.guard',
    assignmentGuard.sql,
    { ...tuple },
    { candidateKeys: 0, nativeRows: 0, points: 0, emptySeeks: 0, output: { labelId: uuid }, outputRows: 1 },
  );
  const reservations = labelSqlPlan('assignment.reservations', assignmentReservations.sql, tuple, {
    candidateKeys: LABEL_SUBJECT_RESERVATIONS + 1,
    nativeRows: LABEL_SUBJECT_RESERVATIONS + 1,
    points: 2,
    emptySeeks: 2,
    output: reservationRow,
    outputRows: LABEL_SUBJECT_RESERVATIONS + 1,
  });
  const parentIds = LABEL_SUBJECT_RESERVATIONS + 2;
  const parentBase = { route: input.route, account_id: input.accountId, label_ids: [] as string[] };
  const parentShape = {
    candidateKeys: parentIds,
    nativeRows: parentIds,
    points: parentIds,
    emptySeeks: parentIds,
    output: { labelId: uuid, revision: 2_147_483_647, deletedAt: timestamp, purgeAfter: timestamp },
    outputRows: parentIds,
  };
  const parentReads = component(
    'assignment.parents',
    sqlBound(assignmentParents.sql, parentBase, parentShape, uuidArrayBytes(parentIds) - encoded(parentBase.label_ids)),
  );
  const source = input.expectedSource
    ? labelSqlPlan(
        'assignment.expected-source',
        `SELECT assignment_id AS "assignmentId",revision,slot_no AS "slotNo",deleted_at::text AS "deletedAt"
       FROM library.label_assignment WHERE route=$1 AND account_id=$2 AND subject_id=$3 AND label_id=$4`,
        [input.route, input.accountId, input.subjectId, input.expectedSource.labelId] as const,
        {
          candidateKeys: 1,
          nativeRows: 1,
          points: 1,
          emptySeeks: 1,
          output: { assignmentId: uuid, revision: 2_147_483_647, slotNo: 31, deletedAt: timestamp },
          outputRows: 1,
        },
      )
    : undefined;
  // At the point of reservation the retained victim is not known. Reserve its
  // largest schema-valid tuple before the first native read; dispatch remains
  // conditional on the actual admission branch.
  const reclaim = component(
    'assignment.reclaim',
    sqlBound(
      assignmentReclaim.sql,
      {
        ...tuple,
        assignment_id: '',
        revision: 0,
        slot_no: 31,
        deleted_at: '',
        purge_after: '',
        time: input.time,
        transaction_id: input.transactionId,
      },
      { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: { assignment_id: uuid }, outputRows: 1 },
      expandedString('', 36) + expandedString('', 64) * 2 + encoded(2_147_483_647) - encoded(0),
    ),
  );
  const set = component(
    'assignment.set',
    sqlBound(
      assignmentSet.sql,
      {
        ...tuple,
        retained: false,
        assignment_id: '',
        revision: 0,
        deleted_at: '',
        purge_after: '',
        slot_no: 31,
        time: input.time,
        transaction_id: input.transactionId,
      },
      { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: assignmentSetRow, outputRows: 1 },
      expandedString('', 36) + expandedString('', 64) * 2 + encoded(2_147_483_647) - encoded(0),
    ),
  );
  return operation(
    'assignment.set',
    input.restore ? 'restore' : 'assign',
    input,
    [guard, reservations, ...(source ? [source] : [])],
    [parentReads, reclaim, set],
  );
}

export function labelAssignmentLifecyclePlan(input: {
  route: number;
  accountId: string;
  subjectId: string;
  labelId: string;
  assignmentId: string;
  revision: number;
  time: string;
  transactionId?: string;
  expectedLabelRevision?: number;
  expectedTarget?: { labelId: string; assignmentId: string; revision: number; labelRevision: number };
  restore?: boolean;
}): LabelOperationPlan {
  const tuple = {
    route: input.route,
    account_id: input.accountId,
    subject_id: input.subjectId,
    label_id: input.labelId,
  };
  const guard = labelSqlPlan('assignment.guard', assignmentGuard.sql, tuple, {
    candidateKeys: 0,
    nativeRows: 0,
    points: 0,
    emptySeeks: 0,
    output: { labelId: uuid },
    outputRows: 1,
  });
  const current = labelSqlPlan(
    'assignment.current',
    assignmentRead.sql,
    { ...tuple, assignment_id: input.assignmentId, time: input.time },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: assignmentRow, outputRows: 1 },
  );
  const leaves: LabelSqlPlan<unknown>[] = [guard, current];
  if (input.expectedLabelRevision !== undefined) {
    leaves.push(
      labelSqlPlan(
        'assignment.expected-label',
        `SELECT revision FROM library.personal_label
       WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`,
        [input.route, input.accountId, input.labelId] as const,
        {
          candidateKeys: 1,
          nativeRows: 1,
          points: 1,
          emptySeeks: 1,
          output: { revision: 2_147_483_647 },
          outputRows: 1,
        },
      ),
    );
  }
  if (input.expectedTarget) {
    leaves.push(
      labelSqlPlan(
        'assignment.expected-target-parent',
        `SELECT revision FROM library.personal_label
       WHERE route=$1 AND account_id=$2 AND label_id=$3 AND deleted_at IS NULL FOR SHARE`,
        [input.route, input.accountId, input.expectedTarget.labelId] as const,
        {
          candidateKeys: 1,
          nativeRows: 1,
          points: 1,
          emptySeeks: 1,
          output: { revision: 2_147_483_647 },
          outputRows: 1,
        },
      ),
    );
    leaves.push(
      labelSqlPlan(
        'assignment.expected-target',
        assignmentRead.sql,
        { ...tuple, label_id: input.expectedTarget.labelId, assignment_id: null, time: null },
        { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: assignmentRow, outputRows: 1 },
      ),
    );
  }
  if (input.restore) {
    const set = labelAssignmentSetPlan({ ...input, restore: true, transactionId: input.transactionId ?? uuid });
    return operation(
      'assignment.restore',
      'exact-retained-restore',
      input,
      leaves,
      set.components.map((value) => component(`restore.${value.kind}`, value.bound)),
    );
  }
  const unassign = labelSqlPlan(
    'assignment.unassign',
    assignmentUnassign.sql,
    {
      ...tuple,
      assignment_id: input.assignmentId,
      revision: input.revision,
      time: input.time,
      transaction_id: input.transactionId ?? uuid,
    },
    { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: assignmentUnassignRow, outputRows: 1 },
  );
  return operation('assignment.unassign', input.expectedTarget ? 'exact-target' : 'exact', input, [
    ...leaves,
    unassign,
  ]);
}

export function labelAssignmentPagePlan(input: {
  route: number;
  accountId: string;
  labelId?: string;
  subjectId?: string;
  after?: string;
  limit: number;
  view: 'BASIC' | 'FULL';
}): LabelOperationPlan {
  const byLabel = input.labelId !== undefined;
  const pageInput = byLabel
    ? {
        route: input.route,
        account_id: input.accountId,
        label_id: input.labelId,
        after_subject_id: input.after ?? '00000000-0000-0000-0000-000000000000',
        limit: input.limit,
      }
    : { route: input.route, account_id: input.accountId, subject_id: input.subjectId! };
  const page = labelSqlPlan(
    byLabel ? 'assignment.page.label' : 'assignment.page.subject',
    byLabel ? assignmentLabelPage.sql : assignmentSubjectPage.sql,
    pageInput,
    {
      candidateKeys: byLabel ? input.limit : LABEL_SUBJECT_RESERVATIONS,
      nativeRows: byLabel ? input.limit : LABEL_SUBJECT_RESERVATIONS,
      points: byLabel ? 1 : 1,
      emptySeeks: 1,
      output: byLabel
        ? assignmentPageRow
        : { id: uuid, labelId: uuid, subjectId: uuid, revision: 2_147_483_647, slotNo: 31 },
      outputRows: byLabel ? input.limit : LABEL_SUBJECT_RESERVATIONS,
    },
  );
  const leaves: LabelSqlPlan<unknown>[] = [page];
  const extras: LabelOperationComponent[] = [];
  if (!byLabel) {
    const parentReads = LABEL_SUBJECT_RESERVATIONS;
    const base = { route: input.route, account_id: input.accountId, label_id: '' };
    const parent = sqlBound(
      labelRead.sql,
      base,
      { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1, output: labelRow, outputRows: 1 },
      uuid.length - encoded(base.label_id),
    );
    extras.push(component('assignment.current-parents', repeatBound(parent, parentReads)));
  }
  if (input.view === 'FULL' && byLabel) {
    const subjects = Array.from({ length: input.limit }, () => uuid);
    const tileInput = { route: input.route, account_id: input.accountId, subject_ids: [] as string[] };
    const tileShape = {
      candidateKeys: input.limit,
      nativeRows: input.limit,
      points: input.limit,
      emptySeeks: input.limit,
      output: entryTileRow,
      outputRows: input.limit,
    };
    extras.push(
      component(
        'assignment.full.entry-tiles',
        sqlBound(entryTiles.sql, tileInput, tileShape, encoded(subjects) - encoded(tileInput.subject_ids)),
      ),
    );
    const sessionInput = { route: input.route, account_id: input.accountId, subject_ids: [] as string[] };
    extras.push(
      component(
        'assignment.full.active-sessions',
        sqlBound(
          activeSessions.sql,
          sessionInput,
          {
            candidateKeys: input.limit,
            nativeRows: input.limit,
            points: input.limit,
            emptySeeks: input.limit,
            output: activeSessionRow,
            outputRows: input.limit,
          },
          encoded(subjects) - encoded(sessionInput.subject_ids),
        ),
      ),
    );
    extras.push(
      component(
        'assignment.full.generation',
        sqlBound(
          generationRead.sql,
          { route: input.route, account_id: input.accountId },
          {
            candidateKeys: 1,
            nativeRows: 1,
            points: 1,
            emptySeeks: 1,
            output: {
              initialized: true,
              mode: 'rebuilding',
              ready: false,
              epoch: '9223372036854775807',
              activeGeneration: uuid,
              runId: uuid,
            },
            outputRows: 1,
          },
        ),
      ),
    );
    extras.push(component('assignment.full.summary-observation', labelSummaryObservationBound(input.limit)));
  }
  return operation(
    'assignment.page',
    `${input.view.toLowerCase()}-${byLabel ? 'label' : 'subject'}`,
    input,
    leaves,
    extras,
  );
}

/** Explicit bridge into the existing eight-axis Source reservation. Search is not called by these SQL leaves. */
export function labelWorkDimensions(bound: Bound): WorkDimensions {
  const complete = declareBound(bound);
  if (complete.engineRequests !== 0)
    throw new TypeError('Label Source work cannot omit a nonzero engine request declaration');
  return Object.freeze({
    candidateKeys: complete.candidateKeys,
    nativeRows: complete.nativeRows,
    identityMetadataRows: complete.identityMetadataRows,
    emptySeeks: complete.emptySeeks,
    nativePoints: complete.nativePoints,
    witnessKeys: complete.witnessKeys,
    statements: complete.statements,
    bytes: complete.bytes,
  });
}

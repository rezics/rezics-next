import { memoizedValue } from '../memoized.ts';
import { statementBytes } from '../database/statement-bytes.ts';
import { jsonParameter } from '../database/json.ts';
import { AsyncLocalStorage } from 'node:async_hooks';
import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import type { PoolClient } from 'pg';
import { currentCommandWorkAssociation } from '../command/work-context.ts';
import readReceipt from '../command/read-receipt.sql';
import eventFence from '../command/fence.sql';
import timeRead from '../command/time.sql';
import { nativeCopyAccountWork } from './access-port.ts';
import { partitionOf } from '../route/route.ts';
import {
  sessionPartitionWork,
  sessionProfileMigrationWork,
  sessionReadTimeWork,
  sessionReleaseWork,
  sessionShelfWork,
  sessionSourceWork,
} from './session-operation-bounds.ts';
import type { WorkDimensions } from './contract/work-dimensions.ts';
import copyDelete from './entry-store-copy-delete.sql';
import copyInsert from './entry-store-copy-insert.sql';
import copyPage from './entry-store-copy-page.sql';
import copySubjectPage from './entry-store-copy-subject-page.sql';
import copyKindPage from './copies-kind-page.sql';
import copyStatusPage from './copies-status-page.sql';
import copyKindStatusPage from './copies-kind-status-page.sql';
import copySubjectKindPage from './copies-subject-kind-page.sql';
import copySubjectStatusPage from './copies-subject-status-page.sql';
import copySubjectKindStatusPage from './copies-subject-kind-status-page.sql';
import copyRead from './entry-store-copy-read.sql';
import copyUpdate from './entry-store-copy-update.sql';
import copyInventoryOptions from './copy-inventory-options.sql';
import copyDetailRead from './copy-store-read.sql';
import copyRetentionRead from './copy-retention-read.sql';
import copyRetentionRestore from './copy-retention-restore.sql';
import { MAX_LIBRARY_PAGE_SIZE } from './entry-model.ts';
import {
  COPY_CONDITION_CHOICES,
  MAX_COPY_FILTER_OPTIONS,
  COPY_FILTER_OPTION_QUERY_LIMIT,
  MAX_COPY_FILTER_OPTIONS_BYTES,
} from './contract/index.ts';

import type {
  CopyOperationComponent,
  CopyOperationPlan,
  CopyMutationOperation,
  CopyMutationOperationInput,
  CopyInventoryOperationInput,
} from './contract/index.ts';
import {
  maximumCopyBound,
  copyMutationPlan,
  copyAccountPlan,
  copyReadPlan,
  copyPresentationPlan,
  copyInventoryPlan,
} from './core/index.ts';
export {
  MAX_COPY_FILTER_OPTIONS,
  COPY_FILTER_OPTION_QUERY_LIMIT,
  MAX_COPY_FILTER_OPTIONS_BYTES,
} from './contract/index.ts';
export type {
  CopyOperationComponent,
  CopyOperationPlan,
  CopyMutationOperation,
  CopyMutationOperationInput,
  CopyInventoryOperationInput,
} from './contract/index.ts';

type CopyQueryClient = Pick<PoolClient, 'query'>;
type QueryModule<Client, Input extends object, Result> = Readonly<{
  sql: string;
  run(client: Client, input: Input): Promise<Result>;
}>;

export type CopyStatementPlan<Client, Input extends object, Result> = Readonly<{
  kind: string;
  input: Readonly<Input>;
  bound: Bound;
  run(client: Client): Promise<Result>;
}>;

type WorkShape = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  projectionRows?: number;
  identityMetadataRows?: number;
  emptySeeks: number;
  nativePoints: number;
  witnessKeys?: number;
}>;

const UUID = 'ffffffff-ffff-ffff-ffff-ffffffffffff';
const ID64 = '\0'.repeat(64);
const PIN = {
  provenance: 'profile',
  releaseDigest: `sha256:${'f'.repeat(64)}`,
  acceptingType: 'x',
  profileId: 'x',
};
const CONDITION = { value: 'very_good_plus', pin: PIN, kindId: ID64 };

function projectedBytes(projection: unknown, releaseIdentifiers: number): number {
  const serialized = Buffer.byteLength(JSON.stringify(projection));
  // A pinned Type/Profile ID comes from one validated immutable release. Its
  // release byte ceiling bounds the ID; JSON can escape each code unit to six
  // bytes. The one-character placeholders above make the delta deterministic.
  return serialized + releaseIdentifiers * (6 * RELEASE_LIMITS.bytes - 1);
}

// PostgreSQL schema and the existing HTTP parser bound these fields. JSON string
// escaping is charged at its six-byte-per-character maximum.
const COPY_PAGE_ROW = {
  route: -32768,
  id: UUID,
  accountId: UUID,
  subjectId: UUID,
  kind: ID64,
  libraryProfilePin: PIN,
  status: ID64,
  location: '\0'.repeat(200),
  source: '\0'.repeat(200),
  acquiredOn: '\0'.repeat(64),
  disposedOn: '\0'.repeat(64),
  note: '\0'.repeat(1000),
  revision: -2147483648,
  createdAt: '\0'.repeat(64),
  updatedAt: '\0'.repeat(64),
  transactionId: UUID,
};
const COPY_STORE_ROW = {
  id: UUID,
  accountId: UUID,
  subjectId: UUID,
  kind: ID64,
  status: ID64,
  location: '\0'.repeat(200),
  source: '\0'.repeat(200),
  acquiredOn: '\0'.repeat(64),
  disposedOn: '\0'.repeat(64),
  note: '\0'.repeat(1000),
  revision: -2147483648,
  createdAt: '\0'.repeat(64),
  updatedAt: '\0'.repeat(64),
  transactionId: UUID,
  libraryProfilePin: PIN,
  mediaCondition: CONDITION,
  packagingCondition: CONDITION,
};
const COPY_DETAIL_ROW = {
  ...COPY_STORE_ROW,
  kindProfilePin: PIN,
  statusProfilePin: PIN,
};
const COPY_RETENTION_ROW = {
  ...COPY_PAGE_ROW,
  deletionId: UUID,
  deletedAt: '\0'.repeat(64),
  restoreUntil: '\0'.repeat(64),
  expired: true,
};
const INVENTORY_OPTION_ROW = {
  dimension: 'status',
  id: ID64,
  copyId: UUID,
  copyKind: ID64,
  profilePin: PIN,
};

function bytes(value: number): Bound {
  return declareBound({
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
}

function completeWork(shape: WorkShape): Bound {
  return declareBound({
    candidateKeys: shape.candidateKeys,
    nativeRows: shape.nativeRows,
    identityMetadataRows: shape.identityMetadataRows ?? 0,
    emptySeeks: shape.emptySeeks,
    nativePoints: shape.nativePoints,
    witnessKeys: shape.witnessKeys ?? 0,
    statements: 1,
    bytes: 0,
    engineRequests: 0,
  });
}

const activeCopyOperation = new AsyncLocalStorage<CopyOperationPlan>();

function freezeDeep<T>(value: T): T {
  if (value === null || typeof value !== 'object' || Object.isFrozen(value)) return value;
  for (const child of Object.values(value)) freezeDeep(child);
  return Object.freeze(value);
}

/** The existing native receipt is eight axes; Copy proves the ninth axis is zero. */
export function copyWorkDimensions(bound: Bound): WorkDimensions {
  const complete = declareBound(bound);
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

/** Consume a complete command attempt before its existing preparation and transaction. */
export function consumeCopyCommandAttempt(plan: CopyOperationPlan): Promise<void> {
  const association = currentCommandWorkAssociation();
  if (!association) return Promise.resolve();
  return association.run(
    `library.copy.${plan.kind}.${plan.branch}`,
    copyWorkDimensions(plan.total),
    async () => undefined,
  );
}

/** Bind nested SQL to the already consumed operation so its leaves do not double charge. */
export function bindCopyCommandOperation<T>(plan: CopyOperationPlan, dispatch: () => Promise<T>): Promise<T> {
  return activeCopyOperation.run(plan, dispatch);
}

/** Read-only roots reserve their complete two-observation operation once. */
export async function executeCopyOperation<T>(plan: CopyOperationPlan, dispatch: () => Promise<T>): Promise<T> {
  if (activeCopyOperation.getStore()) return dispatch();
  const association = currentCommandWorkAssociation();
  const reservation = association?.reserve(`library.copy.${plan.kind}.${plan.branch}`, copyWorkDimensions(plan.total));
  const settle = () => reservation?.settle();
  try {
    const result = await activeCopyOperation.run(plan, dispatch);
    settle();
    return result;
  } catch (error) {
    settle();
    throw error;
  }
}

function executeCopyStatement<T>(kind: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  if (activeCopyOperation.getStore()) return dispatch();
  const association = currentCommandWorkAssociation();
  return association ? association.run(`library.copy.${kind}`, copyWorkDimensions(bound), dispatch) : dispatch();
}

export function executeCopyStatementWork<T>(kind: string, bound: Bound, dispatch: () => Promise<T>): Promise<T> {
  return executeCopyStatement(kind, bound, dispatch);
}

/**
 * Bind one exact compiled SQL leaf to the operands sent through the existing
 * store. SQL, serialized operands and worst-case projected rows stay separate
 * terms; no returned-row observation reprices this declaration.
 */
export function copyStatementPlan<Client, Input extends object, Result>(
  kind: string,
  query: QueryModule<Client, Input, Result>,
  input: Input,
  shape: WorkShape,
  projection: unknown,
  releaseIdentifiers = 0,
): CopyStatementPlan<Client, Input, Result> {
  const operands = freezeDeep(structuredClone(input)) as Readonly<Input>;
  const resultRowBytes = projectedBytes(projection, releaseIdentifiers) + 1;
  const resultEnvelope = sumBounds(
    repeatBound(bytes(resultRowBytes), shape.projectionRows ?? shape.nativeRows),
    bytes(2),
  );
  const bound = sumBounds(
    completeWork(shape),
    bytes(statementBytes(query)),
    bytes(Buffer.byteLength(JSON.stringify(operands))),
    resultEnvelope,
  );
  return Object.freeze({
    kind,
    input: operands,
    bound,
    run(client: Client) {
      return executeCopyStatement(kind, bound, () => query.run(client, operands as Input));
    },
  });
}

type CopyPageInput = {
  route: number;
  account_id: string;
  after_created_at: string | null;
  after_copy_id: string | null;
  limit: number;
};
type CopyFilteredPageInput = CopyPageInput & {
  subject_id?: string;
  kind?: string;
  status?: string;
};
type CopyPageResult = Awaited<ReturnType<typeof copyPage.run>>;
type CopyPagePlan = Readonly<{
  input: Readonly<CopyFilteredPageInput>;
  bound: Bound;
  run(client: Parameters<typeof copyPage.run>[0]): Promise<CopyPageResult>;
}>;

function pagePlan<Input extends CopyFilteredPageInput>(
  kind: string,
  query: { sql: string },
  input: Input,
): CopyPagePlan {
  const limit = Math.min(MAX_LIBRARY_PAGE_SIZE, input.limit);
  const statement = copyStatementPlan<Parameters<typeof copyPage.run>[0], Input, CopyPageResult>(
    kind,
    query as unknown as QueryModule<Parameters<typeof copyPage.run>[0], Input, CopyPageResult>,
    { ...input, limit },
    { candidateKeys: limit, nativeRows: limit, emptySeeks: 1, nativePoints: 1 },
    COPY_PAGE_ROW,
    2,
  );
  return Object.freeze({
    input: statement.input,
    bound: statement.bound,
    run: (client) => statement.run(client),
  });
}

/** Select the same closed SQL branch as EntryStore.pageCopies and retain its raw key frontier. */
export function copyPageStatementPlan(
  input: CopyPageInput,
  subjectId: string | null,
  kind: string | null,
  status: string | null,
): CopyPagePlan {
  if (subjectId !== null) {
    const scoped = { ...input, subject_id: subjectId };
    if (kind !== null && status !== null)
      return pagePlan('copy.page.subject-kind-status', copySubjectKindStatusPage, {
        ...scoped,
        kind,
        status,
      });
    if (kind !== null) return pagePlan('copy.page.subject-kind', copySubjectKindPage, { ...scoped, kind });
    if (status !== null) return pagePlan('copy.page.subject-status', copySubjectStatusPage, { ...scoped, status });
    return pagePlan('copy.page.subject', copySubjectPage, scoped);
  }
  if (kind !== null && status !== null)
    return pagePlan('copy.page.kind-status', copyKindStatusPage, { ...input, kind, status });
  if (kind !== null) return pagePlan('copy.page.kind', copyKindPage, { ...input, kind });
  if (status !== null) return pagePlan('copy.page.status', copyStatusPage, { ...input, status });
  return pagePlan('copy.page.account', copyPage, input);
}

type InventoryOptionsInput = { route: number; account_id: string; limit: number };
export function copyInventoryValuesStatementPlan(
  input: InventoryOptionsInput,
): CopyStatementPlan<
  Parameters<typeof copyInventoryOptions.run>[0],
  InventoryOptionsInput,
  Awaited<ReturnType<typeof copyInventoryOptions.run>>
> {
  const limit = Math.min(COPY_FILTER_OPTION_QUERY_LIMIT, input.limit);
  return copyStatementPlan(
    'copy.inventory.options',
    copyInventoryOptions,
    { ...input, limit },
    {
      candidateKeys: 2 * limit,
      nativeRows: 2 * limit,
      emptySeeks: 2,
      nativePoints: 2 * limit,
    },
    INVENTORY_OPTION_ROW,
    3,
  );
}

export const copySingleRowWork = Object.freeze({ candidateKeys: 1, nativeRows: 1, emptySeeks: 1, nativePoints: 1 });
export const copyMutationWork = Object.freeze({ candidateKeys: 1, nativeRows: 1, emptySeeks: 1, nativePoints: 1 });
export const copyRetentionRestoreWork = Object.freeze({
  candidateKeys: 2,
  nativeRows: 2,
  emptySeeks: 2,
  nativePoints: 2,
});

export function copyInsertStatementPlan(input: Parameters<typeof copyInsert.run>[1]) {
  return copyStatementPlan('copy.insert', copyInsert, input, copyMutationWork, COPY_STORE_ROW, 9);
}

export function copyReadStatementPlan(input: Parameters<typeof copyRead.run>[1]) {
  return copyStatementPlan('copy.read', copyRead, input, copySingleRowWork, COPY_STORE_ROW, 9);
}

export function copyUpdateStatementPlan(input: Parameters<typeof copyUpdate.run>[1]) {
  return copyStatementPlan('copy.update', copyUpdate, input, copyMutationWork, COPY_STORE_ROW, 9);
}

export function copyDeleteStatementPlan(input: Parameters<typeof copyDelete.run>[1]) {
  return copyStatementPlan('copy.delete', copyDelete, input, copyMutationWork, COPY_STORE_ROW);
}

export function copyDetailReadStatementPlan(input: Parameters<typeof copyDetailRead.run>[1]) {
  return copyStatementPlan('copy.detail.read', copyDetailRead, input, copySingleRowWork, COPY_DETAIL_ROW, 15);
}

export function copyRetentionReadStatementPlan(input: Parameters<typeof copyRetentionRead.run>[1]) {
  return copyStatementPlan('copy.retention.read', copyRetentionRead, input, copySingleRowWork, COPY_RETENTION_ROW, 3);
}

export function copyRetentionRestoreStatementPlan(input: Parameters<typeof copyRetentionRestore.run>[1]) {
  return copyStatementPlan(
    'copy.retention.restore',
    copyRetentionRestore,
    input,
    { ...copyRetentionRestoreWork, projectionRows: 1 },
    { id: UUID },
  );
}

export type CopyPrivateReadInput = { route: number; copy_id: string; account_id: string };
export type CopyPrivateReadRow = {
  subject_id: string;
  kind: string | null;
  status: string;
  library_profile_pin: unknown;
  kind_profile_pin: unknown;
  status_profile_pin: unknown;
};
const COPY_PRIVATE_READ_SQL = `SELECT subject_id, kind, status, library_profile_pin, kind_profile_pin, status_profile_pin
FROM library.copy WHERE route=$1 AND copy_id=$2 AND account_id=$3`;

export function copyPrivateReadStatementPlan(input: CopyPrivateReadInput) {
  const query: QueryModule<CopyQueryClient, CopyPrivateReadInput, CopyPrivateReadRow | undefined> = {
    sql: COPY_PRIVATE_READ_SQL,
    async run(client, operands) {
      const result = await client.query<CopyPrivateReadRow>(COPY_PRIVATE_READ_SQL, [
        operands.route,
        operands.copy_id,
        operands.account_id,
      ]);
      return result.rows[0];
    },
  };
  return copyStatementPlan(
    'copy.restore.source-read',
    query,
    input,
    copySingleRowWork,
    {
      subject_id: UUID,
      kind: ID64,
      status: ID64,
      library_profile_pin: PIN,
    },
    9,
  );
}

type OperationSqlShape = Readonly<{
  candidateKeys: number;
  nativeRows: number;
  points: number;
  emptySeeks: number;
  witnesses?: number;
  outputBytes?: number;
  statements?: number;
}>;

function operationSql(sql: string, input: unknown, shape: OperationSqlShape): Bound {
  return declareBound({
    candidateKeys: shape.candidateKeys,
    nativeRows: shape.nativeRows,
    identityMetadataRows: 0,
    emptySeeks: shape.emptySeeks,
    nativePoints: shape.points,
    witnessKeys: shape.witnesses ?? 0,
    statements: shape.statements ?? 1,
    bytes: Buffer.byteLength(sql) + Buffer.byteLength(JSON.stringify(input)) + (shape.outputBytes ?? 0) + 2,
    engineRequests: 0,
  });
}

function textBound(sql: string): Bound {
  return declareBound({
    candidateKeys: 0,
    nativeRows: 0,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: 0,
    witnessKeys: 0,
    statements: 1,
    bytes: Buffer.byteLength(sql),
    engineRequests: 0,
  });
}

function component(kind: string, bound: Bound): CopyOperationComponent {
  return Object.freeze({ kind, bound });
}

const COPY_TIME = '\0'.repeat(64);
const COPY_EVENT = 'com.rezics.library.copy.updated.v1';
const COPY_DELETED_EVENT = 'com.rezics.library.copy.deleted.v1';
function COPY_RESPONSE_BYTES() {
  return memoizedValue(COPY_RESPONSE_BYTES, () => projectedBytes(COPY_STORE_ROW, 9) + Buffer.byteLength('{"copy":{}}'));
}
function COPY_PAGE_RESPONSE_BYTES() {
  return memoizedValue(COPY_PAGE_RESPONSE_BYTES, () => projectedBytes(COPY_PAGE_ROW, 3) + 2);
}
// Profile labels contain at most 80 Unicode code points. Two UTF-16 units per
// point, each maximally escaped by JSON, bound every admitted label.
const PROFILE_LABEL = '\0'.repeat(80 * 2);
function COPY_PRESENTATION_SHAPE() {
  return memoizedValue(COPY_PRESENTATION_SHAPE, () => ({
    meaning: 'known',
    kindLabel: PROFILE_LABEL,
    kindLabelLanguage: '\0'.repeat(64),
    statusLabel: PROFILE_LABEL,
    statusLabelLanguage: '\0'.repeat(64),
    statusEditing: {
      state: 'supported',
      statuses: Array.from({ length: MAX_COPY_FILTER_OPTIONS }, () => ({
        id: ID64,
        label: PROFILE_LABEL,
        labelLanguage: '\0'.repeat(64),
      })),
    },
    mediaCondition: { state: 'known', value: '\0'.repeat(64), label: '\0'.repeat(64) },
    packagingCondition: { state: 'known', value: '\0'.repeat(64), label: '\0'.repeat(64) },
    conditionEditing: { state: 'supported', currentness: 'current', choices: COPY_CONDITION_CHOICES },
  }));
}
function COPY_PRESENTATION_RESPONSE_BYTES() {
  return memoizedValue(
    COPY_PRESENTATION_RESPONSE_BYTES,
    () => COPY_RESPONSE_BYTES() + Buffer.byteLength(JSON.stringify(COPY_PRESENTATION_SHAPE())) + 2,
  );
}

function commandEnvelope(input: {
  route: number;
  accountId: string;
  kind: string;
  requestKey: string;
  receiptKeys: number;
  clientId: string;
  requestedBy: string | null;
  durationMs: number;
  commandInput: unknown;
  eventType: string;
  responseBytes: number;
}) {
  const route = input.route;
  const partition = partitionOf(route);
  const idempotencyKeys = [
    ...Array.from({ length: input.receiptKeys }, () => `rk1.255.${'f'.repeat(43)}`),
    input.requestKey,
  ];
  const receiptInput = {
    partition_no: partition,
    principal_kind: 'account',
    principal_id: input.accountId,
    command_kind: input.kind,
    idempotency_keys: idempotencyKeys,
  };
  const event = { type: input.eventType, subject: input.accountId, id: UUID, data: { copyId: UUID } };
  const receipt = {
    principal: { kind: 'account', id: input.accountId },
    kind: input.kind,
    key: `rk1.255.${'f'.repeat(43)}`,
    digest: 'f'.repeat(44),
    response: null,
  };
  const accountInput = { route, account_id: input.accountId };
  const commandControls = [
    'BEGIN ISOLATION LEVEL SERIALIZABLE',
    "SET LOCAL lock_timeout = '200ms'",
    "SET LOCAL statement_timeout = '5000ms'",
    "SET LOCAL statement_timeout = '5000ms'",
  ];
  const transaction = sumBounds(...commandControls.map(textBound));
  const readOnly = sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      "SET LOCAL statement_timeout = '200ms'",
      'COMMIT',
      'ROLLBACK',
    ].map(textBound),
  );
  const receiptBound = operationSql(readReceipt.sql, receiptInput, {
    candidateKeys: idempotencyKeys.length,
    nativeRows: 1,
    points: idempotencyKeys.length,
    emptySeeks: idempotencyKeys.length,
    outputBytes:
      input.responseBytes +
      Buffer.byteLength(
        JSON.stringify({
          requestDigest: 'f'.repeat(64),
          epoch: 2_147_483_647,
          position: '-9223372036854775808',
          transactionId: UUID,
          response: null,
          payloadState: 'retained',
        }),
      ),
  });
  const eventBound = operationSql(
    eventFence.sql,
    {
      partition_no: partition,
      transaction_id: UUID,
      receipt,
      basis: {
        principal: { kind: 'account', id: input.accountId },
        clientId: input.clientId,
        requestedBy: input.requestedBy,
      },
      events: [event],
    },
    {
      candidateKeys: 18,
      nativeRows: 18,
      points: 18,
      emptySeeks: 1,
      outputBytes: Buffer.byteLength(JSON.stringify({ epoch: 2_147_483_647, position: '-9223372036854775808' })),
    },
  );
  const partitionBound = sessionPartitionWork(partition);
  const retryRecovery = repeatBound(sumBounds(readOnly, partitionBound), 1 + Math.ceil(input.durationMs / 25));
  const share = nativeCopyAccountWork().share(route, input.accountId);
  const account = nativeCopyAccountWork().command(route, input.accountId);
  const time = sumBounds(
    readOnly,
    operationSql(
      timeRead.sql,
      { at: COPY_TIME },
      {
        candidateKeys: 1,
        nativeRows: 1,
        points: 1,
        emptySeeks: 1,
        outputBytes: Buffer.byteLength(JSON.stringify({ value: COPY_TIME })),
      },
    ),
  );
  const terminal = maximumCopyBound(
    sumBounds(textBound('COMMIT'), bytes(input.responseBytes)),
    sumBounds(
      textBound('ROLLBACK'),
      textBound(
        'SELECT partition_no AS "partitionNo", node, write_state AS "writeState", moved_to AS "movedTo", epoch, position FROM core.partition WHERE partition_no = :partition_no;',
      ),
    ),
  );
  return {
    account,
    share,
    receipt: receiptBound,
    time,
    transaction,
    terminal,
    eventFence: sumBounds(eventBound, bytes(input.responseBytes)),
    retryRecovery,
    partition: partitionBound,
    controls: commandControls,
    accountInput,
    requestKeyBytes: Buffer.byteLength(input.requestKey),
    commandInputBytes: Buffer.byteLength(JSON.stringify(input.commandInput)),
  };
}

/** Schema trigger effects are charged with each bounded copy mutation statement. */
function copyTriggerWork(operation: 'insert' | 'update' | 'delete' | 'restore', accountId: string, subjectId: string) {
  const input = { route: 65535, account_id: accountId, subject_id: subjectId, family: 'copy', pin: PIN };
  const sourceHeadSql = `INSERT INTO library.fact_source_head AS head (route, account_id, generation)
VALUES (:route, :account_id, 1) ON CONFLICT (route, account_id) DO UPDATE SET generation = head.generation + 1`;
  const nativeFenceSql = `INSERT INTO library.native_source_fence(route,kind,owner_id,generation,account_id)
VALUES(:route,'account',:owner_id,1,:owner_id) ON CONFLICT (route,kind,owner_id)
DO UPDATE SET generation=library.native_source_fence.generation+1,
account_id=COALESCE(library.native_source_fence.account_id,EXCLUDED.account_id)`;
  const migrationReadSql = `SELECT profile_migration_phase FROM library.fact_source_head
WHERE route=:route AND account_id=:account_id FOR UPDATE`;
  const liveCopySql = `SELECT EXISTS (SELECT 1 FROM library.copy WHERE route=:route AND account_id=:account_id
AND subject_id=:subject_id AND deletion_id IS NULL AND COALESCE(library_profile_pin,'{}'::jsonb)=:pin)`;
  const headLockSql = `SELECT 1 FROM library.fact_source_head WHERE route=:route AND account_id=:account_id FOR UPDATE`;
  const ownerActivitySql = `SELECT GREATEST(
    (SELECT e.activity_at FROM library.entry e WHERE e.route=:route AND e.account_id=:account_id AND e.subject_id=:subject_id),
    (SELECT h.last_changed_at FROM library.progress_head h WHERE h.route=:route AND h.account_id=:account_id AND h.subject_id=:subject_id)
  ), EXISTS(SELECT 1 FROM library.entry e WHERE e.route=:route AND e.account_id=:account_id AND e.subject_id=:subject_id
      AND e.activity_at IS NULL)
    OR (EXISTS(SELECT 1 FROM library.progress_session p WHERE p.state <> 'retired' AND p.route=:route AND p.account_id=:account_id AND p.subject_id=:subject_id)
      AND NOT EXISTS(SELECT 1 FROM library.progress_head h WHERE h.route=:route AND h.account_id=:account_id AND h.subject_id=:subject_id
        AND h.last_changed_at IS NOT NULL))`;
  const point = (sql: string, rows = 1) =>
    operationSql(sql, input, { candidateKeys: rows, nativeRows: rows, points: rows, emptySeeks: 1 });
  // refresh_owner_member_scope's live and absent arms are exclusive. The BEFORE
  // INSERT owner activity trigger runs even when ON CONFLICT keeps the old row.
  const liveScope = sumBounds(
    point(
      `INSERT INTO library.owner_member_support VALUES(:route,:account_id,:subject_id,:family,:pin) ON CONFLICT DO NOTHING`,
    ),
    point(`INSERT INTO library.owner_member_index VALUES(:route,:account_id,:subject_id) ON CONFLICT DO NOTHING`),
    operationSql(ownerActivitySql, input, {
      candidateKeys: 5,
      nativeRows: 5,
      points: 5,
      emptySeeks: 5,
      outputBytes: Buffer.byteLength(JSON.stringify({ activity_at: COPY_TIME, activity_unknown: true })),
    }),
    point(
      `INSERT INTO library.owner_index_pin(route,account_id,pin) VALUES(:route,:account_id,:pin) ON CONFLICT DO NOTHING`,
    ),
  );
  const absentScope = sumBounds(
    point(
      `DELETE FROM library.owner_member_support WHERE route=:route AND account_id=:account_id AND subject_id=:subject_id AND family=:family AND pin=:pin`,
    ),
    point(
      `DELETE FROM library.owner_index_pin WHERE route=:route AND account_id=:account_id AND pin=:pin AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=:route AND account_id=:account_id AND pin=:pin)`,
      2,
    ),
    // The pin FK cascades to at most the release's 64 owner-index states.
    point(`DELETE FROM library.owner_index_state WHERE route=:route AND account_id=:account_id AND pin=:pin`, 64),
    point(
      `DELETE FROM library.owner_member_index WHERE route=:route AND account_id=:account_id AND subject_id=:subject_id AND NOT EXISTS (
      SELECT 1 FROM library.owner_member_support WHERE route=:route AND account_id=:account_id AND subject_id=:subject_id)`,
      2,
    ),
  );
  const scope = sumBounds(
    operationSql(headLockSql, input, { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1 }),
    operationSql(liveCopySql, input, { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1 }),
    maximumCopyBound(liveScope, absentScope),
  );
  const profileMigration =
    operation === 'delete'
      ? bytes(0)
      : sumBounds(
          operationSql(
            `INSERT INTO library.fact_source_head (route, account_id, generation) VALUES (:route,:account_id,1) ON CONFLICT DO NOTHING`,
            input,
            {
              candidateKeys: 1,
              nativeRows: 1,
              points: 1,
              emptySeeks: 1,
            },
          ),
          operationSql(migrationReadSql, input, { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1 }),
          ...['entry', 'progress_session', 'copy', 'entry_deleted'].map((table) =>
            point(
              `SELECT 1 FROM library.${table} WHERE route=:route AND account_id=:account_id AND library_profile_pin IS NULL LIMIT 1`,
            ),
          ),
          point(
            `UPDATE library.fact_source_head SET profile_migration_phase='ready' WHERE route=:route AND account_id=:account_id`,
          ),
        );
  const copyIndexes = 18; // PK plus the 17 live, retained, export and owner-scope indexes in schema.sql.
  const copyRow = declareBound({
    candidateKeys: copyIndexes + 1,
    nativeRows: copyIndexes + 1,
    identityMetadataRows: 0,
    emptySeeks: 0,
    nativePoints: copyIndexes + 1,
    witnessKeys: 0,
    statements: 1,
    bytes: projectedBytes(COPY_STORE_ROW, 6),
    engineRequests: 0,
  });
  return sumBounds(
    repeatBound(copyRow, operation === 'insert' ? 1 : 2),
    profileMigration,
    operationSql(sourceHeadSql, input, { candidateKeys: 1, nativeRows: 1, points: 1, emptySeeks: 1 }),
    repeatBound(
      operationSql(
        nativeFenceSql,
        { ...input, owner_id: accountId },
        {
          candidateKeys: 1,
          nativeRows: 1,
          points: 1,
          emptySeeks: 1,
        },
      ),
      operation === 'insert' ? 2 : 4,
    ),
    repeatBound(scope, operation === 'insert' ? 1 : operation === 'update' ? 0 : 2),
  );
}

/** One immutable command plan has shared receipt controls and exclusive outcomes. */
export function copyMutationOperationPlan(
  operation: CopyMutationOperation,
  input: CopyMutationOperationInput,
): CopyOperationPlan {
  const subject = input.subjectId ?? UUID;
  const controls = commandEnvelope({
    route: input.route,
    accountId: input.accountId,
    kind: `library.copy.${operation === 'restore' ? 'restore' : operation}`,
    requestKey: input.requestKey,
    receiptKeys: input.receiptKeys,
    commandInput: input.commandInput,
    eventType: operation === 'delete' ? COPY_DELETED_EVENT : COPY_EVENT,
    responseBytes: COPY_RESPONSE_BYTES(),
    clientId: input.clientId,
    requestedBy: input.requestedBy,
    durationMs: input.durationMs,
  });
  const shared = [
    component('command.account.floor', controls.account),
    component('command.account.fence', controls.share),
    component('command.time', controls.time),
    component('command.transaction.controls', controls.transaction),
    component('command.terminal.commit-or-rollback', controls.terminal),
    component('command.receipt.lookup', controls.receipt),
    component('command.shelf', sessionShelfWork(input.route, input.accountId, false)),
    component(
      'copy.pre-profile-read-fences',
      repeatBound(sessionProfileMigrationWork(input.route, input.accountId), 3),
    ),
    component('command.partition', controls.partition),
    component('command.retry.recovery', controls.retryRecovery),
    component('command.input.serialization', bytes(Buffer.byteLength(JSON.stringify(input.commandInput)))),
    component('command.response.serialization', bytes(3 * COPY_RESPONSE_BYTES())),
  ];
  const prepareRead = sumBounds(
    ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map(textBound),
    nativeCopyAccountWork().floor(input.route, input.accountId),
  );
  const sourceInitial =
    operation === 'create' || operation === 'update' || operation === 'restore'
      ? sessionSourceWork(subject, true)
      : declareBound({
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
  const sourceCurrent = operation === 'create' || operation === 'update' ? sessionSourceWork(subject, true) : undefined;
  const lock = operationSql(
    'SELECT copy_id FROM library.copy WHERE route = $1 AND copy_id = $2 AND account_id = $3 FOR UPDATE',
    [input.route, input.copyId, input.accountId],
    {
      candidateKeys: 1,
      nativeRows: 1,
      points: 1,
      emptySeeks: 1,
      outputBytes: Buffer.byteLength(JSON.stringify({ copy_id: UUID })),
    },
  );
  const loan = operationSql(
    `SELECT loan_id FROM library.copy_loan
     WHERE route=$1 AND account_id=$2 AND copy_id=$3 AND returned_on IS NULL LIMIT 1`,
    [input.route, input.accountId, input.copyId],
    {
      candidateKeys: 1,
      nativeRows: 1,
      points: 1,
      emptySeeks: 1,
      outputBytes: Buffer.byteLength(JSON.stringify({ loan_id: UUID })),
    },
  );
  const read = copyReadStatementPlan({ route: input.route, copy_id: input.copyId }).bound;
  let mutation = bytes(0);
  let currentFact = bytes(0);
  let privateRead = bytes(0);
  let retentionRead = bytes(0);
  let retainedReleases = bytes(0);
  let restoreSource = bytes(0);
  if (operation === 'create') {
    const insert = copyInsertStatementPlan({
      route: input.route,
      copy_id: input.copyId,
      account_id: input.accountId,
      subject_id: subject,
      status: input.status ?? ID64,
      location: input.location ?? null,
      source: input.source ?? null,
      acquired_on: input.acquiredOn ?? null,
      disposed_on: input.disposedOn ?? null,
      note: input.note ?? null,
      media_condition: jsonParameter(input.mediaCondition ?? null),
      packaging_condition: jsonParameter(input.packagingCondition ?? null),
      kind: input.kind ?? ID64,
      library_profile_pin: PIN,
      transaction_id: UUID,
      time: COPY_TIME,
    }).bound;
    mutation = insert;
  } else if (operation === 'update') {
    currentFact = copyReadStatementPlan({ route: input.route, copy_id: input.copyId }).bound;
    const update = copyUpdateStatementPlan({
      route: input.route,
      copy_id: input.copyId,
      revision: input.revision ?? 2_147_483_646,
      status: input.status ?? ID64,
      location: input.location ?? '\0'.repeat(200),
      source: input.source ?? '\0'.repeat(200),
      acquired_on: input.acquiredOn ?? '\0'.repeat(64),
      disposed_on: input.disposedOn ?? '\0'.repeat(64),
      note: input.note ?? '\0'.repeat(1000),
      media_condition: jsonParameter(input.mediaCondition ?? CONDITION),
      packaging_condition: jsonParameter(input.packagingCondition ?? CONDITION),
      library_profile_pin: PIN,
      transaction_id: UUID,
      time: COPY_TIME,
    }).bound;
    mutation = update;
  } else if (operation === 'delete') {
    const deletion = copyDeleteStatementPlan({
      route: input.route,
      copy_id: input.copyId,
      revision: input.revision ?? 2_147_483_646,
      deletion_id: UUID,
      time: COPY_TIME,
    }).bound;
    mutation = deletion;
  } else {
    privateRead = copyPrivateReadStatementPlan({
      route: input.route,
      copy_id: input.copyId,
      account_id: input.accountId,
    }).bound;
    retentionRead = copyRetentionReadStatementPlan({
      route: input.route,
      copy_id: input.copyId,
      account_id: input.accountId,
      time: COPY_TIME,
    }).bound;
    const restore = copyRetentionRestoreStatementPlan({
      route: input.route,
      account_id: input.accountId,
      copy_id: input.copyId,
      deletion_id: input.deletionId ?? UUID,
      revision: input.revision ?? 2_147_483_646,
      time: COPY_TIME,
      transaction_id: UUID,
    }).bound;
    mutation = restore;
    retainedReleases = repeatBound(sessionReleaseWork('sha256:' + 'f'.repeat(64)), 2);
    restoreSource = sessionSourceWork(subject, false);
  }
  return copyMutationPlan(operation, input, subject, {
    shared,
    prepareRead,
    sourceInitial,
    sourceCurrent: sourceCurrent ?? bytes(0),
    lock,
    loan,
    read,
    currentFact,
    mutation,
    trigger: copyTriggerWork(operation === 'create' ? 'insert' : operation, input.accountId, subject),
    privateRead,
    retentionRead,
    retainedReleases,
    restoreSource,
    eventFence: controls.eventFence,
    terminal: controls.terminal,
  });
}

/** Current-owner account gate used before a command request is normalized. */
export function copyAccountGatePlan(route: number, accountId: string): CopyOperationPlan {
  const read = nativeCopyAccountWork().floor(route, accountId);
  return copyAccountPlan(route, accountId, read);
}

/** Point read owner: current floor, one RR observation, private migration gate and response projection. */
export function copyReadOperationPlan(route: number, accountId: string, copyId: string): CopyOperationPlan {
  const read = copyReadStatementPlan({ route, copy_id: copyId }).bound;
  const transaction = sumBounds(
    ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map(textBound),
    nativeCopyAccountWork().floor(route, accountId),
  );
  const migration = sessionProfileMigrationWork(route, accountId);
  return copyReadPlan(route, accountId, copyId, {
    read,
    transaction,
    migration,
    partition: sessionPartitionWork(partitionOf(route)),
    response: bytes(COPY_RESPONSE_BYTES()),
  });
}

/** Bounded private detail has two full owner/source observations and serializes the mounted presentation. */
export function copyPresentationOperationPlan(
  route: number,
  accountId: string,
  copyId: string,
  subjectId: string,
): CopyOperationPlan {
  const readonly = sumBounds(
    ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map(textBound),
    nativeCopyAccountWork().floor(route, accountId),
  );
  const detail = copyDetailReadStatementPlan({ route, copy_id: copyId, account_id: accountId }).bound;
  const source = sumBounds(sessionSourceWork(subjectId, true), sessionSourceWork(subjectId, false));
  const pins = repeatBound(sessionReleaseWork('sha256:' + 'f'.repeat(64)), 4);
  const observation = sumBounds(readOnlyTimeWork(), readonly, sessionPartitionWork(partitionOf(route)), detail);
  return copyPresentationPlan(route, accountId, copyId, subjectId, {
    observation,
    pins,
    source,
    response: bytes(COPY_PRESENTATION_RESPONSE_BYTES()),
  });
}

function readOnlyTimeWork(): Bound {
  return sumBounds(
    ...[
      'BEGIN ISOLATION LEVEL READ COMMITTED READ ONLY',
      "SET LOCAL statement_timeout = '200ms'",
      'COMMIT',
      'ROLLBACK',
    ].map(textBound),
    sessionReadTimeWork(),
    operationSql(
      timeRead.sql,
      { at: COPY_TIME },
      {
        candidateKeys: 1,
        nativeRows: 1,
        points: 1,
        emptySeeks: 1,
        outputBytes: Buffer.byteLength(JSON.stringify({ value: COPY_TIME })),
      },
    ),
  );
}

/** The actual filtered observations, maximum-page sentinel and bounded profile-pin inventory reads. */
export function copyInventoryOperationPlan(input: CopyInventoryOperationInput): CopyOperationPlan {
  const pageLimit = Math.min(MAX_LIBRARY_PAGE_SIZE, input.limit + 1);
  const page = copyPageStatementPlan(
    {
      route: input.route,
      account_id: input.accountId,
      after_created_at: input.cursor ? COPY_TIME : null,
      after_copy_id: input.cursor ? UUID : null,
      limit: pageLimit,
    },
    input.subjectId,
    input.kind,
    input.status,
  ).bound;
  const sentinel = copyPageStatementPlan(
    {
      route: input.route,
      account_id: input.accountId,
      after_created_at: COPY_TIME,
      after_copy_id: UUID,
      limit: 1,
    },
    input.subjectId,
    input.kind,
    input.status,
  ).bound;
  const options = copyInventoryValuesStatementPlan({
    route: input.route,
    account_id: input.accountId,
    limit: COPY_FILTER_OPTION_QUERY_LIMIT,
  }).bound;
  const readonly = sumBounds(
    ...['BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY', 'COMMIT', 'ROLLBACK'].map(textBound),
    nativeCopyAccountWork().floor(input.route, input.accountId),
    sessionPartitionWork(partitionOf(input.route)),
  );
  const migration = sessionProfileMigrationWork(input.route, input.accountId);
  const distinctPins = repeatBound(sessionReleaseWork('sha256:' + 'f'.repeat(64)), 2 * MAX_COPY_FILTER_OPTIONS);
  const rawResponses = sumBounds(
    repeatBound(bytes(COPY_PAGE_RESPONSE_BYTES()), input.limit),
    bytes(2 * MAX_COPY_FILTER_OPTIONS_BYTES),
    repeatBound(bytes(projectedBytes(INVENTORY_OPTION_ROW, 2)), 2 * COPY_FILTER_OPTION_QUERY_LIMIT),
  );
  return copyInventoryPlan(input, {
    readonly,
    page,
    sentinel,
    migration,
    options,
    pins: distinctPins,
    cursor: bytes(Buffer.byteLength(input.cursor ?? '')),
    responses: rawResponses,
    cursorBytes: Buffer.byteLength(input.cursor ?? ''),
  });
}

import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import { RELEASE_LIMITS } from '@rezics/definitions';
import type { PoolClient } from 'pg';
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

/** The public inventory ceiling and its native sentinel remain 64 and 65. */
export const MAX_COPY_FILTER_OPTIONS = 64;
export const COPY_FILTER_OPTION_QUERY_LIMIT = MAX_COPY_FILTER_OPTIONS + 1;

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

const UUID = 'f'.repeat(36);
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
  const operands = Object.freeze({ ...input }) as Readonly<Input>;
  const resultRowBytes = projectedBytes(projection, releaseIdentifiers) + 1;
  const resultEnvelope = sumBounds(
    repeatBound(bytes(resultRowBytes), shape.projectionRows ?? shape.nativeRows),
    bytes(2),
  );
  const bound = sumBounds(
    completeWork(shape),
    bytes(Buffer.byteLength(query.sql)),
    bytes(Buffer.byteLength(JSON.stringify(operands))),
    resultEnvelope,
  );
  return Object.freeze({
    kind,
    input: operands,
    bound,
    run(client: Client) {
      return query.run(client, operands as Input);
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

function pagePlan<Client, Input extends CopyFilteredPageInput, Result extends CopyPageResult>(
  kind: string,
  query: QueryModule<Client, Input, Result>,
  input: Input,
): CopyPagePlan {
  const limit = Math.min(MAX_LIBRARY_PAGE_SIZE, input.limit);
  const statement = copyStatementPlan(
    kind,
    query,
    { ...input, limit },
    { candidateKeys: limit, nativeRows: limit, emptySeeks: 1, nativePoints: 1 },
    COPY_PAGE_ROW,
    2,
  );
  return Object.freeze({
    input: statement.input,
    bound: statement.bound,
    run: (client) => statement.run(client as Client),
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
    2,
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
  return copyStatementPlan('copy.insert', copyInsert, input, copyMutationWork, COPY_STORE_ROW, 6);
}

export function copyReadStatementPlan(input: Parameters<typeof copyRead.run>[1]) {
  return copyStatementPlan('copy.read', copyRead, input, copySingleRowWork, COPY_STORE_ROW, 6);
}

export function copyUpdateStatementPlan(input: Parameters<typeof copyUpdate.run>[1]) {
  return copyStatementPlan('copy.update', copyUpdate, input, copyMutationWork, COPY_STORE_ROW, 6);
}

export function copyDeleteStatementPlan(input: Parameters<typeof copyDelete.run>[1]) {
  return copyStatementPlan('copy.delete', copyDelete, input, copyMutationWork, COPY_STORE_ROW);
}

export function copyDetailReadStatementPlan(input: Parameters<typeof copyDetailRead.run>[1]) {
  return copyStatementPlan('copy.detail.read', copyDetailRead, input, copySingleRowWork, COPY_DETAIL_ROW, 10);
}

export function copyRetentionReadStatementPlan(input: Parameters<typeof copyRetentionRead.run>[1]) {
  return copyStatementPlan('copy.retention.read', copyRetentionRead, input, copySingleRowWork, COPY_RETENTION_ROW, 2);
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
const COPY_PRIVATE_READ_SQL =
  'SELECT subject_id, kind, status, library_profile_pin, kind_profile_pin, status_profile_pin FROM library.copy WHERE route=$1 AND copy_id=$2 AND account_id=$3';

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
      kind_profile_pin: PIN,
      status_profile_pin: PIN,
    },
    6,
  );
}


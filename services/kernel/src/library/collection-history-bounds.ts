import { memoizedValue } from '../memoized.ts';
/** Immutable nine-axis declarations for the existing Collection metadata journal SQL. */
import { declareBound, sumBounds, withinCeiling, type Bound } from '@rezics/bounds';
import type { PoolClient } from 'pg';
import append from './collection-metadata-history-append.sql';
import init from './collection-metadata-history-init.sql';
import owner from './collection-metadata-history-owner.sql';
import page from './collection-metadata-history-page.sql';
import prune from './collection-metadata-history-prune.sql';
import pruned from './collection-metadata-history-pruned.sql';
import read from './collection-metadata-history-read.sql';
import state from './collection-metadata-history-state.sql';
import { COLLECTION_PUBLICATION_STEP_CEILING } from './collection-publication-bounds.ts';

export const COLLECTION_METADATA_HISTORY_LIMIT = 128;
export const COLLECTION_METADATA_HISTORY_PAGE_SIZE = 25;
export const COLLECTION_METADATA_HISTORY_MAX_PAGE_SIZE = 50;

export type CollectionMetadataSnapshotInput = Readonly<{
  title: string;
  description: string | null;
  visibility: 'private' | 'unlisted' | 'public';
  presentationKind: string | null;
  coverMediaId: string | null;
}>;
export type CollectionMetadataFieldInput = 'title' | 'description' | 'visibility' | 'presentationKind' | 'coverMediaId';
type QueryClient = Pick<PoolClient, 'query'>;

function ZERO() {
  return memoizedValue(ZERO, () =>
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
    }),
  );
}
type SqlShape = Readonly<{
  candidateKeys: number;
  examinedRows: number;
  resultRows: number;
  rowBytes: number;
  emptySeeks: number;
}>;

const jsonStringBytes = (codePoints: number) => 2 + 6 * codePoints;

type StringWidths = Readonly<Record<string, number>>;

/** Preserve the plan's original operands while reserving their schema-valid escaped maximum. */
function escapedBindBytes(input: object, widths: StringWidths = {}): number {
  let bytes = Buffer.byteLength(JSON.stringify(input));
  const values = input as Record<string, unknown>;
  for (const [key, codePoints] of Object.entries(widths)) {
    const value = values[key];
    const actual = typeof value === 'string' ? Buffer.byteLength(JSON.stringify(value)) : Buffer.byteLength('null');
    bytes += Math.max(actual, jsonStringBytes(codePoints)) - actual;
  }
  return bytes;
}

/** The fixed JSON framing plus each schema-bounded string's worst valid escaped projection. */
function projectionBytes(row: Record<string, unknown>, strings: Readonly<Record<string, number>> = {}): number {
  let bytes = Buffer.byteLength(JSON.stringify(row));
  for (const [key, codePoints] of Object.entries(strings)) {
    const value = row[key];
    const current = typeof value === 'string' ? Buffer.byteLength(JSON.stringify(value)) : Buffer.byteLength('null');
    bytes += Math.max(current, jsonStringBytes(codePoints)) - current;
  }
  return bytes;
}

function resultArrayBytes(rowBytes: number, rows: number): number {
  return rows === 0 ? Buffer.byteLength('[]') : 2 + rowBytes * rows + rows - 1;
}

function sqlPoint<Input>(
  query: Readonly<{ sql: string }>,
  input: Input,
  shape: SqlShape,
  stringWidths?: StringWidths,
): Bound {
  const statement = declareBound({
    candidateKeys: shape.candidateKeys,
    nativeRows: shape.examinedRows,
    identityMetadataRows: 0,
    emptySeeks: shape.emptySeeks,
    nativePoints: 1,
    witnessKeys: 0,
    statements: 1,
    bytes:
      Buffer.byteLength(query.sql) +
      escapedBindBytes(input as object, stringWidths) +
      resultArrayBytes(shape.rowBytes, shape.resultRows),
    engineRequests: 0,
  });
  return sumBounds(statement);
}

const stateRowBytes = projectionBytes({
  coverage: 'partial',
  knownFromRevision: 2_147_483_647,
  prunedBeforeRevision: 2_147_483_647,
});
const pageRowBytes = projectionBytes(
  {
    revision: 2_147_483_647,
    transactionId: 'f'.repeat(36),
    recordedAt: 'x'.repeat(64),
    changedFields: ['presentationKind', 'coverMediaId', 'description', 'visibility', 'title'],
  },
  { recordedAt: 64 },
);
const detailRowBytes = projectionBytes(
  {
    revision: 2_147_483_647,
    transactionId: 'f'.repeat(36),
    recordedAt: 'x'.repeat(64),
    changedFields: ['presentationKind', 'coverMediaId', 'description', 'visibility', 'title'],
    beforeTitle: 'x',
    afterTitle: 'x',
    beforeDescription: 'x',
    afterDescription: 'x',
    beforeVisibility: 'unlisted',
    afterVisibility: 'unlisted',
    beforePresentationKind: 'x',
    afterPresentationKind: 'x',
    beforeCoverMediaId: 'f'.repeat(36),
    afterCoverMediaId: 'f'.repeat(36),
  },
  {
    recordedAt: 64,
    beforeTitle: 200,
    afterTitle: 200,
    beforeDescription: 2_000,
    afterDescription: 2_000,
    beforeVisibility: 8,
    afterVisibility: 8,
    beforePresentationKind: 128,
    afterPresentationKind: 128,
    beforeCoverMediaId: 36,
    afterCoverMediaId: 36,
  },
);

export type CollectionMetadataHistorySqlPlan<Input = unknown> = Readonly<{
  kind: string;
  input: Readonly<Input>;
  total: Bound;
  withinExistingCeiling: boolean;
}>;

function sqlPlan<Input>(
  kind: string,
  query: Readonly<{ sql: string }>,
  input: Input,
  shape: SqlShape,
  stringWidths?: StringWidths,
): CollectionMetadataHistorySqlPlan<Input> {
  const frozenInput = Object.freeze({ ...input }) as Readonly<Input>;
  const total = sqlPoint(query, frozenInput as Input, shape, stringWidths);
  return Object.freeze({
    kind,
    input: frozenInput,
    total,
    withinExistingCeiling: withinCeiling(total, COLLECTION_PUBLICATION_STEP_CEILING()),
  });
}

export function collectionMetadataHistoryInitializePlan(input: {
  route: number;
  collection: Readonly<{ id: string; curatorAccountId: string }>;
  transactionId: string;
  time: string;
}) {
  const sqlInput = {
    route: input.route,
    collection_id: input.collection.id,
    curator_account_id: input.collection.curatorAccountId,
    transaction_id: input.transactionId,
    updated_at: input.time,
  };
  return sqlPlan(
    'collection.metadata-history.initialize',
    init,
    sqlInput,
    {
      candidateKeys: 1,
      examinedRows: 1,
      resultRows: 1,
      rowBytes: projectionBytes({ collectionId: 'f'.repeat(36) }),
      emptySeeks: 1,
    },
    {
      collection_id: 36,
      curator_account_id: 36,
      transaction_id: 36,
      updated_at: 64,
    },
  );
}

export type CollectionMetadataHistoryCapturePlan = Readonly<{
  kind: 'collection.metadata-history.no-change' | 'collection.metadata-history.capture';
  input: Readonly<{
    route: number;
    before: CollectionMetadataSnapshotInput;
    after: CollectionMetadataSnapshotInput;
    collectionId: string;
    curatorAccountId: string;
    revision: number;
    transactionId: string;
    time: string;
  }>;
  changedFields: readonly CollectionMetadataFieldInput[];
  leaves: Readonly<{
    owner?: CollectionMetadataHistorySqlPlan;
    append?: CollectionMetadataHistorySqlPlan;
    prune?: CollectionMetadataHistorySqlPlan;
    pruned?: CollectionMetadataHistorySqlPlan;
  }>;
  total: Bound;
  withinExistingCeiling: boolean;
}>;

export function collectionMetadataHistoryCapturePlan(input: {
  route: number;
  before: CollectionMetadataSnapshotInput & Readonly<{ id: string }>;
  after: CollectionMetadataSnapshotInput & Readonly<{ id: string; curatorAccountId: string | null; revision: number }>;
  transactionId: string;
  time: string;
}): CollectionMetadataHistoryCapturePlan {
  const fields: readonly CollectionMetadataFieldInput[] = [
    'title',
    'description',
    'visibility',
    'presentationKind',
    'coverMediaId',
  ];
  const changedFields = Object.freeze(fields.filter((field) => !Object.is(input.before[field], input.after[field])));
  const curatorAccountId = input.after.curatorAccountId;
  const frozenInput = Object.freeze({
    route: input.route,
    before: Object.freeze({
      title: input.before.title,
      description: input.before.description,
      visibility: input.before.visibility,
      presentationKind: input.before.presentationKind,
      coverMediaId: input.before.coverMediaId,
    }),
    after: Object.freeze({
      title: input.after.title,
      description: input.after.description,
      visibility: input.after.visibility,
      presentationKind: input.after.presentationKind,
      coverMediaId: input.after.coverMediaId,
    }),
    collectionId: input.after.id,
    curatorAccountId: curatorAccountId ?? '',
    revision: input.after.revision,
    transactionId: input.transactionId,
    time: input.time,
  });
  if (changedFields.length === 0)
    return Object.freeze({
      kind: 'collection.metadata-history.no-change',
      input: frozenInput,
      changedFields,
      leaves: Object.freeze({}),
      total: ZERO(),
      withinExistingCeiling: true,
    });

  const ownerPlan = sqlPlan(
    'collection.metadata-history.owner-currentness',
    owner,
    {
      route: input.route,
      collection_id: input.after.id,
      curator_account_id: curatorAccountId ?? '',
      revision: input.after.revision,
      transaction_id: input.transactionId,
      updated_at: input.time,
    },
    {
      candidateKeys: COLLECTION_METADATA_HISTORY_LIMIT + 1,
      examinedRows: COLLECTION_METADATA_HISTORY_LIMIT + 1,
      resultRows: 1,
      rowBytes: projectionBytes({ collectionId: 'f'.repeat(36) }),
      emptySeeks: 1,
    },
    {
      collection_id: 36,
      curator_account_id: 36,
      transaction_id: 36,
      updated_at: 64,
    },
  );
  const appendPlan = sqlPlan(
    'collection.metadata-history.append-transition',
    append,
    {
      route: input.route,
      collection_id: input.after.id,
      curator_account_id: curatorAccountId ?? '',
      revision: input.after.revision,
      transaction_id: input.transactionId,
      recorded_at: input.time,
      changed_fields: changedFields,
      before_title: input.before.title,
      after_title: input.after.title,
      before_description: input.before.description,
      after_description: input.after.description,
      before_visibility: input.before.visibility,
      after_visibility: input.after.visibility,
      before_presentation_kind: input.before.presentationKind,
      after_presentation_kind: input.after.presentationKind,
      before_cover_media_id: input.before.coverMediaId,
      after_cover_media_id: input.after.coverMediaId,
    },
    {
      candidateKeys: 2,
      examinedRows: 2,
      resultRows: 1,
      rowBytes: projectionBytes({ revision: 2_147_483_647 }),
      emptySeeks: 0,
    },
    {
      collection_id: 36,
      curator_account_id: 36,
      transaction_id: 36,
      recorded_at: 64,
      before_title: 200,
      after_title: 200,
      before_description: 2_000,
      after_description: 2_000,
      before_visibility: 8,
      after_visibility: 8,
      before_presentation_kind: 128,
      after_presentation_kind: 128,
      before_cover_media_id: 36,
      after_cover_media_id: 36,
    },
  );
  const prunePlan = sqlPlan(
    'collection.metadata-history.prune-one-retained-entry',
    prune,
    { route: input.route, collection_id: input.after.id },
    {
      candidateKeys: COLLECTION_METADATA_HISTORY_LIMIT + 1,
      examinedRows: COLLECTION_METADATA_HISTORY_LIMIT + 1,
      resultRows: 1,
      rowBytes: projectionBytes({ revision: 2_147_483_647 }),
      emptySeeks: 1,
    },
  );
  const prunedPlan = sqlPlan(
    'collection.metadata-history.mark-partial-after-prune',
    pruned,
    {
      route: input.route,
      collection_id: input.after.id,
      curator_account_id: curatorAccountId ?? '',
      transaction_id: input.transactionId,
      updated_at: input.time,
    },
    {
      candidateKeys: 2,
      examinedRows: COLLECTION_METADATA_HISTORY_LIMIT + 1,
      resultRows: 1,
      rowBytes: projectionBytes({ collectionId: 'f'.repeat(36) }),
      emptySeeks: 1,
    },
    {
      collection_id: 36,
      curator_account_id: 36,
      transaction_id: 36,
      updated_at: 64,
    },
  );
  const total = sumBounds(ownerPlan.total, appendPlan.total, prunePlan.total, prunedPlan.total);
  return Object.freeze({
    kind: 'collection.metadata-history.capture',
    input: frozenInput,
    changedFields,
    leaves: Object.freeze({ owner: ownerPlan, append: appendPlan, prune: prunePlan, pruned: prunedPlan }),
    total,
    withinExistingCeiling: withinCeiling(total, COLLECTION_PUBLICATION_STEP_CEILING()),
  });
}

export function collectionMetadataHistoryStatePlan(input: {
  route: number;
  collectionId: string;
  curatorAccountId: string;
}) {
  const sqlInput = {
    route: input.route,
    collection_id: input.collectionId,
    curator_account_id: input.curatorAccountId,
  };
  return sqlPlan(
    'collection.metadata-history.state',
    state,
    sqlInput,
    {
      candidateKeys: 1,
      examinedRows: 1,
      resultRows: 1,
      rowBytes: stateRowBytes,
      emptySeeks: 1,
    },
    { collection_id: 36, curator_account_id: 36 },
  );
}

export function collectionMetadataHistoryPagePlan(input: {
  route: number;
  collectionId: string;
  curatorAccountId: string;
  afterRevision: number | null;
  limit: number;
}) {
  const sqlInput = {
    route: input.route,
    collection_id: input.collectionId,
    curator_account_id: input.curatorAccountId,
    after_revision: input.afterRevision,
    page_limit: input.limit,
  };
  const resultRows = input.limit;
  return sqlPlan(
    input.afterRevision === null ? 'collection.metadata-history.page-first' : 'collection.metadata-history.page-next',
    page,
    sqlInput,
    {
      candidateKeys: COLLECTION_METADATA_HISTORY_LIMIT,
      examinedRows: COLLECTION_METADATA_HISTORY_LIMIT,
      resultRows,
      rowBytes: pageRowBytes,
      emptySeeks: 1,
    },
    { collection_id: 36, curator_account_id: 36 },
  );
}

export function collectionMetadataHistoryEntryPlan(input: {
  route: number;
  collectionId: string;
  curatorAccountId: string;
  revision: number;
}) {
  const sqlInput = {
    route: input.route,
    collection_id: input.collectionId,
    curator_account_id: input.curatorAccountId,
    revision: input.revision,
  };
  return sqlPlan(
    'collection.metadata-history.detail-exact-revision',
    read,
    sqlInput,
    {
      candidateKeys: 1,
      examinedRows: 1,
      resultRows: 1,
      rowBytes: detailRowBytes,
      emptySeeks: 1,
    },
    { collection_id: 36, curator_account_id: 36 },
  );
}

export function executeCollectionMetadataHistoryInitialize(
  client: QueryClient,
  plan: CollectionMetadataHistorySqlPlan,
) {
  return init.run(client, plan.input as Parameters<typeof init.run>[1]);
}
export function executeCollectionMetadataHistoryOwner(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return owner.run(client, plan.input as Parameters<typeof owner.run>[1]);
}
export function executeCollectionMetadataHistoryAppend(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return append.run(client, plan.input as Parameters<typeof append.run>[1]);
}
export function executeCollectionMetadataHistoryPrune(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return prune.run(client, plan.input as Parameters<typeof prune.run>[1]);
}
export function executeCollectionMetadataHistoryPruned(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return pruned.run(client, plan.input as Parameters<typeof pruned.run>[1]);
}
export function executeCollectionMetadataHistoryState(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return state.run(client, plan.input as Parameters<typeof state.run>[1]);
}
export function executeCollectionMetadataHistoryPage(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return page.run(client, plan.input as Parameters<typeof page.run>[1]);
}
export function executeCollectionMetadataHistoryEntry(client: QueryClient, plan: CollectionMetadataHistorySqlPlan) {
  return read.run(client, plan.input as Parameters<typeof read.run>[1]);
}

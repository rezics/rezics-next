import * as v from 'valibot';
import type { ExactDocument, StudioResult } from './contract';

// Runtime response validation for the generated hosted-catalogue client routes.
export const hostedId = v.pipe(
  v.string(),
  v.regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[78][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/),
);
const nullableId = v.nullable(hostedId);
const title = v.pipe(
  v.string(),
  v.minLength(1),
  v.maxLength(512),
  v.check((value) => [...value].length <= 256),
);
const target = v.strictObject({
  threadId: hostedId,
  postId: hostedId,
  revisionId: hostedId,
  sha256: v.pipe(v.string(), v.regex(/^[0-9a-f]{64}$/)),
});
const address = {
  occurrenceId: hostedId,
  parentId: nullableId,
  position: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(511)),
};
export const hostedPlacement = v.variant('kind', [
  v.strictObject({ ...address, title, kind: v.literal('part') }),
  v.strictObject({ ...address, title, kind: v.literal('chapter'), target }),
]);
const placements = v.pipe(v.array(hostedPlacement), v.maxLength(512));
export const hostedCreate = v.strictObject({ postId: hostedId, threadId: hostedId, placements });
export const hostedRevise = v.strictObject({ expectedRevisionId: hostedId, placements });
export const hostedPublish = v.strictObject({
  expectedRevisionId: hostedId,
  expectedPublicationId: nullableId,
  occurrenceIds: v.pipe(
    v.array(hostedId),
    v.maxLength(512),
    v.check((ids) => new Set(ids).size === ids.length),
  ),
});
export const hostedCommand = v.strictObject({ catalogueId: hostedId, revisionId: hostedId });
const revision = {
  catalogueId: hostedId,
  revisionId: hostedId,
  kind: v.picklist(['structure', 'publication']),
  sourceRevisionId: nullableId,
};
export const hostedRevision = v.strictObject(revision);
export const hostedPage = v.strictObject({
  ...revision,
  items: v.pipe(
    v.array(
      v.union([
        v.strictObject({ ...address, kind: v.picklist(['part', 'chapter']), availability: v.literal('unavailable') }),
        v.strictObject({
          ...address,
          kind: v.literal('part'),
          availability: v.literal('available'),
          title,
          target: v.null(),
        }),
        v.strictObject({ ...address, kind: v.literal('chapter'), availability: v.literal('available'), title, target }),
      ]),
    ),
    v.maxLength(20),
  ),
  nextCursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
/** Author-only metadata: list rendering never needs chapter or document reads. */
export const hostedHistoryRequest = v.strictObject({
  catalogueId: hostedId,
  cursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const hostedHistoryEntry = v.strictObject({
  ...revision,
  createdAt: v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value))),
  ),
  isCurrentDraft: v.boolean(),
  isCurrentRelease: v.boolean(),
});
export const hostedHistoryPage = v.strictObject({
  catalogueId: hostedId,
  items: v.pipe(v.array(hostedHistoryEntry), v.maxLength(20)),
  nextCursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export type HostedHistoryEntry = v.InferOutput<typeof hostedHistoryEntry>;
export type HostedHistoryPage = v.InferOutput<typeof hostedHistoryPage>;

export const hostedSelection = v.strictObject({
  catalogueId: hostedId,
  kind: v.picklist(['structure', 'publication']),
  revisionId: v.optional(hostedId),
});
export const hostedKey = v.pipe(v.string(), v.uuid());
const hostedOwnerBook = v.strictObject({
  catalogueId: hostedId,
  threadId: hostedId,
  createdAt: v.pipe(
    v.string(),
    v.check((value) => Number.isFinite(Date.parse(value))),
  ),
  postRevisionId: hostedId,
  postVisibility: v.picklist(['draft', 'protected', 'published']),
  headRevisionId: hostedId,
  publicationId: nullableId,
});
// Coverage belongs to the native census, never to the number of visible rows.
export const hostedOwnerScope = v.variant('kind', [
  v.strictObject({
    kind: v.literal('same-home'),
    route: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)),
    crossHome: v.literal('unavailable'),
  }),
  v.strictObject({
    kind: v.literal('all-homes'),
    route: v.pipe(v.number(), v.integer(), v.minValue(0), v.maxValue(65535)),
    crossHome: v.picklist(['partial', 'complete']),
  }),
]);
export const hostedOwnerViewer = v.strictObject({
  accountId: hostedId,
  authnEpoch: v.pipe(v.number(), v.integer(), v.minValue(0)),
});
export const hostedOwnerBinding = v.strictObject({ scope: hostedOwnerScope, viewer: hostedOwnerViewer });
export const hostedOwnerInventoryResponse = v.strictObject({
  scope: hostedOwnerScope,
  viewer: hostedOwnerViewer,
  items: v.pipe(v.array(hostedOwnerBook), v.maxLength(20)),
  nextCursor: v.nullable(v.pipe(v.string(), v.minLength(1), v.maxLength(4096))),
});
export const hostedOwnerBookResponse = v.strictObject({
  scope: hostedOwnerScope,
  viewer: hostedOwnerViewer,
  item: hostedOwnerBook,
});
export type HostedTarget = v.InferOutput<typeof target>;
export type HostedPlacement = v.InferOutput<typeof hostedPlacement>;
export type HostedRevision = v.InferOutput<typeof hostedRevision>;
export type HostedSelection = v.InferOutput<typeof hostedSelection>;
export type HostedCreate = v.InferOutput<typeof hostedCreate>;
export type HostedRevise = v.InferOutput<typeof hostedRevise>;
export type HostedPublish = v.InferOutput<typeof hostedPublish>;
export type HostedBook = Readonly<{ revision: HostedRevision; placements: readonly HostedPlacement[] }>;
export type HostedOwnerBook = v.InferOutput<typeof hostedOwnerBook>;
export type HostedOwnerScope = v.InferOutput<typeof hostedOwnerScope>;
export type HostedOwnerViewer = v.InferOutput<typeof hostedOwnerViewer>;
export type HostedOwnerBinding = v.InferOutput<typeof hostedOwnerBinding>;
export type HostedOwnerInventory = v.InferOutput<typeof hostedOwnerInventoryResponse>;
export type HostedOwnedBook = v.InferOutput<typeof hostedOwnerBookResponse>;

/** Expected viewer metadata is a comparison operand, never an authorization credential. */
export function sameHostedViewer(left: HostedOwnerViewer, right: HostedOwnerViewer): boolean {
  return left.accountId === right.accountId && left.authnEpoch === right.authnEpoch;
}

/** Reads admit the complete bounded tree or fail; redacted slots never become editable empty chapters. */
export interface HostedBookNative {
  listHistory(
    catalogueId: string,
    cursor: string | null,
    signal: AbortSignal,
  ): Promise<StudioResult<HostedHistoryPage>>;
  listOwn(
    accountId: string,
    cursor: string | null,
    signal: AbortSignal,
    expected?: HostedOwnerBinding,
  ): Promise<StudioResult<HostedOwnerInventory>>;
  readOwn(
    accountId: string,
    catalogueId: string,
    signal: AbortSignal,
    expectedViewer?: HostedOwnerViewer,
  ): Promise<StudioResult<HostedOwnedBook>>;
  read(input: HostedSelection, signal: AbortSignal): Promise<StudioResult<HostedBook>>;
  create(input: HostedCreate, key: string, signal: AbortSignal): Promise<StudioResult<HostedBook>>;
  revise(catalogueId: string, input: HostedRevise, key: string, signal: AbortSignal): Promise<StudioResult<HostedBook>>;
  publish(
    catalogueId: string,
    input: HostedPublish,
    key: string,
    signal: AbortSignal,
  ): Promise<StudioResult<HostedBook>>;
}

/** Resolve a saved document through the shared document owner, never infer its thread from the book. */
export type HostedTargetResolver = (
  document: ExactDocument,
  signal: AbortSignal,
) => Promise<StudioResult<HostedTarget>>;

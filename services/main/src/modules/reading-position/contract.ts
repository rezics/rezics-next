import { t } from 'elysia';
import { readId, readPosition } from '../work/read-contract.ts';

export const readingPositionQuery = t.Optional(t.Union([readId, t.Literal('all'), t.Literal('mine'), t.Literal('start')]));

/** Lives with the contract, not the store, so schemas can budget revelation reads without importing the store's
 * dependency chain, which reaches the receipt-family loader and cycles back into them. */
export const REVELATION_COST = { batch: 50, lookupSql: 1, requiredSql: 1, writeSql: 1, progressSql: 1, snapshotSql: 1 } as const;

/** Legacy wiki-boundary budgets, retained in the served cost metadata.
 * The chooser uses READING_CHOOSER_COST's bounded seeks; occurrences is not a
 * chooser inventory ceiling. Search and ordering run before each store limit. */
export const READING_POSITION_COST = { occurrences: 10_000, workDepth: 16, workBatch: 50,
  queryBytes: 4 * 1024 * 1024, chooserPage: 100, chooserQueryChars: 200, labels: 16,
  sessionPages: 32, releasePins: 4096,
  /** A chapter lookup (neighbours, first appearance) walks at most this many frames and rows per direction. */
  lookupScanRows: 32 } as const;

/** One side of a chapter lookup. `none` is the end of the reading order; `bound` is the scan window running out. */
export const readingLookupStep = t.Object({
  status: t.Union([t.Literal('found'), t.Literal('none'), t.Literal('bound')]),
  occurrence: t.Optional(readId) }, { description: 'A found occurrence is one of `items`.' });

export const readingPositionPage = t.Object({
  profile: t.Literal('reading-positions-v1'), work: readId, resolved: t.String(),
  scope: t.Optional(t.Union([t.Literal('resume'), t.Literal('positions'), t.Literal('neighbours'), t.Literal('first-appearance')])),
  /** With `around`: the chapters either side of it that the reader may see, in reading order. */
  neighbours: t.Optional(t.Object({ previous: readingLookupStep, next: readingLookupStep,
    reached: t.Boolean({ description: 'The selected position is at or past the chapter.' }) })),
  /** With `firstSeen`: the first chapter the reader may see at or after where the record is revealed. */
  appearance: t.Optional(readingLookupStep),
  visibility: t.Optional(t.Union([t.Literal('visible'), t.Literal('pending'), t.Literal('empty')])),
  items: t.Array(t.Object({ occurrence: readId, work: readId, structure: readId, revision: readId,
    parent: readId, segmentKey: t.String(), orderKey: t.String(),
    role: t.Union([t.Literal('part'), t.Literal('chapter'), t.Literal('group')]),
    target: t.Nullable(t.String()), ordinal: t.Optional(t.Integer({ minimum: 1,
      deprecated: true, description: 'Omitted: physical ordinals can count undisclosed items.' })),
    labels: t.Optional(t.Array(t.Object({ value: t.String(), language: t.String() }), { maxItems: READING_POSITION_COST.labels })),
    displayLabel: t.Optional(t.String()) }), { maxItems: READING_POSITION_COST.chooserPage }),
  nextCursor: t.Nullable(t.String()), complete: t.Boolean(),
  search: t.Optional(t.Object({ status: t.Union([t.Literal('current'), t.Literal('indexing')]) })),
  /** Retained for existing clients; new consumers use nextCursor. */
  next: t.Nullable(t.String()), sourcePosition: readPosition,
  count: t.Object({ value: t.Integer({ minimum: 0 }), kind: t.Union([t.Literal('exact-page'), t.Literal('at-least')]), total: t.Null() }),
  cost: t.Object(Object.fromEntries(Object.entries(READING_POSITION_COST).map(([key, value]) => [key, t.Literal(value)]))),
});

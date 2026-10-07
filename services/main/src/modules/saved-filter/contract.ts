import { t } from 'elysia';
import type { Static } from 'typebox';
import type { ResourceQuery } from '../../../../../model/definitions/filter-document-v2.ts';
import { readId, readName, readUuid } from '../work/read-contract.ts';

/**
 * A reader's Saved Filters (docs/contracts/queries.md). A followed Concept adds
 * one filter, which the follow inventory bounds. Filters the reader names are
 * bounded by the principal write rate limit, not a stored count. At most eight
 * are pinned as Home tabs. A list reads one inventory row and at most one page
 * on the listing index: pinned positions, then newer unpinned rows. The page
 * is one summary batch, so naming that page's Concepts is one summary read.
 * Every command locks one inventory row and touches at most the eight pinned
 * rows. A stored document holds at most 32 nodes (the Filter admission's
 * bound) in 8 KiB; executing it never enlarges the executing template's budget.
 */
export const SAVED_FILTER_COST = {
  pinned: 8,
  /** One list page, equal to the resource-summary batch (`SUMMARY_PAGE_COST.batch`). */
  page: 64,
  /** One inventory share, plus at most two listing-index ranges (pinned or same-timestamp, then older unpinned). */
  listReads: 3,
  cursor: 256,
  documentBytes: 8192,
} as const;

const closed = { additionalProperties: false } as const;
/** Saved Filters persist as filter-document-v2 Filters; the Filter group itself is unchanged from v1. */
export const SAVED_FILTER_PROFILE = 'filter-document-v2' as const satisfies ResourceQuery['profile'];
/** A reader's own name for a filter: trimmed, printable, 1–80 characters. */
export const savedFilterName = t.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });

export const savedFilterItem = t.Object({ id: readUuid,
  /** The reader's name; null for a followed Concept's filter they have not renamed. */
  name: t.Nullable(t.String()),
  /** The followed Concept this filter is the one-Condition Filter of, and its label in the requested language. */
  concept: t.Nullable(t.Object({ id: readId, name: t.Nullable(readName) })),
  /** The Query definition revision the Filter was admitted under (model/definitions/filter-document-v2.ts). */
  profile: t.Literal(SAVED_FILTER_PROFILE),
  /** The Filter with exact Facet DefinitionRefs, as that revision's `filter` field holds it. */
  filter: t.Unknown(), facets: t.Array(t.String(), { maxItems: 32 }), context: t.Literal('global'),
  /** Home tab position after Following and All; null when not pinned. */
  position: t.Nullable(t.Integer({ minimum: 0, maximum: SAVED_FILTER_COST.pinned - 1 })),
  /** Whether Home's feed can show this filter's posts; only such a filter can be pinned. */
  home: t.Union([t.Literal('available'), t.Literal('unsupported')]),
  revision: readUuid });
export type SavedFilterItem = Static<typeof savedFilterItem>;
const savedFilterCursor = t.String({ minLength: 1, maxLength: SAVED_FILTER_COST.cursor });
export const savedFiltersPage = t.Object({ profile: t.Literal('saved-filters-v1'),
  /** The inventory revision a reorder names; null before the reader has any filter. */
  revision: t.Nullable(readUuid),
  items: t.Array(savedFilterItem, { maxItems: SAVED_FILTER_COST.page }),
  /** Pass as `cursor` to read the next page. Null on the last page. Pinned filters come first. */
  cursor: t.Nullable(savedFilterCursor),
  /** False when `cursor` continues the inventory. */
  complete: t.Boolean() });
export const savedFiltersQuery = t.Object({ actingSubject: readId,
  language: t.Optional(t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 })),
  cursor: t.Optional(savedFilterCursor) }, closed);

export const savedFilterCreate = t.Object({ profile: t.Literal('saved-filter-create-v1'), actingSubject: readId,
  name: savedFilterName, filter: t.Unknown(), context: t.Literal('global'), pinned: t.Boolean() }, closed);
export type SavedFilterCreate = Static<typeof savedFilterCreate>;
/** Rename (null restores a followed Concept's own label), pin or unpin one filter. */
export const savedFilterUpdate = t.Object({ profile: t.Literal('saved-filter-update-v1'), actingSubject: readId,
  expectedRevision: readUuid, name: t.Optional(t.Nullable(savedFilterName)), pinned: t.Optional(t.Boolean()) },
closed);
export type SavedFilterUpdate = Static<typeof savedFilterUpdate>;
/** The pinned filters in their new order: exactly the pinned set the inventory revision names. */
export const savedFilterOrder = t.Object({ profile: t.Literal('saved-filter-order-v1'), actingSubject: readId,
  expectedRevision: readUuid, pinned: t.Array(readUuid, { maxItems: SAVED_FILTER_COST.pinned, uniqueItems: true }) },
closed);
export type SavedFilterOrder = Static<typeof savedFilterOrder>;
export const savedFilterDelete = t.Object({ actingSubject: readId, expectedRevision: readUuid }, closed);
export type SavedFilterDelete = Static<typeof savedFilterDelete>;
export const savedFilterReceipt = t.Object({ profile: t.Literal('saved-filter-receipt-v1'),
  action: t.Union([t.Literal('created'), t.Literal('updated'), t.Literal('reordered'), t.Literal('deleted')]),
  id: t.Nullable(readUuid), filterRevision: t.Nullable(readUuid),
  /** The inventory revision after the command. */
  revision: readUuid, replayed: t.Boolean() });
export type SavedFilterReceipt = Static<typeof savedFilterReceipt>;

import { t } from 'elysia';
import type { Static } from 'typebox';
import { readId, readName, readUuid } from '../work/read-contract.ts';

/**
 * A reader's Saved Filters (docs/contracts/queries.md): at most 50 they name,
 * plus one per followed Concept, which the follow inventory bounds. At most
 * eight are pinned as Home tabs. A list reads one inventory row and at most
 * 100 filters on one index, with one summary batch naming followed Concepts.
 * Every command locks one inventory row and touches at most the eight pinned
 * rows. A stored document holds at most 32 nodes (the Filter admission's
 * bound) in 8 KiB; executing it never enlarges the executing template's budget.
 */
export const SAVED_FILTER_COST = { named: 50, pinned: 8, listed: 100, documentBytes: 8192 } as const;

const closed = { additionalProperties: false } as const;
/** A reader's own name for a filter: trimmed, printable, 1–80 characters. */
export const savedFilterName = t.String({ minLength: 1, maxLength: 80, pattern: '^[^\\u0000-\\u001f\\u007f]+$' });

export const savedFilterItem = t.Object({ id: readUuid,
  /** The reader's name; null for a followed Concept's filter they have not renamed. */
  name: t.Nullable(t.String()),
  /** The followed Concept this filter is the one-Condition Filter of, and its label in the requested language. */
  concept: t.Nullable(t.Object({ id: readId, name: t.Nullable(readName) })),
  /** The FilterDocument with exact Facet DefinitionRefs (model/definitions/filter-document-v1.ts). */
  filter: t.Unknown(), facets: t.Array(t.String(), { maxItems: 32 }), context: t.Literal('global'),
  /** Home tab position after Following and All; null when not pinned. */
  position: t.Nullable(t.Integer({ minimum: 0, maximum: SAVED_FILTER_COST.pinned - 1 })),
  /** Whether Home's feed can show this filter's posts; only such a filter can be pinned. */
  home: t.Union([t.Literal('available'), t.Literal('unsupported')]),
  revision: readUuid });
export type SavedFilterItem = Static<typeof savedFilterItem>;
export const savedFiltersPage = t.Object({ profile: t.Literal('saved-filters-v1'),
  /** The inventory revision a reorder names; null before the reader has any filter. */
  revision: t.Nullable(readUuid),
  items: t.Array(savedFilterItem, { maxItems: SAVED_FILTER_COST.listed }),
  /** False when more filters exist than one list reads; pinned filters always come first. */
  complete: t.Boolean() });
export const savedFiltersQuery = t.Object({ actingSubject: readId,
  language: t.Optional(t.String({ pattern: '^[a-z]{2,3}(-[A-Za-z0-9]{1,8})*$', maxLength: 35 })) }, closed);

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

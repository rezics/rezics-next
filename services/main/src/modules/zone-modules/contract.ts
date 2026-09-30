import { t } from 'elysia';
import { pageFields, pageQuery, readAvatar, readId, readName, readPosition, readUuid, workCard }
  from '../work/read-contract.ts';
import { realmDecision } from '../realm-reads/read-contract.ts';
import { discoveryCredit } from '../discovery/contract.ts';
export const zoneHubCard = t.Object({ profile: t.Literal('hub-work-card-v1'),
  kind: t.Union([t.Literal('prompt'), t.Literal('skill-package')]),
  declaredModels: t.Array(t.String(), { maxItems: 64 }), testedModels: t.Array(t.String(), { maxItems: 64 }),
  preview: t.String({ maxLength: 240 }), copyText: t.String({ maxLength: 65_536 }) });

export const ZONE_MODULE_COST = { pageSize: 20, candidateRows: 21, typeRows: 160, creditsPerWork: 3,
  serialHeads: 20, summaryBatches: 2, chapterLabelRows: 160, chapterTimeBatches: 1, replyReviewChecks: 40, contentRevisions: 20,
  contentBytes: 20 * 1_048_576, creditQueries: 20, retainedAuthorKeys: 60,
  graphCalls: 160, graphBytes: 4 * 1024 * 1024,
  deadlineMs: 10_000 } as const;

export const zoneWork = t.Object({ ...workCard.properties,
  primaryCredits: t.Array(discoveryCredit, { maxItems: ZONE_MODULE_COST.creditsPerWork }), evidence: readId,
  dataEpoch: t.String(), sequence: t.String(),
  hub: t.Nullable(zoneHubCard) });
export const zoneWorkPage = t.Object({ profile: t.Union([
  t.Literal('zone-new-adoptions-v1'), t.Literal('zone-recently-completed-v1')]),
  realm: readId, items: t.Array(zoneWork, { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneDecisionPage = t.Object({ profile: t.Literal('zone-recent-decisions-v1'), realm: readId,
  items: t.Array(realmDecision, { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields,
  summary: t.Object({ adoption: t.Integer({ minimum: 0 }), classification: t.Integer({ minimum: 0 }),
    semanticRuleChange: t.Integer({ minimum: 0 }), basis: t.Literal('exact-page') }) });
export const zoneChapterPage = t.Object({ profile: t.Literal('zone-latest-chapters-v1'), realm: readId,
  items: t.Array(t.Object({ work: t.Object({ ...workCard.properties,
    primaryCredits: t.Array(discoveryCredit, { maxItems: ZONE_MODULE_COST.creditsPerWork }) }), chapter: readId,
    /** The chapter's title as the Book's contents label it, in the requested language; null when unlabelled. */
    chapterTitle: t.Nullable(readName),
    /** When the Content owner recorded this publication; null when Main cannot read its receipt. */
    chapterUpdatedAt: t.Nullable(t.String({ format: 'date-time' })), publication: readId,
    contentRevision: t.String(), language: t.String(), dataEpoch: t.String(), sequence: t.String() }),
  { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneReplyPage = t.Object({ profile: t.Union([
  t.Literal('zone-discussions-v1'), t.Literal('zone-reader-quotes-v1')]), realm: readId,
  items: t.Array(t.Object({ id: readId, placement: readId, author: readId, authorName: t.String(),
    work: t.Object({ id: readId, title: readName }),
    excerpt: t.String({ maxLength: 240 }), dataEpoch: t.String(), sequence: t.String() }),
  { maxItems: ZONE_MODULE_COST.pageSize }), ...pageFields });
export const zoneGenrePage = t.Object({ profile: t.Literal('zone-genres-v1'),
  realm: readId, context: readId, generation: readUuid, stale: t.Boolean(), projectionPosition: readPosition,
  items: t.Array(t.Object({ id: readId, concept: readId, name: readName,
    workCount: t.Nullable(t.Integer({ minimum: 0, maximum: Number.MAX_SAFE_INTEGER })) }),
  { maxItems: ZONE_MODULE_COST.pageSize }),
  ...pageFields });
export const zoneEditorLists = t.Object({ profile: t.Literal('zone-editor-lists-v1'),
  realm: readId, lists: t.Array(t.Object({ collection: readId, name: readName,
    state: t.Union([t.Literal('complete'), t.Literal('partial')]),
    items: t.Array(t.Object({ id: readId, title: readName, cover: readAvatar }), { maxItems: 8 }) }),
  { maxItems: 2 }), sourcePosition: readPosition });

/**
 * A Zone browse page reads the Realm's newest adoptions as one window, filters
 * and sorts it in memory and hydrates one page. `windowRows` stays within one
 * summary batch (64); Zones larger than the window report lower-bound matches.
 */
export const ZONE_BROWSE_COST = { windowRows: 60, pageSize: ZONE_MODULE_COST.pageSize, typeRows: 240,
  summaryBatches: 3, serialStatBatches: 2, serialSummaryBatches: 1, tagBatches: 1,
  creditQueries: ZONE_MODULE_COST.pageSize, filterValues: 8, textCharacters: 100 } as const;
export const zoneBrowseSorts = ['relevance', 'newest', 'updated'] as const;
export type ZoneBrowseSort = (typeof zoneBrowseSorts)[number];
/** Word-count buckets, each `min-max` inclusive or open-ended; Conditions use arbitrary ranges. */
export const zoneLengthBands = ['0-99999', '100000-299999', '300000-999999', '1000000-'] as const;
/** A Work type IRI; the read admits only `WORK_SEMANTIC_TYPES` (a literal union types as never through Eden). */
const workType = t.String({ pattern: '^https://[!-~]{1,200}$' });
const status = t.String();
const many = { minItems: 1, maxItems: ZONE_BROWSE_COST.filterValues, uniqueItems: true } as const;
const sortValue = t.Union([t.Literal('relevance'), t.Literal('newest'), t.Literal('updated')]);
/** Conditions as query parameters: values within a Facet match any, Facets match all. */
export const zoneBrowseQuery = t.Object({ language: pageQuery.language, limit: pageQuery.limit,
  cursor: pageQuery.cursor, q: t.Optional(t.String({ minLength: 1, maxLength: ZONE_BROWSE_COST.textCharacters })),
  sort: t.Optional(sortValue),
  type: t.Optional(t.Array(workType, many)), concept: t.Optional(t.Array(readId, many)),
  excludeConcept: t.Optional(t.Array(readId, many)),
  status: t.Optional(t.Array(status, many)),
  length: t.Optional(t.String({ pattern: '^(0|[1-9][0-9]{0,15})?-([1-9][0-9]{0,15}|0)?$' })),
}, { additionalProperties: false });
const included = t.Object({ facet: t.Union([t.Literal('type'), t.Literal('concept'), t.Literal('status')]),
  any: t.Array(t.String(), many) });
const excluded = t.Object({ facet: t.Union([t.Literal('concept'), t.Literal('status')]),
  none: t.Array(t.String(), many) });
const condition = t.Union([included, excluded, t.Object({ facet: t.Literal('length'),
  range: t.Object({ min: t.Optional(t.String()), max: t.Optional(t.String()) }) })]);
const facetValues = t.Array(t.Object({ value: t.String(), count: t.Integer({ minimum: 0 }),
  /** A Concept's name in the requested language; other values are labelled by the client's Facet vocabulary. */
  name: t.Optional(readName) }), { maxItems: ZONE_BROWSE_COST.windowRows });
export const zoneBrowsePage = t.Object({ profile: t.Literal('zone-browse-v1'), realm: readId,
  /** The Query as Main applied it: text, sort and the Filter in FilterDocument form. */
  query: t.Object({ text: t.Nullable(t.String()), sort: sortValue,
    filter: t.Object({ all: t.Array(condition, { maxItems: 6 }) }) }),
  /** How many of the window's Works each value would match, with the other Facets' Conditions applied. */
  facets: t.Object({ type: facetValues, concept: facetValues, status: facetValues, length: facetValues }),
  /**
   * Tags come from the Realm's Discovery projection: `current`, `stale` (built
   * before the latest change; Works filtered by Tags are withheld until it catches
   * up, as Discover withholds them) or `unavailable`.
   */
  tags: t.Union([t.Literal('current'), t.Literal('stale'), t.Literal('unavailable')]),
  matches: t.Object({ value: t.Integer({ minimum: 0 }),
    kind: t.Union([t.Literal('exact'), t.Literal('lower-bound')]) }),
  /** The newest adoptions read; `complete` when the Realm has no older ones. */
  window: t.Object({ scanned: t.Integer({ minimum: 0, maximum: ZONE_BROWSE_COST.windowRows }), complete: t.Boolean() }),
  items: t.Array(zoneWork, { maxItems: ZONE_BROWSE_COST.pageSize }), ...pageFields });

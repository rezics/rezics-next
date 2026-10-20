import { cache } from 'react';
import type { DiscussionPage, Loaded, RatingContextPage, RatingRead, RatingSummary, ReviewPage } from '../work-page/types.ts';
import { readLinkedStatements, readResourcePage } from '../work-page/anime-hub-recorded-page.ts';
import { reader, settle, type SuppliedClient } from '../work-page/read.ts';
import { followHref } from './href.ts';
import type { EntityProjection, EntitySection, RelationsPage, StatementPage } from './types.ts';
import type { AvailableSummary } from '../work-levels/types.ts';

// Server reads for the generic resource page. Each returns a `Loaded` result so
// one section's failure never takes down another, and every section read
// follows the link the projection gave it.

/** Select the admitted resource grain before requesting a page capability.
 * Collections own their members read, not the generic discussion target page. */
export const readEntityEntry = cache(async (id: string, position?: string, client?: SuppliedClient):
  Promise<Loaded<AvailableSummary>> => {
  const current = client ?? await reader();
  if ('identityUnavailable' in current && current.identityUnavailable)
    return { ok: false, failure: 'identity', status: 503 };
  const { main, actingSubject } = current;
  const reference = id.startsWith('https://rezics.com/id/') ? id : `https://rezics.com/id/${id}`;
  const read = await settle(() => main.v1.resources.summaries.post({ profile: 'resource-summary-batch-v1',
    resources: [reference],
    actingSubject, ...(position ? { position } : {}) }));
  if (!read.ok) return read;
  const summary = read.data.summaries[0];
  return summary?.status === 'available' ? { ok: true, data: summary } : { ok: false, failure: 'missing' };
});

/**
 * `entity-page-v1` for a resource, once per request; a hidden and a missing resource answer alike (`missing`).
 * `position` is the reading position Main withholds later records for (G-847); omitted, Main chooses for the reader.
 */
export const readEntityProjection = cache(async (id: string, position?: string, client?: SuppliedClient): Promise<Loaded<EntityProjection>> => {
  const { main, actingSubject } = client ?? await reader();
  return readResourcePage(main, actingSubject, id, position);
});

export function sectionOf(page: EntityProjection, id: EntitySection['id']): EntitySection | undefined {
  return page.sections.find(section => section.id === id);
}

/**
 * A page of accepted statements about the resource, in the reader's Context. `frame` restricts it to what holds within those
 * coordinates (a continuity the reader chose): Main decides what is covered, the browser never filters.
 */
export const readStatements = cache(async (section: EntitySection, cursor: string | undefined, position?: string,
  frame?: readonly string[], client?: SuppliedClient): Promise<Loaded<StatementPage>> => {
  const { main, actingSubject } = client ?? await reader();
  return readLinkedStatements(main, actingSubject, section.href, { cursor, position, frame });
});

/**
 * A page of relation occurrences where the resource takes any role. Relations are public data: an anonymous
 * reader, or one signed in without an acting Agent, reads them as anyone does.
 */
export async function readRelations(section: EntitySection, cursor: string | undefined, position?: string,
  frame?: readonly string[], client?: SuppliedClient): Promise<Loaded<RelationsPage>> {
  const { main, actingSubject } = client ?? await reader();
  return settle(followHref<RelationsPage>(main, section.href,
    { actingSubject, after: cursor, limit: 20, position, ...frame?.length ? { frame: [...frame] } : {} }), cursor);
}

/** Reviewed replies placed in public Realms about the resource, newest first. */
export async function readDiscussion(section: EntitySection, cursor: string | undefined, client?: SuppliedClient): Promise<Loaded<DiscussionPage>> {
  const { main, actingSubject } = client ?? await reader();
  return settle(followHref<DiscussionPage>(main, section.href, { actingSubject, cursor }), cursor);
}

/**
 * Everyone's first rating question for the resource and its summary. The
 * projection links the summary; its questions are the sibling read the same
 * owner serves beside it.
 */
export const readRatings = cache(async (section: EntitySection): Promise<Loaded<RatingRead>> => {
  const { main, actingSubject } = await reader();
  const contexts = await settle(followHref<RatingContextPage>(main,
    section.href.replace(/\/ratings$/, '/rating-contexts'), { actingSubject }));
  if (!contexts.ok) return contexts;
  const context = contexts.data.items[0] ?? null;
  const summary = await settle(followHref<RatingSummary>(main, section.href,
    { actingSubject, context: context?.context }));
  return summary.ok ? { ok: true, data: { contexts: contexts.data.items, context, summary: summary.data } } : summary;
});

/** The first page of reviews answering one rating question, most helpful first. */
export async function readReviews(section: EntitySection, context: string): Promise<Loaded<ReviewPage>> {
  const { main, actingSubject } = await reader();
  return settle(followHref<ReviewPage>(main, section.href,
    { actingSubject, context, sort: 'helpful', limit: 10 }));
}

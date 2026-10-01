import { cache } from 'react';
import type { DiscussionPage, Loaded, RatingContextPage, RatingRead, RatingSummary, ReviewPage } from '../work-page/types.ts';
import { reader, settle } from '../work-page/read.ts';
import { followHref } from './href.ts';
import type { EntityProjection, EntitySection, RelationsPage, StatementPage } from './types.ts';

// Server reads for the generic resource page. Each returns a `Loaded` result so
// one section's failure never takes down another, and every section read
// follows the link the projection gave it.

/** `entity-page-v1` for a resource, once per request; a hidden and a missing resource answer alike (`missing`). */
export const readEntityProjection = cache(async (id: string): Promise<Loaded<EntityProjection>> => {
  const { main, actingSubject } = await reader();
  return settle(() => main.v1.resources({ resource: id }).page.get({ query: { actingSubject } }));
});

export function sectionOf(page: EntityProjection, id: EntitySection['id']): EntitySection | undefined {
  return page.sections.find(section => section.id === id);
}

/** A page of accepted statements about the resource, in the reader's Context. */
export async function readStatements(section: EntitySection, cursor: string | undefined): Promise<Loaded<StatementPage>> {
  const { main, actingSubject } = await reader();
  return settle(followHref<StatementPage>(main, section.href, { actingSubject, cursor }), cursor);
}

/**
 * A page of relation occurrences where the resource takes any role. Relations are public data: an anonymous
 * reader, or one signed in without an acting Agent, reads them as anyone does.
 */
export async function readRelations(section: EntitySection, cursor: string | undefined): Promise<Loaded<RelationsPage>> {
  const { main, actingSubject } = await reader();
  return settle(followHref<RelationsPage>(main, section.href, { actingSubject, after: cursor, limit: 20 }), cursor);
}

/** Reviewed replies placed in public Realms about the resource, newest first. */
export async function readDiscussion(section: EntitySection, cursor: string | undefined): Promise<Loaded<DiscussionPage>> {
  const { main, actingSubject } = await reader();
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

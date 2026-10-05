import { entryLabel } from '../catalogue/types.ts';
import { namesOf } from '../work-levels/read.ts';
import { readRealm, readReviewer } from '../work-page/read.ts';
import { TargetRatingsRegion } from '../work-page/ratings.tsx';
import { ReviewsSection } from '../work-page/reviews.tsx';
import { idOf } from '../work-page/route.ts';
import type { Reviewer } from '../work-page/types.ts';
import { inSentence } from './messages.ts';
import { readDiscussion, readRatings, readRelations, readReviews, readStatements } from './read.ts';
import type { EntityProjection, EntitySection } from './types.ts';
import { DiscussionView, RelationsView, type SectionProps, StatementsView } from './views.tsx';
import { ProjectionFactsView } from './projection-views.tsx';
import { readIdentityDefinitions } from './identity-read.ts';
import { readPredicateLabels } from './predicate-labels.ts';

// The sections' server halves: each reads from the link the projection gave it, names what it lists, and hands
// the answer to the view of the same name (views.tsx), which stories and tests draw without Main.

export async function StatementsSection({ section, cursor, position, frame, projection = false, ownName, ...rest }: SectionProps
  & { cursor: string | undefined; ownName?: string; position?: string; frame?: readonly string[];
    /** A place's facts: those covered by its coordinates, most specific first, each saying how far it reaches. */
    projection?: boolean }) {
  const page = await readStatements(section, cursor, position, frame);
  const labels = page.ok ? await readPredicateLabels(page.data, rest.locale) : new Map();
  // Values and the continuities a statement holds in are named together, so one read names both.
  const names = page.ok ? await namesOf(page.data.groups.flatMap(group => group.items.flatMap(item => [
    ...item.kind === 'statement' && item.value.kind === 'resource' ? [item.value.iri] : [],
    // An owner's own property can name a resource too (the Work a character belongs to).
    ...item.kind === 'component-property' && item.value.kind === 'resource' && typeof item.value.ref === 'string' ? [item.value.ref] : [],
    ...item.qualifiers.applicability]))) : new Map();
  return projection
    ? <ProjectionFactsView page={page} labels={labels} names={names} ownName={ownName} cursor={cursor} hrefFor={rest.hrefFor} t={rest.t} messages={rest.messages} />
    : <StatementsView page={page} labels={labels} names={names} ownName={ownName} cursor={cursor} hrefFor={rest.hrefFor} t={rest.t}
      messages={rest.messages} />;
}


export async function RelationsSection({ section, cursor, position, frame, hideIdentity = false, ...rest }: SectionProps
  & { cursor: string | undefined; position?: string; frame?: readonly string[]; hideIdentity?: boolean }) {
  let page = await readRelations(section, cursor, position, frame);
  if (hideIdentity && page.ok) {
    const definitions = await readIdentityDefinitions();
    if (definitions.ok) {
      const own = new Set(definitions.data.values());
      page = { ok: true, data: { ...page.data, items: page.data.items.filter(item => !item.rendering || !own.has(item.rendering.meaning.definition)) } };
      if (!page.data.items.length && !page.data.next && !cursor) return null;
    }
  }
  return <RelationsView page={page} cursor={cursor} hrefFor={rest.hrefFor}
    locale={rest.locale} t={rest.t} messages={rest.messages} />;
}


export async function DiscussionSection({ section, cursor, resource, registry, signedIn, preview, anchor, noun, ...rest }: SectionProps & {
  anchor?: string;
  /** What the resource is called in a sentence, where the type registry's word is not one a reader knows (a place). */
  noun?: string;
  cursor: string | undefined; resource: string; registry: EntityProjection['registry']; signedIn: boolean;
  /** Show only the first few replies and no paging, for a host that links to the full list (the Work hub). */
  preview?: number;
}) {
  const read = await readDiscussion(section, cursor);
  const page = preview !== undefined && read.ok
    ? { ok: true as const, data: { ...read.data, items: read.data.items.slice(0, preview), nextCursor: null } } : read;
  const ids = page.ok ? [...new Set(page.data.items.flatMap(item => idOf(item.realm) ?? []))] : [];
  const realms = new Map(await Promise.all(ids.map(async realm => {
    const header = await readRealm(realm, rest.locale);
    return [realm, header.ok ? header.data.name : null] as const;
  })));
  return <DiscussionView page={page} realms={realms} cursor={cursor} resource={resource} anchor={anchor}
    subject={noun ?? inSentence(entryLabel(registry, rest.locale), rest.locale)} signedIn={signedIn} hrefFor={rest.hrefFor}
    locale={rest.locale} t={rest.t} messages={rest.messages} />;
}

/** Everyone's ratings of the resource, named by what it is ("Ratings for this release"). */
export async function RatingsSection({ section, registry, locale, t, messages }: SectionProps & {
  registry: EntityProjection['registry'];
}) {
  const subject = t.ratingsFor({ subject: inSentence(entryLabel(registry, locale), locale) });
  return <TargetRatingsRegion ratings={await readRatings(section)} subject={subject} none={t.noRatings}
    locale={locale} messages={messages} />;
}

/** The first page of reviews, which the reader's browser continues from the same link. Nothing writes until the resource has its own rating question. */
export async function ReviewsSectionOf({ section, resource, registry, actingSubject, ratings, noun, locale, t, messages }:
  SectionProps & { resource: string; registry: EntityProjection['registry']; actingSubject: string | null;
    ratings: EntitySection | undefined; noun?: string }) {
  const questions = ratings ? await readRatings(ratings) : null;
  const question = questions?.ok ? questions.data.context : null;
  if (!question) return null;
  const initial = await readReviews(section, question.context);
  const authors = initial.ok ? [...new Set(initial.data.items.map(review => review.author))] : [];
  const named = await Promise.all(authors.map(async author => [author, await readReviewer(author)] as const));
  return <ReviewsSection target={resource} href={section.href} context={question.context} scale={question.scale.max}
    initial={initial} reviewers={Object.fromEntries(named.filter((entry): entry is [string, Reviewer] => entry[1] !== null))}
    viewer={actingSubject ? { kind: 'reader', actingSubject, canWrite: false } : { kind: 'read-only' }}
    subject={t.reviewsFor({ subject: noun ?? inSentence(entryLabel(registry, locale), locale) })}
    locale={locale} messages={messages} />;
}

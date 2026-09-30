import { buttonVariants } from '@rezics/ui/button';
import { LocalizedText } from '@rezics/ui/localized-text';
import { ListTreeIcon, MessagesSquareIcon, NetworkIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { signInPath } from '../auth/paths.ts';
import { entryLabel } from '../catalogue/types.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { RelationRows } from '../work-levels/connections.tsx';
import { copyOf as levelsCopy } from '../work-levels/messages.ts';
import { SummaryLink, type SummaryHref } from '../work-levels/names.tsx';
import type { Names } from '../work-levels/types.ts';
import { namesOf } from '../work-levels/read.ts';
import { franchisesOf, relationRows } from '../work-levels/relation-rows.ts';
import { DiscussionList } from '../work-page/discussion.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { readRealm, readReviewer } from '../work-page/read.ts';
import { realmLabel, type ScopeRealm } from '../work-page/scope-bar.tsx';
import { TargetRatingsRegion } from '../work-page/ratings.tsx';
import { Region, RegionFailure } from '../work-page/region.tsx';
import { idOf } from '../work-page/route.ts';
import { ReviewsSection } from '../work-page/reviews.tsx';
import type { DiscussionPage, Loaded, Reviewer } from '../work-page/types.ts';
import { type Copy, inSentence } from './messages.ts';
import { readDiscussion, readRatings, readRelations, readReviews, readStatements } from './read.ts';
import type { EntityProjection, EntitySection, HrefFor, RelationsPage, StatementItem, StatementPage } from './types.ts';

/** What every section needs to draw itself: its link, the address map and the words. */
export interface SectionProps {
  section: EntitySection; hrefFor: HrefFor; locale: UiLocale; t: Copy; messages: WorkPageMessages;
}

const link = 'rounded-sm font-medium outline-none decoration-1 underline-offset-4 hover:underline '
  + 'focus-visible:ring-2 focus-visible:ring-ring';
const outline = buttonVariants({ variant: 'outline', size: 'sm' });

/** A summary's page under the caller's address map. */
export const summaryHref = (hrefFor: HrefFor): SummaryHref => summary =>
  hrefFor({ kind: 'resource', iri: summary.reference, base: summary.base, type: summary.type });

/** The last word of a predicate's IRI: what Main recorded, since the relation lexicon's labels are another owner's. */
const localName = (iri: string) => iri.split(/[#/]/).filter(Boolean).at(-1) ?? iri;

function Pages({ cursor, next, section, hrefFor, messages }: {
  cursor: string | undefined; next: string | null; section: EntitySection['id']; hrefFor: HrefFor;
  messages: WorkPageMessages;
}) {
  if (!cursor && !next) return null;
  return <nav aria-label={messages.pagination} className="flex flex-wrap justify-between gap-2">
    {cursor ? <Link href={hrefFor({ kind: 'continue', section, cursor: null })} className={outline}>
      {messages.firstPage}</Link> : <span />}
    {next ? <Link href={hrefFor({ kind: 'continue', section, cursor: next })} className={outline}>
      {messages.nextPage}</Link> : null}
  </nav>;
}

function Value({ item, names, hrefFor, t }: {
  item: StatementItem; names: Names; hrefFor: HrefFor; t: Copy;
}) {
  if (item.kind === 'component-property') {
    return <code className="break-all text-sm">{JSON.stringify(item.value)}</code>;
  }
  const value = item.value;
  if (value.kind === 'some-value') return <span className="text-muted-foreground">{t.valueSome}</span>;
  if (value.kind === 'no-value') return <span className="text-muted-foreground">{t.valueNone}</span>;
  if (value.kind === 'literal') {
    return <span lang={value.language ?? undefined} dir="auto" className="break-words">{value.lexical}</span>;
  }
  return <SummaryLink summary={names.get(value.iri)} unavailable={t.unavailable} unnamed={t.unnamed}
    hrefFor={summaryHref(hrefFor)} />;
}

/** Accepted statements about the resource, grouped by predicate, continuing by Main's cursor. */
export function StatementsView({ page, names, cursor, hrefFor, t, messages }: {
  page: Loaded<StatementPage>; names: Names; cursor: string | undefined; hrefFor: HrefFor; t: Copy;
  messages: WorkPageMessages;
}) {
  if (!page.ok) {
    return <Region id="statements" title={t.statements}>
      <RegionFailure title={t.statementsUnavailable} failure={page.failure} messages={messages}
        restartHref={hrefFor({ kind: 'continue', section: 'statements', cursor: null })} /></Region>;
  }
  const { groups, nextCursor } = page.data;
  return <Region id="statements" title={t.statements}>
    {groups.length ? <div aria-label={t.statementsList} className="grid gap-5">
      {groups.map(group => <div key={group.predicate} data-statement-group
        className="grid gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4">
        <h3 className="break-words font-medium text-muted-foreground text-sm" title={group.predicate}>
          <bdi>{localName(group.predicate)}</bdi></h3>
        <ul className="grid min-w-0 gap-1">
          {group.items.map((item, index) => <li key={`${item.revision}-${index}`} className="min-w-0">
            <Value item={item} names={names} hrefFor={hrefFor} t={t} /></li>)}
        </ul>
      </div>)}
    </div> : <EmptyState icon={ListTreeIcon} headingLevel={3} title={t.noStatements} description={t.noStatementsBody} />}
    <Pages cursor={cursor} next={nextCursor} section="statements" hrefFor={hrefFor} messages={messages} />
  </Region>;
}

export async function StatementsSection({ section, cursor, ...rest }: SectionProps & { cursor: string | undefined }) {
  const page = await readStatements(section, cursor);
  const names = page.ok ? await namesOf(page.data.groups.flatMap(group => group.items.flatMap(item =>
    item.kind === 'statement' && item.value.kind === 'resource' ? [item.value.iri] : []))) : new Map();
  return <StatementsView page={page} names={names} cursor={cursor} hrefFor={rest.hrefFor} t={rest.t}
    messages={rest.messages} />;
}

/**
 * Relation occurrences where the resource takes any role. The rows are Main's
 * own rendering (labels in the reader's language, counterparts named by Main);
 * an anonymous reader has no acting Agent to ask as and is told so.
 */
export function RelationsView({ page, cursor, hrefFor, locale, t, messages }: {
  page: Loaded<RelationsPage>; cursor: string | undefined; hrefFor: HrefFor; locale: UiLocale; t: Copy;
  messages: WorkPageMessages;
}) {
  if (!page.ok) {
    const needs = page.failure === 'sign-in' || page.failure === 'identity';
    return <Region id="relations" title={t.relations}>
      {needs ? <EmptyState icon={NetworkIcon} headingLevel={3} title={page.failure === 'sign-in' ? t.relationsSignIn
        : t.relationsIdentity}>
        {page.failure === 'sign-in' ? <Link href={signInPath(localizedPath(hrefFor({ kind: 'continue',
          section: 'relations', cursor: cursor ?? null }), locale))} className={buttonVariants({ size: 'sm' })}>
          {messages.signIn}</Link> : null}</EmptyState>
        : <RegionFailure title={t.relationsUnavailable} failure={page.failure} messages={messages}
          restartHref={hrefFor({ kind: 'continue', section: 'relations', cursor: null })} />}
    </Region>;
  }
  const rows = relationRows(page.data.items);
  const franchises = franchisesOf(page.data.items);
  const levels = levelsCopy(locale);
  return <Region id="relations" title={t.relations}>
    {rows.length || franchises.length ? <div className="grid gap-5">
      {franchises.length ? <div className="grid gap-1 sm:grid-cols-[minmax(9rem,14rem)_1fr] sm:gap-4">
        <h3 className="font-medium text-muted-foreground text-sm">{levels.franchises}</h3>
        <ul className="grid gap-1">{franchises.map(summary => <li key={summary.reference}>
          <SummaryLink summary={summary} unavailable={t.unavailable} unnamed={t.unnamed}
            hrefFor={summaryHref(hrefFor)} /></li>)}</ul>
      </div> : null}
      <RelationRows rows={rows} locale={locale} t={levels} hrefFor={summaryHref(hrefFor)} />
    </div> : <EmptyState icon={NetworkIcon} headingLevel={3} title={t.noRelations} description={t.noRelationsBody} />}
    <Pages cursor={cursor} next={page.data.next} section="relations" hrefFor={hrefFor} messages={messages} />
  </Region>;
}

export async function RelationsSection({ section, cursor, ...rest }: SectionProps & { cursor: string | undefined }) {
  return <RelationsView page={await readRelations(section, cursor)} cursor={cursor} hrefFor={rest.hrefFor}
    locale={rest.locale} t={rest.t} messages={rest.messages} />;
}

/**
 * Replies reviewed in public Realms about the resource, and the way to start
 * one: "Discuss this chapter" leads to the composer with this resource as its
 * target, so the action is the same on every page.
 */
export function DiscussionView({ page, realms, cursor, resource, subject, signedIn, hrefFor, locale, t, messages }: {
  page: Loaded<DiscussionPage>; realms: ReadonlyMap<string, ScopeRealm['name']>; cursor: string | undefined;
  resource: string; /** What the resource is called in a sentence ("chapter"). */ subject: string; signedIn: boolean;
  hrefFor: HrefFor; locale: UiLocale; t: Copy; messages: WorkPageMessages;
}) {
  const compose = `/submit?target=${idOf(resource) ?? resource}`;
  const start = <Link href={signedIn ? compose : signInPath(localizedPath(compose, locale))}
    className={buttonVariants({ size: 'sm', pill: true })} data-discuss>
    <MessagesSquareIcon aria-hidden="true" />{t.startDiscussion({ subject })}</Link>;
  if (!page.ok) {
    return <Region id="discussion" title={t.discussion} aside={start}>
      <RegionFailure title={messages.discussionUnavailable} failure={page.failure} messages={messages}
        restartHref={hrefFor({ kind: 'continue', section: 'discussion', cursor: null })} /></Region>;
  }
  return <Region id="discussion" title={t.discussion} aside={start}>
    {page.data.items.length ? <DiscussionList items={page.data.items} locale={locale} messages={messages}
      realmLabel={realm => realmLabel({ id: realm, name: realms.get(realm) ?? null }, messages, locale)} />
      : <EmptyState icon={MessagesSquareIcon} headingLevel={3} title={messages.noDiscussionGlobal}>{start}</EmptyState>}
    <Pages cursor={cursor} next={page.data.nextCursor} section="discussion" hrefFor={hrefFor} messages={messages} />
  </Region>;
}

export async function DiscussionSection({ section, cursor, resource, registry, signedIn, ...rest }: SectionProps & {
  cursor: string | undefined; resource: string; registry: EntityProjection['registry']; signedIn: boolean;
}) {
  const page = await readDiscussion(section, cursor);
  const ids = page.ok ? [...new Set(page.data.items.flatMap(item => idOf(item.realm) ?? []))] : [];
  const realms = new Map(await Promise.all(ids.map(async realm => {
    const header = await readRealm(realm, rest.locale);
    return [realm, header.ok ? header.data.name : null] as const;
  })));
  return <DiscussionView page={page} realms={realms} cursor={cursor} resource={resource}
    subject={inSentence(entryLabel(registry, rest.locale), rest.locale)} signedIn={signedIn} hrefFor={rest.hrefFor}
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
export async function ReviewsSectionOf({ section, resource, registry, actingSubject, ratings, locale, t, messages }:
  SectionProps & { resource: string; registry: EntityProjection['registry']; actingSubject: string | null;
    ratings: EntitySection | undefined }) {
  const questions = ratings ? await readRatings(ratings) : null;
  const question = questions?.ok ? questions.data.context : null;
  if (!question) return null;
  const initial = await readReviews(section, question.context);
  const authors = initial.ok ? [...new Set(initial.data.items.map(review => review.author))] : [];
  const named = await Promise.all(authors.map(async author => [author, await readReviewer(author)] as const));
  return <ReviewsSection target={resource} href={section.href} context={question.context} scale={question.scale.max}
    initial={initial} reviewers={Object.fromEntries(named.filter((entry): entry is [string, Reviewer] => entry[1] !== null))}
    viewer={actingSubject ? { kind: 'reader', actingSubject, canWrite: false } : { kind: 'read-only' }}
    subject={t.reviewsFor({ subject: inSentence(entryLabel(registry, locale), locale) })}
    locale={locale} messages={messages} />;
}

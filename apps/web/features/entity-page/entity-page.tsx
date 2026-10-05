import { buttonVariants } from '@rezics/ui/button';
import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import { notFound } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { browseReader } from '../discover/server.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { RelationshipControl } from '../relationships/control.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { reader, readingAgent } from '../work-page/read.ts';
import { Region, RegionSkeleton } from '../work-page/region.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import { EntityHeader } from './header.tsx';
import { type Copy, copyOf } from './messages.ts';
import { readEntityProjection, sectionOf } from './read.ts';
import { ContinuitySwitch } from '../wiki/continuity-switch.tsx';
import { type ContinuityChoice, continuityFrame, offContinuity, withContinuity } from '../wiki/continuity.ts';
import { readFrameTargets } from './frame-targets.ts';
import { EventRankingSection } from './event-participants.tsx';
import { judgmentSignals, SubjectJudgmentsSection } from './judgments.tsx';
import { translate as translateScoped } from '../scoped-rating/format.ts';
import { nameOccurrences } from '../scoped-rating/occurrence-names.ts';
import { PlaceJudgments } from '../scoped-rating/place-judgments.tsx';
import { ProjectionHeader } from '../scoped-rating/projection-header.tsx';
import { signInPath } from '../auth/paths.ts';
import { localizedPath } from '../../i18n/locale.ts';
import { entityHref, type EntityCursors, parseEntityRef, standaloneHrefFor } from './route.ts';
import { DiscussionSection, RatingsSection, RelationsSection, ReviewsSectionOf, StatementsSection } from './sections.tsx';
import { drawnSections } from './views.tsx';
import type { EntityProjection, EntitySection, HrefFor, SectionId } from './types.ts';
import { readIdentitySections, type IdentityRatingScope } from './identity-read.ts';
import { IdentitySectionsView } from './identity-views.tsx';
import { entryLabel } from '../catalogue/types.ts';
import { RATINGS_REGION, TargetRatingsRegion } from '../work-page/ratings.tsx';
import { inSentence } from './messages.ts';

function Unavailable({ t, messages, frame }: { t: Copy; messages: WorkPageMessages; frame: boolean }) {
  const body = <EmptyState icon={TriangleAlertIcon} tone="destructive" role="alert" headingLevel={1}
    title={t.pageUnavailableTitle} description={t.pageUnavailableBody}>
    <RetryButton label={messages.retry} pendingLabel={messages.retrying} />
  </EmptyState>;
  return frame ? <PageContainer>{body}</PageContainer> : body;
}

/** The page for a resource nobody can see or nobody made: one answer for both, as the address rules require. */
export function EntityNotFound({ t }: { t: Copy }) {
  return <PageContainer>
    <EmptyState icon={FileQuestionIcon} headingLevel={1} title={t.notFoundTitle} description={t.notFoundBody}>
      <Link href="/search" className={buttonVariants()}>{t.search}</Link>
    </EmptyState>
  </PageContainer>;
}

/**
 * One resource's page from its `entity-page-v1` projection: the header, then
 * the sections its base binds, each reading from the link the projection gave
 * it. `frame: false` leaves the container to the host (a Zone's detail route)
 * and `hrefFor` maps every link to the host's own addresses. A missing and a
 * hidden resource both end in `notFound()`.
 */
export async function EntityPage({ resource, locale, hrefFor, frame = true, cursors = {}, sections: only, position,
  header = true, identitySections = header, ratingScope = { scope: 'global' }, continuity = offContinuity,
  continuitySwitch = false }: {
  /** The resource's UUID or IRI. */
  resource: string; locale: UiLocale;
  /** Defaults to the standalone addresses: Works at `/w`, everything else at `/e`. */
  hrefFor?: HrefFor; frame?: boolean;
  /** The lists' current cursors (`parseEntityCursors` of the URL). */
  cursors?: EntityCursors;
  /** Draw only these sections, for a host that places the others itself. */
  sections?: readonly SectionId[];
  /** The reading position (`all` or an occurrence IRI) Main withholds later records for; omitted, Main chooses. */
  position?: string;
  /** Draw the page's heading; a host that sets the name out itself leaves it off. */
  header?: boolean;
  identitySections?: boolean;
  ratingScope?: IdentityRatingScope;
  /**
   * The continuity the facts and relations are read in (`parseContinuity` of the URL); Main applies it as the reads' `frame`,
   * and every link keeps it. Off by default, so nothing is hidden until someone asks.
   */
  continuity?: ContinuityChoice;
  /** Offer the switch under the header, when the page's own facts hold in more than one continuity. */
  continuitySwitch?: boolean;
}) {
  const id = parseEntityRef(resource);
  if (!id) notFound();
  const [t, messages, projection] = [copyOf(locale), await getMessages('workPage', locale), await readEntityProjection(id, position)];
  if (!projection.ok) {
    if (projection.failure === 'missing') notFound();
    return <Unavailable t={t} messages={messages} frame={frame} />;
  }
  const page = projection.data;
  if (page.summary.status !== 'available') notFound();
  const baseAddress = hrefFor ?? standaloneHrefFor(cursors, entityHref(id));
  const address: HrefFor = link => {
    const result = baseAddress(link);
    const url = new URL(result, 'https://rezics.invalid');
    if (position && !url.searchParams.has('position')) url.searchParams.set('position', position === 'all' ? 'all' : position.slice(-36));
    if (ratingScope.scope === 'realm') { url.searchParams.set('scope', 'realm'); url.searchParams.set('realm', ratingScope.realm); }
    // A host that maps the links (a Zone) keeps the continuity in its own addresses, where it knows the Zone's default.
    return hrefFor ? url.pathname + url.search + url.hash : withContinuity(url.pathname + url.search + url.hash, continuity);
  };
  const frames = continuityFrame(continuity);
  const [{ avatarQuery }, { signedIn, actingSubject }] = await Promise.all([browseReader(), readingAgent()]);
  const ownName = page.summary.name.value;
  const isPlace = page.target.base === 'projection';
  const draw = page.sections.filter(section => drawnSections.includes(section.id)
    && (!only || only.includes(section.id)));
  const common = { hrefFor: address, locale, t, messages };
  // This page's own address, without any list's cursor, which is where a choice made here (the continuity, signing in) returns to.
  const here = (() => {
    const url = new URL(address({ kind: 'continue', section: 'statements', cursor: null }), 'https://rezics.invalid');
    for (const cursor of ['statements', 'relations', 'discussion', 'family']) url.searchParams.delete(cursor);
    return url.pathname + url.search;
  })();
  const scoped = isPlace ? await getMessages('scopedRating', locale) : null;
  // A place is "a part" to a reader; the registry's word for its base is a model word.
  const noun = scoped ? translateScoped(scoped, locale).placeNoun : undefined;
  // A place's header names its episodes as their story does; a summary names a chapter after its Work.
  const placeSummary = isPlace
    ? (await nameOccurrences((await reader()).main, [page.summary], locale, actingSubject ?? undefined))[0]
    : null;
  const loading = (section: EntitySection, title: string) =>
    <RegionSkeleton id={`${section.id}-loading`} title={title} label={messages.loadingRegion} lines={3} />;
  const body: ReactNode = <div className="grid min-w-0 gap-10">
    {header ? scoped
      ? <ProjectionHeader summary={placeSummary} level={1} page locale={locale} messages={scoped} />
      : <EntityHeader summary={page.summary} registry={page.registry} avatarQuery={avatarQuery} locale={locale} t={t} /> : null}
    {header ? <RelationshipControl target={page.target.resource}
      kind={page.summary.base === 'work' ? 'work' : ['realm', 'space', 'collection', 'concept'].includes(page.summary.type)
        ? page.summary.type : page.registry.type} name={page.summary.name.value} locale={locale}
      signedIn={signedIn} actingSubject={actingSubject} signInHref="/auth/start" /> : null}
    {continuitySwitch && page.target.base === 'resource'
      ? <Suspense fallback={null}><ContinuityBar id={id} position={position} here={here} current={continuity} locale={locale} /></Suspense> : null}
    {identitySections && page.target.base === 'resource' ? <Suspense fallback={
      <RegionSkeleton id="identity-loading" title={t.relations} label={messages.loadingRegion} lines={3} />}>
      <IdentitySections page={page} cursors={cursors} ratingScope={ratingScope} position={position}
        frame={frames[0]} here={here} actingSubject={actingSubject ?? null}
        avatarQuery={avatarQuery} {...common} /></Suspense> : null}
    {page.target.base === 'resource' && page.registry.frameDimension === 'event'
      ? <Suspense fallback={null}><EventRankingSection page={page} ratingScope={ratingScope} position={position}
        locale={locale} actingSubject={actingSubject ?? null} /></Suspense> : null}
    {draw.map(section => {
      switch (section.id) {
        case 'statements': return <Suspense key={section.id} fallback={loading(section, t.statements)}>
          <StatementsSection section={section} cursor={cursors.statements} position={position} frame={frames}
            projection={isPlace} ownName={ownName} {...common} /></Suspense>;
        case 'relations': return <Suspense key={section.id} fallback={loading(section, t.relations)}>
          <RelationsSection section={section} cursor={cursors.relations} position={position} frame={frames}
            hideIdentity={identitySections && page.target.base === 'resource'} {...common} /></Suspense>;
        case 'ratings': return scoped
          // A place is rated where it is read: its questions, figures and the person's own rating, with its reviews and discussion below.
          ? <Region key={section.id} id={RATINGS_REGION} title={messages.ratings}>
            <PlaceJudgments target={page.target.resource} scope={ratingScope.scope === 'realm' ? { kind: 'realm', realm: ratingScope.realm } : { kind: 'global' }}
              actingSubject={actingSubject ?? null} signInHref={signInPath(localizedPath(here, locale))} locale={locale}
              messages={scoped} /></Region>
          : <Suspense key={section.id} fallback={loading(section, messages.ratings)}>
            <RatingsSection section={section} registry={page.registry} {...common} /></Suspense>;
        case 'reviews': return <Suspense key={section.id} fallback={loading(section, messages.reviews)}>
          <ReviewsSectionOf section={section} resource={page.target.resource} registry={page.registry}
            actingSubject={actingSubject ?? null} ratings={sectionOf(page, 'ratings')} noun={noun} {...common} /></Suspense>;
        case 'discussion': return <Suspense key={section.id} fallback={loading(section, t.discussion)}>
          <DiscussionSection section={section} cursor={cursors.discussion} resource={page.target.resource}
            registry={page.registry} signedIn={signedIn} noun={noun} {...common} /></Suspense>;
        default: return null;
      }
    })}
  </div>;
  return frame ? <PageContainer className="max-w-4xl [text-autospace:normal]">{body}</PageContainer> : body;
}

/** The switch for the continuity the page's facts are read in, offered when they hold in more than one. */
async function ContinuityBar({ id, position, here, current, locale }: {
  id: string; position?: string; here: string; current: ContinuityChoice; locale: UiLocale;
}) {
  const { continuities } = await readFrameTargets(id, position);
  if (continuities.length < 2) return null;
  return <ContinuitySwitch here={here} current={current} options={continuities} locale={locale}
    messages={await getMessages('scopedRating', locale)} />;
}

async function IdentitySections({ page, cursors, ratingScope, position, frame, here, actingSubject, ...props }: {
  page: EntityProjection; cursors: EntityCursors; ratingScope: IdentityRatingScope; position?: string; frame?: string;
  here: string; actingSubject: string | null;
  avatarQuery: string; hrefFor: HrefFor; locale: UiLocale; t: Copy; messages: WorkPageMessages;
}) {
  if (page.summary.status !== 'available') return null;
  const data = await readIdentitySections(page, cursors, ratingScope, position, frame);
  const signals = await judgmentSignals(page.summary.reference, ratingScope.scope === 'realm' ? ratingScope.realm : null);
  const judged = signals.questions || signals.places;
  return <>
    <IdentitySectionsView data={data} self={page.summary}
      currentHref={props.hrefFor({ kind: 'continue', section: 'relations', cursor: cursors.relations ?? null })} {...props} />
    {judged ? <SubjectJudgmentsSection page={page} cursors={cursors} ratingScope={ratingScope} position={position}
      here={here} locale={props.locale} messages={props.messages} actingSubject={actingSubject} /> : null}
    {!judged && data.ok && data.data.ratings && !page.sections.some(section => section.id === 'ratings')
      ? <TargetRatingsRegion ratings={data.data.ratings}
        subject={props.t.ratingsFor({ subject: inSentence(entryLabel(page.registry, props.locale), props.locale) })}
        none={props.t.noRatingQuestion} locale={props.locale} messages={props.messages} /> : null}
  </>;
}

export type { EntityProjection };

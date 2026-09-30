import { buttonVariants } from '@rezics/ui/button';
import { FileQuestionIcon, TriangleAlertIcon } from 'lucide-react';
import { notFound } from 'next/navigation';
import { type ReactNode, Suspense } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { getMessages } from '../../i18n/server.ts';
import { browseReader } from '../discover/server.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { WorkPageMessages } from '../work-page/messages.ts';
import { readingAgent } from '../work-page/read.ts';
import { RegionSkeleton } from '../work-page/region.tsx';
import { RetryButton } from '../work-page/retry-button.tsx';
import { EntityHeader } from './header.tsx';
import { type Copy, copyOf } from './messages.ts';
import { readEntityProjection, sectionOf } from './read.ts';
import { entityHref, type EntityCursors, parseEntityRef, standaloneHrefFor } from './route.ts';
import { DiscussionSection, RatingsSection, RelationsSection, ReviewsSectionOf, StatementsSection } from './sections.tsx';
import { drawnSections } from './views.tsx';
import type { EntityProjection, EntitySection, HrefFor, SectionId } from './types.ts';

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
export async function EntityPage({ resource, locale, hrefFor, frame = true, cursors = {}, sections: only }: {
  /** The resource's UUID or IRI. */
  resource: string; locale: UiLocale;
  /** Defaults to the standalone addresses: Works at `/w`, everything else at `/e`. */
  hrefFor?: HrefFor; frame?: boolean;
  /** The lists' current cursors (`parseEntityCursors` of the URL). */
  cursors?: EntityCursors;
  /** Draw only these sections, for a host that places the others itself. */
  sections?: readonly SectionId[];
}) {
  const id = parseEntityRef(resource);
  if (!id) notFound();
  const [t, messages, projection] = [copyOf(locale), await getMessages('workPage', locale), await readEntityProjection(id)];
  if (!projection.ok) {
    if (projection.failure === 'missing') notFound();
    return <Unavailable t={t} messages={messages} frame={frame} />;
  }
  const page = projection.data;
  if (page.summary.status !== 'available') notFound();
  const address = hrefFor ?? standaloneHrefFor(cursors, entityHref(id));
  const [{ avatarQuery }, { signedIn, actingSubject }] = await Promise.all([browseReader(), readingAgent()]);
  const draw = page.sections.filter(section => drawnSections.includes(section.id)
    && (!only || only.includes(section.id)));
  const common = { hrefFor: address, locale, t, messages };
  const loading = (section: EntitySection, title: string) =>
    <RegionSkeleton id={`${section.id}-loading`} title={title} label={messages.loadingRegion} lines={3} />;
  const body: ReactNode = <div className="grid min-w-0 gap-10">
    <EntityHeader summary={page.summary} registry={page.registry} avatarQuery={avatarQuery} locale={locale} t={t} />
    {draw.map(section => {
      switch (section.id) {
        case 'statements': return <Suspense key={section.id} fallback={loading(section, t.statements)}>
          <StatementsSection section={section} cursor={cursors.statements} {...common} /></Suspense>;
        case 'relations': return <Suspense key={section.id} fallback={loading(section, t.relations)}>
          <RelationsSection section={section} cursor={cursors.relations} {...common} /></Suspense>;
        case 'ratings': return <Suspense key={section.id} fallback={loading(section, messages.ratings)}>
          <RatingsSection section={section} registry={page.registry} {...common} /></Suspense>;
        case 'reviews': return <Suspense key={section.id} fallback={loading(section, messages.reviews)}>
          <ReviewsSectionOf section={section} resource={page.target.resource} registry={page.registry}
            actingSubject={actingSubject ?? null} ratings={sectionOf(page, 'ratings')} {...common} /></Suspense>;
        case 'discussion': return <Suspense key={section.id} fallback={loading(section, t.discussion)}>
          <DiscussionSection section={section} cursor={cursors.discussion} resource={page.target.resource}
            registry={page.registry} signedIn={signedIn} {...common} /></Suspense>;
        default: return null;
      }
    })}
  </div>;
  return frame ? <PageContainer className="max-w-4xl [text-autospace:normal]">{body}</PageContainer> : body;
}

export type { EntityProjection };

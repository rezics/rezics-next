import { SubjectStreamDirectory } from './subject-streams';
import { LiteraryProfileEntry } from '../catalogue/literary-profile-entry';
import { GameProfileEntry } from '../catalogue/game-profile-entry';
import { EditorialEntry } from '../catalogue/editorial-entry';
import { AddonProfileEntry } from '../catalogue/addon-profile-entry';
import { SubjectFactsEntry } from '../catalogue/subject-facts-entry';
import { SubjectChangesLink } from '../catalogue/subject-changes-link';
import { CreateSubjectEntry } from '../catalogue/create-subject-entry';
import { AuthoredFieldEntry } from '../catalogue/authored-field-entry';
import { SubjectTermsEntry } from '../catalogue/subject-terms-entry';
import { WorkPartsEntry } from '../catalogue/work-parts-entry';
import { PublicationEditorEntry } from '../catalogue/publication-editor-entry';
import { RecipeEditorEntry } from '../catalogue/recipe-editor-entry';
import { CharacterProfileEntry } from '../catalogue/character-profile-entry';
import { CharacterRelationshipsEntry } from '../catalogue/character-relationships/entry';
import { ScreenProfileEntry } from '../catalogue/screen-profile-entry';
import { isScreenType } from '../catalogue/screen-profile';
import { StoryArcProfileEntry } from '../catalogue/story-arc-profile-entry';
import { MangaProfileEntry } from '../catalogue/manga-profile-entry';
import { PeopleProfileEntry } from '../catalogue/people-profile-entry';
import { ProducerHistoryEntry } from '../catalogue/producer-history/entry';
import { CatalogueFileSlot, OrganizationHistorySlot, ReleaseFidelitySlot, SubjectExploreSlot } from './subject-slots';
import { AlbumProfileEntry } from '../catalogue/album-profile-entry';
import { ReleaseFidelityEntry } from '../catalogue/release-fidelity/entry';
import { CatalogueFileProfileEntry } from '../catalogue/catalogue-file-profile/entry';
import { candidateContext } from '../../subject/candidates';
import { conceptPublicReturnHref, mangaObservedOrigin } from './subject-page-composition';
import type { AuthoredPublicOrigin } from './semantic-render-port';
import { VIEWS, type View } from '@rezics/composition';
import type { ComponentProps, ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { Cover, type CoverLabels, type CoverRatio } from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { defaultReader, type Reader } from '../../subject/reader';
import { subjectHref } from '../../subject/subject-href';
import { linkClass, linkColor, isRecord, PlainLink, type PageLink } from './shared';
import { SubjectPage } from './subject';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import type { ViewTab } from './views';
import { contextHref } from './context-navigation';
import { withSubjectVisitReturn, zoneVisitReturn } from './subject-visit-navigation';
import { PageStreamHeadingContext, ViewHeadingActions } from './view-heading';
import { useLocation } from '@tanstack/react-router';
import type { SubjectFrameData } from './subject-frame-model';
export { loadViewPages, subjectFrame } from './subject-frame-model';
export type { SubjectFrameData, ViewPagesLoad } from './subject-frame-model';
export { ViewHeading, ViewHeadingActions } from './view-heading';

function withCurrent(tabs: readonly ViewTab[], view: View): readonly ViewTab[] {
  if (tabs.some((tab) => tab.view === view)) return tabs;
  const order = (tab: ViewTab) => VIEWS.indexOf(tab.view);
  return [...tabs, { view }].sort((a, b) => order(a) - order(b));
}

/**
 * The compact header every subject view starts with, and the view tabs under it: which subject the reader is on, and
 * the way to every other view. Ordinary reader hosts may supply the shared Library leaf; companion editors omit it.
 */
export function SubjectFrame({
  frame,
  locale,
  link: Link = PlainLink,
  reader = defaultReader,
  coverLabels,
  unlabelled,
  typeLabel,
  ratio,
  tabs,
  tabLabels,
  view,
  base: tabBase,
  realm,
  returnTo,
  context,
  navigation,
  library,
}: {
  frame: SubjectFrameData;
  locale: string;
  link?: PageLink;
  reader?: Reader;
  coverLabels?: Partial<CoverLabels>;
  unlabelled: string;
  typeLabel?: string;
  ratio?: CoverRatio;
  tabs: readonly ViewTab[];
  tabLabels: ViewTabLabels;
  view: View;
  /** Optional companion-view navigation, retaining the shared compact subject header. */
  navigation?: ReactNode;
  /** The existing Library leaf, supplied only by a successful ordinary subject reader. */
  library?: ReactNode;
  /** The page-view address when this subject is embedded in a routed Zone. */
  base?: string;
  realm?: string | undefined;
  returnTo?: string | undefined;
  /** A companion review route may select a Context independently of its public overview read. */
  context?: string | undefined;
}) {
  const location = useLocation();
  const title = frame.title.text || unlabelled;
  const base = subjectHref({ id: frame.id, label: title }, locale).href;
  const observedContext = context ?? frame.context;
  const conceptReturnHref = observedContext
    ? conceptPublicReturnHref(base, frame.id, locale, observedContext, realm)
    : undefined;
  const releaseOrigin = `${location.pathname}${observedContext ? `?${new URLSearchParams({ context: observedContext })}` : ''}`;
  const factsOrigin = observedContext
    ? {
        subject: frame.id,
        context: observedContext,
        ...(realm ? { realm } : {}),
        returnHref: contextHref(base, realm),
      }
    : undefined;
  const termsReturn = new URL(contextHref(base, realm), 'https://rezics.invalid');
  if (observedContext) termsReturn.searchParams.set('context', observedContext);
  termsReturn.hash = 'connections';
  const termsOrigin = observedContext
    ? {
        subject: frame.id,
        context: observedContext,
        ...(realm ? { realm } : {}),
        locale,
        returnHref: `${termsReturn.pathname}${termsReturn.search}${termsReturn.hash}`,
      }
    : undefined;
  const authoredOrigin: AuthoredPublicOrigin | undefined = observedContext
    ? {
        subject: frame.id,
        context: observedContext,
        ...(realm ? { realm } : {}),
        locale,
        returnHref: contextHref(base, realm),
      }
    : undefined;
  const facts = [typeLabel, frame.date].filter((fact): fact is string => !!fact);
  return (
    <div data-slot="subject-frame" className="flex min-w-0 flex-col gap-4">
      <header data-slot="subject-header" className="flex min-w-0 flex-wrap items-center gap-3">
        <Cover
          subject={coverSubject(frame.id, title, frame.summary ?? undefined, frame.type)}
          cover={coverOf(frame.summary ?? undefined)}
          size="xs"
          src={coverSrc}
          suitability={reader.suitability}
          decorative
          {...(coverLabels ? { labels: coverLabels } : {})}
          ratio={ratio ?? '5:7'}
        />
        <div className="min-w-0 flex-1 space-y-0.5">
          <p className="flex min-w-0 flex-wrap items-baseline gap-x-3">
            <span
              id="subject-heading"
              tabIndex={-1}
              className={`${linkClass} ${frame.title.text ? linkColor : 'text-muted-foreground'} min-w-0 max-w-full font-sans text-lg font-semibold wrap-anywhere`}
            >
              <Link
                href={contextHref(withSubjectVisitReturn(base, returnTo ?? '', locale), realm)}
                className="inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm whitespace-normal wrap-anywhere focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring"
                {...(frame.title.lang ? { lang: frame.title.lang } : {})}
              >
                {title}
              </Link>
            </span>
            {frame.original && (
              <span
                lang={frame.original.lang}
                className="min-w-0 max-w-full text-sm wrap-anywhere text-muted-foreground"
              >
                {frame.original.text}
              </span>
            )}
          </p>
          {facts.length > 0 && (
            <p className="text-sm text-muted-foreground">
              <MetaLine items={facts} />
            </p>
          )}
        </div>
        {!realm && (
          <div data-slot="actions">
            <EditorialEntry id={frame.id} label={title} locale={locale} context={observedContext} realm={realm}>
              {frame.type === 'wd:Q209163' ? (
                <AddonProfileEntry id={frame.id} label={title} locale={locale} />
              ) : (
                <AddonProfileEntry locale={locale} {...(frame.type === 'schema:VideoGame' ? { work: frame.id } : {})} />
              )}
              {view === 'editions' && <PublicationEditorEntry work={frame.id} locale={locale} />}
              {(frame.type === 'schema:Person' || frame.type === 'schema:Organization') && (
                <PeopleProfileEntry id={frame.id} label={title} locale={locale} />
              )}
              {frame.type === 'schema:Organization' && observedContext && (
                <ProducerHistoryEntry
                  id={frame.id}
                  label={title}
                  locale={locale}
                  context={observedContext}
                  realm={realm}
                  currentHref={location.publicHref}
                />
              )}
              {view === 'credits' && <PeopleProfileEntry work={frame.id} locale={locale} />}
              <GameProfileEntry id={frame.id} type={frame.type} label={title} locale={locale} />
              {(frame.type === 'schema:Book' || frame.type === 'schema:BookSeries') && (
                <LiteraryProfileEntry id={frame.id} label={title} type={frame.type} locale={locale} />
              )}
              <CreateSubjectEntry locale={locale} />
              {frame.type === 'wd:Q2620972' && (
                <StoryArcProfileEntry id={frame.id} label={title} locale={locale} realm={realm} />
              )}
              {frame.type === 'wd:Q95074' && (
                <>
                  <CharacterProfileEntry id={frame.id} label={title} locale={locale} />
                  <CharacterRelationshipsEntry id={frame.id} label={title} locale={locale} />
                </>
              )}
              {(view === 'characters' || view === 'credits') && frame.type !== 'wd:Q95074' && (
                <CharacterProfileEntry work={frame.id} locale={locale} />
              )}
              <AuthoredFieldEntry id={frame.id} title={title} locale={locale} origin={authoredOrigin} />
              <SubjectFactsEntry id={frame.id} label={title} locale={locale} origin={factsOrigin} />
              {frame.type === 'schema:Recipe' && <RecipeEditorEntry id={frame.id} label={title} locale={locale} />}
              {isScreenType(frame.type) && <ScreenProfileEntry id={frame.id} label={title} locale={locale} />}
              {(frame.type === 'schema:ComicSeries' || frame.type === 'schema:PublicationVolume') && (
                <MangaProfileEntry
                  id={frame.id}
                  label={title}
                  locale={locale}
                  origin={
                    (context ?? frame.context)
                      ? mangaObservedOrigin({
                          subject: frame.id,
                          type: frame.type as 'schema:ComicSeries' | 'schema:PublicationVolume',
                          context: (context ?? frame.context)!,
                          ...(realm ? { realm } : {}),
                          returnHref: `${contextHref(base, realm)}#manga-reader`,
                        })
                      : undefined
                  }
                />
              )}
              {!realm && observedContext === candidateContext && frame.type === 'schema:MusicAlbum' && (
                <AlbumProfileEntry id={frame.id} label={title} locale={locale} />
              )}
              <SubjectTermsEntry id={frame.id} label={title} locale={locale} origin={termsOrigin} />
              <ReleaseFidelityEntry
                id={frame.id}
                type={frame.type}
                label={title}
                locale={locale}
                context={observedContext}
                returnHref={releaseOrigin}
              />
              <CatalogueFileProfileEntry id={frame.id} type={frame.type} label={title} locale={locale} />
              {view === 'contents' && (
                <WorkPartsEntry id={frame.id} label={title} locale={locale} context={observedContext} realm={realm} />
              )}
              <SubjectChangesLink id={frame.id} title={title} locale={locale} />
            </EditorialEntry>
          </div>
        )}
        {realm && view === 'contents' && (
          <WorkPartsEntry id={frame.id} label={title} locale={locale} context={observedContext} realm={realm} />
        )}
      </header>
      <OrganizationHistorySlot subjectId={frame.id} subjectType={frame.type} label={title} locale={locale} />
      <SubjectExploreSlot
        subjectId={frame.id}
        subjectType={frame.type}
        label={title}
        locale={locale}
        context={observedContext}
        realm={realm}
        returnTo={returnTo}
        publicReturnHref={conceptReturnHref}
        musicReturnTo={location.publicHref}
      />
      <ReleaseFidelitySlot
        subjectId={frame.id}
        subjectType={frame.type}
        label={title}
        locale={locale}
        context={observedContext}
        returnHref={releaseOrigin}
      />
      <CatalogueFileSlot subjectId={frame.id} subjectType={frame.type} label={title} locale={locale} />
      {library ? (
        <div
          data-slot="subject-library"
          className="min-w-0 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:wrap-anywhere [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:wrap-anywhere"
        >
          {library}
        </div>
      ) : null}
      {navigation ?? (
        <ViewTabs
          tabs={withCurrent(tabs, view)}
          active={view}
          locale={locale}
          base={tabBase ?? base}
          labels={tabLabels}
          realm={realm}
          {...(returnTo ? { returnTo } : {})}
        />
      )}
      {returnTo ? (
        <a
          href={returnTo}
          className={`${linkClass} ${linkColor} inline-flex min-h-11 min-w-11 items-center underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring`}
        >
          {zoneVisitReturn(returnTo, locale)
            ? m.zone_return({}, { locale: locale as never })
            : m.recording_reader_return({}, { locale: locale as never })}
        </a>
      ) : null}
    </div>
  );
}

/** A view served by the view route: the frame, the view's heading, then the view's own document. */
type SubjectViewPageProps = Omit<ComponentProps<typeof SubjectPage>, 'heading' | 'tabs' | 'tabLabels' | 'actions'> & {
  frame: ReactNode;
  label: string;
  actions?: ReactNode;
  nextHref?: string;
};

export function SubjectViewPage({ frame, label, actions, nextHref, ...page }: SubjectViewPageProps) {
  // Full-page stream leaves already own their title and continuation. Multi-group documents still need a page title.
  const streams: { type: string; props: Record<string, unknown> }[] = [];
  function visit(nodes: readonly unknown[]) {
    for (const node of nodes) {
      if (!isRecord(node) || !isRecord(node.props)) continue;
      if (
        node.props.paged === true &&
        [
          'SubjectList',
          'RelationGroups',
          'OutgoingRelations',
          'Appearances',
          'Credits',
          'ReviewList',
          'ThreadList',
        ].includes(String(node.type))
      )
        streams.push({ type: String(node.type), props: node.props });
      for (const child of Object.values(node.props)) if (Array.isArray(child)) visit(child);
    }
  }
  visit(page.page.document.content);
  const visibleStreams = page.page.streams?.selected
    ? streams.filter(({ props }) => props.id === page.page.streams?.selected)
    : streams;
  const ownHeading = visibleStreams.length === 1;
  const ownContinuation = streams.length > 0;
  return (
    <div className="flex w-full min-w-0 flex-col gap-8">
      {frame}
      <SubjectStreamDirectory
        streams={page.page.streams}
        document={page.page.document}
        locale={page.locale}
        relations={page.relations}
      />
      {ownHeading ? (
        actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:wrap-anywhere [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:wrap-anywhere">
            {actions}
          </div>
        ) : null
      ) : (
        <ViewHeadingActions label={label} actions={actions} />
      )}
      <PageStreamHeadingContext value={ownHeading ? String(visibleStreams[0]!.props.id) : undefined}>
        <SubjectPage {...page} framed />
      </PageStreamHeadingContext>
      {nextHref && !ownContinuation ? (
        <a
          data-slot="next-page"
          href={nextHref}
          rel="next"
          className={cn(
            buttonVariants({ variant: 'outline' }),
            'h-auto min-h-11 min-w-11 max-w-full whitespace-normal wrap-anywhere py-2 focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
          )}
        >
          {m.subject_view_continue({ label }, { locale: page.locale as never })}
        </a>
      ) : null}
    </div>
  );
}

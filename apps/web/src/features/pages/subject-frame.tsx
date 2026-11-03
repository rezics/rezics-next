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
import { ScreenProfileEntry } from '../catalogue/screen-profile-entry';
import { isScreenType } from '../catalogue/screen-profile';
import { StoryArcProfileEntry } from '../catalogue/story-arc-profile-entry';
import { MangaProfileEntry } from '../catalogue/manga-profile-entry';
import { PeopleProfileEntry } from '../catalogue/people-profile-entry';
import { ProducerHistoryEntry } from '../catalogue/producer-history/entry';
import { OrganizationHistorySlot } from './subject-slots';
import { AlbumProfileEntry } from '../catalogue/album-profile-entry';
import { candidateContext } from '../../subject/candidates';
import type { KernelClient } from '@rezics/client';
import {
  planReads,
  platformRegistry,
  VIEWS,
  type CompositionDocument,
  type PageRead,
  type View,
} from '@rezics/composition';
import type { ComponentProps, ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { Cover, type CoverLabels, type CoverRatio } from '@rezics/ui/cover';
import { MetaLine } from '@rezics/ui/meta-line';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject, type SubjectSummary } from '../../media/summary';
import { originalLanguage, originalTitle } from '../../subject/language';
import { defaultReader, type Reader } from '../../subject/reader';
import type { Subject } from '../../subject/types';
import { subjectHref } from '../../subject/subject-href';
import { pageText } from './data';
import { dateText } from './overview';
import { linkClass, linkColor, bestRank, isRecord, PlainLink, type PageLink, type Stmt } from './shared';
import { loadSubjectPage, pageContext, PageReadError, SubjectPage, type SubjectPageData } from './subject';
import { ViewTabs, type ViewTabLabels } from './view-tabs';
import type { ViewTab } from './views';
import { assertSamePageContext } from './context-subject';
import { contextHref } from './context-navigation';
import { PageStreamHeadingContext, ViewHeadingActions } from './view-heading';
export { ViewHeading, ViewHeadingActions } from './view-heading';

const DATE_PROPERTIES = ['schema:datePublished', 'schema:startDate', 'schema:dateCreated'];
/** The Wikidata time precisions that name a year, a month and a day. */
const PRECISION_ISO = { 9: 4, 10: 7, 11: 10 } as const;

/** What the compact header of a view page shows of its subject: a constant number of fields, however large the subject. */
export type SubjectFrameData = {
  id: string;
  type: string;
  /** Exact current Context from the same native subject/page read. */
  context?: string | undefined;
  /** The title in the reader's language; empty for a subject with no label at all. */
  title: { text: string; lang?: string | undefined };
  /** The title the subject was first written under, when it differs from the one shown. */
  original?: { text: string; lang: string };
  date?: string;
  summary: SubjectSummary | null;
};

function subjectRead(page: SubjectPageData): { subject: Subject; summary: SubjectSummary | null } | undefined {
  const planned = Object.entries(
    planReads(platformRegistry, page.document as CompositionDocument, pageContext(page)).reads,
  ).find(([, read]) => read.kind === 'subject' && read.id === page.subject);
  const result = planned ? page.reads[planned[0]] : undefined;
  if (result?.status !== 200 || !isRecord(result.body) || !isRecord(result.body.subject)) return;
  const summary = isRecord(result.body.summary) ? (result.body.summary as unknown as SubjectSummary) : null;
  return { subject: result.body.subject as unknown as Subject, summary };
}

/** The first date the subject states, at its own precision, in the reader's language. */
function dateOf(subject: Subject, locale: string): string | undefined {
  const statements = subject.statements as unknown as Record<string, Stmt[]>;
  for (const property of DATE_PROPERTIES) {
    for (const statement of Object.hasOwn(statements, property) ? bestRank(statements[property] ?? []) : []) {
      const content = statement.value.type === 'value' ? statement.value.content : undefined;
      if (!isRecord(content) || typeof content.time !== 'string') continue;
      const length = PRECISION_ISO[content.precision as keyof typeof PRECISION_ISO];
      // Kernel dates use 00 for the month or day omitted at year or month precision.
      const iso = length === undefined ? undefined : content.time.replace(/^\+/, '').slice(0, length);
      const text = dateText(iso, locale);
      if (text) return text;
    }
  }
}

/** The frame of a view page, from the overview page read the view already makes. Nothing when that read failed. */
export function subjectFrame(overview: SubjectPageData, locale: string): SubjectFrameData | undefined {
  const read = subjectRead(overview);
  if (!read) return;
  const { subject, summary } = read;
  const label = pageText(subject.labels, locale, originalLanguage(subject));
  const first = originalTitle(subject);
  const date = dateOf(subject, locale);
  return {
    id: subject.id,
    type: subject.type,
    context: overview.context?.id ?? subject.context,
    title: label,
    ...(first && label.text && first.text !== label.text ? { original: first } : {}),
    ...(date ? { date } : {}),
    summary,
  };
}

export type ViewPagesLoad =
  | { kind: 'missing' }
  | { kind: 'redirect'; id: string; target?: 'account' }
  | { kind: 'page'; page: SubjectPageData; overview: SubjectPageData; next?: string; node?: string };

/** One `pages.read` of the view and one of the overview, whose previews give the tab bar its counts and the frame its subject. */
export async function loadViewPages(
  client: KernelClient,
  id: string,
  view: View,
  locale = 'en',
  cursor?: string,
  options: { realm?: string | undefined; node?: string | undefined; authorization?: string | undefined } = {},
): Promise<ViewPagesLoad> {
  // Resolve a node from the current template; the continued request independently resolves and guards it again.
  const first = await loadSubjectPage(client, id, view, locale, {
    ...options,
    ...(cursor !== undefined && options.node ? { continuation: { node: options.node, cursor } } : {}),
  });
  if (first.kind !== 'page') return first;
  const plan = planReads(platformRegistry, first.page.document as CompositionDocument, pageContext(first.page));
  const primary = Object.entries(plan.nodes).find(([node, key]) => {
    const read = plan.reads[key];
    return (
      (!options.node || options.node === node) &&
      (read?.kind === 'links' ||
        read?.kind === 'relations' ||
        read?.kind === 'subjectThreads' ||
        read?.kind === 'collections')
    );
  });
  let result = first;
  if (cursor !== undefined && !options.node) {
    if (!primary) return { kind: 'missing' };
    const primaryRead = plan.reads[primary[1]];
    if (primaryRead?.kind === 'collections') {
      if (first.page.context?.population.kind === 'realm') throw new PageReadError('dependency_unavailable', 503);
      const response = await client.subjects({ id }).collections.get({
        query: { limit: primaryRead.limit, cursor },
        ...(options.authorization ? { headers: { authorization: options.authorization } } : {}),
      });
      if (response.status === 400) return { kind: 'missing' };
      first.page.reads[primary[1]] = { status: response.status, body: response.error ? {} : response.data };
    } else {
      const continued = await loadSubjectPage(client, id, view, locale, {
        ...options,
        continuation: { node: primary[0], cursor },
      });
      if (continued.kind !== 'page') return continued;
      assertSamePageContext(first.page, continued.page);
      result = continued;
    }
  }
  const overview = await loadSubjectPage(client, id, undefined, locale, options);
  if (overview.kind !== 'page') return overview;
  assertSamePageContext(result.page, overview.page);
  const currentPlan = planReads(
    platformRegistry,
    result.page.document as CompositionDocument,
    pageContext(result.page),
  );
  const key = primary ? currentPlan.nodes[primary[0]] : undefined;
  const body = key ? result.page.reads[key]?.body : undefined;
  const groupCount = Object.values(currentPlan.reads).filter(
    (read) => read.kind === 'links' || read.kind === 'relations' || read.kind === 'subjectThreads',
  ).length;
  const next =
    key &&
    currentPlan.reads[key]?.kind !== 'subjectThreads' &&
    groupCount <= 1 &&
    isRecord(body) &&
    typeof body.next === 'string'
      ? body.next
      : undefined;
  return {
    kind: 'page',
    page: result.page,
    overview: overview.page,
    ...(next ? { next } : {}),
    ...(primary && currentPlan.reads[primary[1]]?.kind !== 'collections' ? { node: primary[0] } : {}),
  };
}

/** The tabs with the current view among them: the reader is on it, so the bar always offers it, in the documented order. */
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
  /** A companion review route may select a Context independently of its public overview read. */
  context?: string | undefined;
}) {
  const title = frame.title.text || unlabelled;
  const base = subjectHref({ id: frame.id, label: title }, locale).href;
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
              className={`${linkClass} ${frame.title.text ? linkColor : 'text-muted-foreground'} min-w-0 max-w-full font-sans text-lg font-semibold wrap-anywhere`}
            >
              <Link
                href={contextHref(base, realm)}
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
            <EditorialEntry
              id={frame.id}
              label={title}
              locale={locale}
              context={context ?? frame.context}
              realm={realm}
            >
              {frame.type === 'wd:Q209163' ? (
                <AddonProfileEntry id={frame.id} label={title} locale={locale} />
              ) : (
                <AddonProfileEntry locale={locale} {...(frame.type === 'schema:VideoGame' ? { work: frame.id } : {})} />
              )}
              {view === 'editions' && <PublicationEditorEntry work={frame.id} locale={locale} />}
              {(frame.type === 'schema:Person' || frame.type === 'schema:Organization') && (
                <PeopleProfileEntry id={frame.id} label={title} locale={locale} />
              )}
              {frame.type === 'schema:Organization' && (
                <ProducerHistoryEntry id={frame.id} label={title} locale={locale} />
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
              {frame.type === 'wd:Q95074' && <CharacterProfileEntry id={frame.id} label={title} locale={locale} />}
              {(view === 'characters' || view === 'credits') && frame.type !== 'wd:Q95074' && (
                <CharacterProfileEntry work={frame.id} locale={locale} />
              )}
              <AuthoredFieldEntry id={frame.id} title={title} locale={locale} />
              <SubjectFactsEntry id={frame.id} label={title} locale={locale} />
              {frame.type === 'schema:Recipe' && <RecipeEditorEntry id={frame.id} label={title} locale={locale} />}
              {isScreenType(frame.type) && <ScreenProfileEntry id={frame.id} label={title} locale={locale} />}
              {(frame.type === 'schema:ComicSeries' || frame.type === 'schema:PublicationVolume') && (
                <MangaProfileEntry id={frame.id} label={title} locale={locale} />
              )}
              {!realm && (context ?? frame.context) === candidateContext && frame.type === 'schema:MusicAlbum' && (
                <AlbumProfileEntry id={frame.id} label={title} locale={locale} />
              )}
              <SubjectTermsEntry id={frame.id} label={title} locale={locale} />
              {view === 'contents' && (
                <WorkPartsEntry
                  id={frame.id}
                  label={title}
                  locale={locale}
                  context={context ?? frame.context}
                  realm={realm}
                />
              )}
              <SubjectChangesLink id={frame.id} title={title} locale={locale} />
            </EditorialEntry>
          </div>
        )}
        {realm && view === 'contents' && (
          <WorkPartsEntry
            id={frame.id}
            label={title}
            locale={locale}
            context={context ?? frame.context}
            realm={realm}
          />
        )}
      </header>
      <OrganizationHistorySlot subjectId={frame.id} subjectType={frame.type} label={title} locale={locale} />
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
        />
      )}
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
  const ownHeading = streams.length === 1;
  const ownContinuation = streams.length > 0;
  return (
    <div className="flex w-full min-w-0 flex-col gap-8">
      {frame}
      {ownHeading ? (
        actions ? (
          <div className="flex min-w-0 max-w-full flex-wrap items-center gap-2 [&_a]:h-auto [&_a]:min-h-11 [&_a]:min-w-11 [&_a]:max-w-full [&_a]:whitespace-normal [&_a]:wrap-anywhere [&_button]:h-auto [&_button]:min-h-11 [&_button]:min-w-11 [&_button]:max-w-full [&_button]:whitespace-normal [&_button]:wrap-anywhere">
            {actions}
          </div>
        ) : null
      ) : (
        <ViewHeadingActions label={label} actions={actions} />
      )}
      <PageStreamHeadingContext value={ownHeading ? String(streams[0]!.props.id) : undefined}>
        <SubjectPage {...page} framed />
      </PageStreamHeadingContext>
      {nextHref && !ownContinuation ? (
        <a
          data-slot="next-page"
          href={nextHref}
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

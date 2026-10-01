import { Alert, AlertDescription, AlertTitle } from '@rezics/ui/alert';
import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { BookOpenIcon, CircleAlertIcon } from 'lucide-react';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import { RateWork, type ReaderActions, ReaderActionsProvider, ShelfButton } from '../catalogue/reader-actions.tsx';
import type { RatingTarget, ReaderSeed } from '../catalogue/reader-store.ts';
import { coverKindOf, type CatalogueAuthor } from '../catalogue/work.ts';
import { CatalogueCover } from '../catalogue/cover.tsx';
import { ReportAction } from '../safety/report-action.tsx';
import Link from '../shell/localized-link.tsx';
import { PageContainer } from '../shell/page.tsx';
import type { WorkPageMessages } from './messages.ts';
import type { ReadStart } from './read.ts';
import { type WorkAt, workHref } from './route.ts';
import type { WorkHeader as Header } from './types.ts';
import { WorkHeader } from './work-header.tsx';
import { ACTION_ATTRIBUTE, ACTION_ID, type HubSection, hubAnchors, hubSections } from './hub.ts';
import { WorkTabs } from './work-tabs.tsx';
import { OnThisPage, StickyAction } from './work-nav.tsx';
import { type WorkExperience, showsBookControls, workExperience } from '../entity-page/experience.ts';

/**
 * The cover as a thumbnail or a rail: it fills its column, which is 6.5–8 rem beside the title on a phone and
 * the rail's width on a wide screen, so the identity and the next action share the first screen.
 */
export function WorkPageCover({ work, authors = [], avatarQuery }: {
  work: Header; authors?: readonly CatalogueAuthor[]; avatarQuery?: string;
}) {
  return <CatalogueCover work={{ id: work.id, title: work.title, cover: work.cover,
    kind: coverKindOf(work.types), authors }} avatarQuery={avatarQuery} loading="eager"
    className="w-full xl:w-60" />;
}

/**
 * Identity and the next action around every Work view. Books and other cover-led Works use one layout: on a phone
 * a thumbnail sits beside the title and the primary action, the reader's status and the shelf follow at full
 * width; on a wide screen the cover and those actions form a narrow rail that stays in view beside a readable
 * main column. Tabs belong to wide screens; a phone gets "On this page".
 */
export function WorkFrame({ workRef, work, experience = workExperience(null, work.types), credits, authors = [], cover,
  ratingLine, readAction, status, shortcuts, sections = [],
  signedIn = false, signInHref, actingSubject,
  readerSeed, ratingTarget, readerActions, avatarQuery, locale, messages, children }: {
  workRef: WorkAt; work: Header; credits: ReactNode; authors?: readonly CatalogueAuthor[];
  /** The page the Work's projection names; the registry's entry for its types when left out. */
  experience?: WorkExperience;
  /** A credited cover streamed separately from the rest of the frame. */
  cover?: ReactNode;
  /** The primary action, streamed on its own; a link to Contents when left out. */
  readAction?: ReactNode;
  /** The reader's edition and progress under the primary action, streamed on its own. */
  status?: ReactNode;
  /** Links near the header, such as the Work's wiki. */
  shortcuts?: ReactNode;
  /** The overview's sections for "On this page", in the order they are drawn. */
  sections?: readonly { id: string; label: string }[];
  /** The rating summary under the title, streamed on its own. */
  ratingLine?: ReactNode;
  signedIn?: boolean;
  /** Where the shelf and rating controls send a signed-out reader; sign-in returns here. */
  signInHref?: string;
  /** The Agent a signed-in reader acts as, their state for this Work, and what the stars rate. */
  actingSubject?: string | null; readerSeed?: ReaderSeed; ratingTarget?: RatingTarget | null;
  /** Stories supply reader actions; pages derive them from the session. */
  readerActions?: ReaderActions;
  avatarQuery?: string;
  locale: UiLocale; messages: WorkPageMessages; children: ReactNode;
}) {
  const nav = <>
    <WorkTabs workRef={workRef} label={messages.sections} labels={{ overview: messages.overview,
      contents: messages.contents, versions: messages.versions, discussion: messages.discussion,
      history: messages.history }} />
    <OnThisPage workRef={workRef} label={messages.pageSections} viewsLabel={messages.sections} sections={sections}
      labels={{ overview: messages.overview, contents: messages.contents, versions: messages.versions,
        discussion: messages.discussion, history: messages.history }} />
  </>;
  const primary = readAction === undefined ? <ReadButton workRef={workRef} start={{ kind: 'contents' }}
    messages={messages} /> : readAction;
  if (!showsBookControls(experience)) {
    return <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref ?? '/auth/start'}
      actingSubject={actingSubject} seed={readerSeed} ratingTarget={ratingTarget} actions={readerActions}>
      <PageContainer className="grid gap-7 [text-autospace:normal]">
        <div className="grid min-w-0 gap-5 border-border/60 border-b pb-6 sm:grid-cols-[minmax(0,1fr)_auto]">
          <div className="grid min-w-0 content-start gap-3">
            <WorkHeader work={work} credits={credits} ratingLine={ratingLine} locale={locale}
              messages={messages} />
            {shortcuts}
          </div>
          <div id={ACTION_ID} className="flex flex-wrap content-start items-center gap-2 sm:max-w-56 sm:flex-col sm:items-stretch">
            {primary}
            {status}
            <RateWork work={work.id} locale={locale} className="sm:mt-2" />
            <ReportAction target={work.id} kind="work" />
          </div>
        </div>
        {nav}
        <div className="grid min-w-0 content-start gap-8">{children}</div>
        <StickyAction label={messages.nextAction} />
      </PageContainer>
    </ReaderActionsProvider>;
  }
  return <ReaderActionsProvider signedIn={signedIn} signInHref={signInHref ?? '/auth/start'} actingSubject={actingSubject}
    seed={readerSeed} ratingTarget={ratingTarget} actions={readerActions}>
    {/* CJK text spaces itself from inserted Latin names and digits ("来自 Tidewater Readers"). */}
    <PageContainer className="grid grid-cols-[6.5rem_minmax(0,1fr)] gap-x-4 gap-y-5 [text-autospace:normal]
      sm:grid-cols-[8rem_minmax(0,1fr)] sm:gap-x-6 lg:grid-cols-[15rem_minmax(0,1fr)] lg:grid-rows-[auto_1fr]
      lg:gap-x-12 lg:gap-y-6 xl:grid-cols-[17rem_minmax(0,1fr)] xl:gap-x-16">
      {/* On a phone this column dissolves into the grid so the thumbnail sits beside the title and the actions span the width. */}
      <div className="contents lg:sticky lg:top-6 lg:col-start-1 lg:row-span-2 lg:row-start-1 lg:grid lg:content-start
        lg:gap-6 lg:self-start">
        <div className="col-start-1 row-start-1 flex justify-center lg:col-auto lg:row-auto">
          {cover ?? <WorkPageCover work={work} authors={authors} avatarQuery={avatarQuery} />}
        </div>
        <div id={ACTION_ID} className="col-span-2 row-start-2 grid w-full content-start gap-3 sm:max-w-sm
          lg:col-auto lg:row-auto lg:max-w-none">
          {primary}
          {status}
          <ShelfButton work={work.id} title={work.title.value} locale={locale} size="lg" variant="outline" />
          <RateWork work={work.id} locale={locale} className="mt-1" />
          <ReportAction target={work.id} kind="work" />
        </div>
      </div>
      <div className="col-start-2 row-start-1 grid min-w-0 content-start gap-3 lg:col-start-2">
        <WorkHeader work={work} credits={credits} ratingLine={ratingLine} locale={locale} messages={messages} />
        {shortcuts}
      </div>
      <div className="col-span-2 row-start-3 grid min-w-0 content-start gap-8 lg:col-span-1 lg:col-start-2 lg:row-start-2">
        {nav}
        {children}
      </div>
      <StickyAction label={messages.nextAction} />
    </PageContainer>
  </ReaderActionsProvider>;
}

/**
 * The primary action: start at chapter 1, or continue at the next unread
 * chapter, which is named under the button. A Work with nothing to read has
 * no Read button, so "Want to read" leads; when Main could not say, Read
 * opens Contents, which explains.
 */
export function ReadButton({ workRef, start, messages }: {
  workRef: WorkAt; start: ReadStart; messages: WorkPageMessages;
}) {
  if (!start) return null;
  const href = start.kind === 'contents' ? workHref(workRef, 'contents') : start.href;
  const label = start.kind === 'continue' ? messages.continueReadingShort
    : start.kind === 'start' ? messages.startReading : messages.read;
  return <div className="grid gap-1.5">
    <Link href={href} {...{ [ACTION_ATTRIBUTE]: '' }} className={cn(buttonVariants({ size: 'lg', pill: true }), 'w-full')}>
      <BookOpenIcon aria-hidden="true" />{label}</Link>
    {start.kind === 'continue' && start.chapter ? <p className="truncate text-center text-muted-foreground text-xs">
      {start.chapter}</p> : null}
  </div>;
}

/**
 * The Overview as `docs/plan/frontend.md#work-page` orders it, below the identity the frame leads with: About,
 * your edition and availability, parts and connections, the wiki, ratings and reviews, discussion and
 * communities, then lists and discovery, with the Work's record (identifiers and provenance) last. A section the
 * plan omits is not drawn whatever its slot holds, so a type that does not bind it never shows an empty one.
 * An unknown scope is reported in place of the scoped sections, with the switch to choose another; it is never
 * replaced by everyone's view.
 */
export function OverviewLayout({ plan, type, about, facts, classification, availability, parts, wiki, scopeBar, ratings,
  reviews, adoption, discussion, alsoEnjoyed, author, record, messages }: {
  /** The sections the Work's projection binds (`hubPlan`); they are always drawn in the documented order. */
  plan: readonly HubSection[];
  /** A recipe, prompt, skill or guide leads the About section for types that have one. */
  type?: ReactNode;
  /** The Work's description; it does not change with scope, so it comes first. */
  about?: ReactNode;
  /** Full facts, sources and Propose correction, on expansion. */
  facts?: ReactNode;
  classification?: ReactNode;
  availability?: ReactNode;
  parts?: ReactNode;
  wiki?: ReactNode;
  /** Shown on its own only when the URL names no known scope; the ratings section carries it otherwise. */
  scopeBar: ReactNode;
  /** Null when the URL names no known scope. */
  ratings: ReactNode | null;
  /** Readers' reviews, under the rating summary they share a question with. */
  reviews?: ReactNode;
  /** Communities that feature the Work. */
  adoption?: ReactNode;
  discussion?: ReactNode;
  /** Works to read next; they do not depend on the scope, so an unknown one still shows them. */
  alsoEnjoyed?: ReactNode;
  /** About the author and more by them, when the Work has a native author credit. */
  author?: ReactNode;
  /** Details, identifiers and the citation, below everything else. */
  record: ReactNode;
  messages: WorkPageMessages;
}) {
  const scoped = ratings !== null;
  const slots: Record<HubSection, ReactNode> = {
    about: <>{type}{about}{scoped ? classification : null}{facts}</>,
    availability,
    parts,
    wiki,
    ratings: scoped ? <>{ratings}{reviews}</> : <div className="grid gap-4">{scopeBar}<InvalidScope messages={messages} /></div>,
    discussion: <>{discussion}{scoped ? adoption : null}</>,
    lists: <>{alsoEnjoyed}{author}</>,
  };
  return <div className="grid min-w-0 gap-10">
    {hubSections.filter(section => plan.includes(section)).map(section => <div key={section} id={hubAnchors[section]} data-hub-section={section}
      className="grid min-w-0 scroll-mt-20 content-start gap-8 empty:hidden">{slots[section]}</div>)}
    {record}
  </div>;
}

/** The URL names no scope this page can show; it says so instead of showing everyone's view. */
export function InvalidScope({ messages }: { messages: WorkPageMessages }) {
  return <Alert variant="warning" role="alert">
    <CircleAlertIcon aria-hidden="true" />
    <AlertTitle>{messages.invalidScopeTitle}</AlertTitle>
    <AlertDescription>{messages.invalidScopeBody}</AlertDescription>
  </Alert>;
}

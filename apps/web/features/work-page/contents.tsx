'use client';

import { buttonVariants } from '@rezics/ui/button';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/collapsible';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, BookOpenIcon, ChevronDownIcon, ChevronRightIcon, FileTextIcon, ListTreeIcon }
  from 'lucide-react';
import { materializeData } from 'native-i18n';
import { useState } from 'react';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { languageName, numberedTitle, volumeName } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import type { readContentsGroup } from './contents-actions.ts';
import { Region, RegionFailure } from './region.tsx';
import { chapterHref, type ContentsQuery, idOf, textHref, workHref } from './route.ts';
import type { ContentsPage, Loaded, WorkName } from './types.ts';

type Translated = ReturnType<typeof materializeData<WorkPageMessages>>;
type Item = ContentsPage['items'][number];

/** A group's name: its title, else what it is ("Volume 2", "Extras", "Untitled part"). */
export function groupName(item: Pick<Item, 'label' | 'division' | 'number'>, locale: UiLocale, t: Translated): string {
  return item.label?.value ?? (item.division === 'volume' && item.number ? volumeName(item.number, locale, t)
    : item.division === 'extras' ? t.extras : t.untitledPart);
}

/** The line under a group's name: which volume it is, when its title does not say, and its chapter count. */
function groupFacts(item: Item, locale: UiLocale, t: Translated): string {
  const kind = item.division === 'volume' && item.number
    ? item.label && !numberedTitle(item.label.value) ? volumeName(item.number, locale, t) : null
    : item.division === 'extras' ? item.label ? t.extras : null : t.part;
  return [kind, item.childCount === null ? null : t.groupChapters(item.childCount)]
    .filter((part): part is string => part !== null).join(' · ');
}

/** A chapter's entry: its title, or its number when it has none; unavailable ones are listed but not linked. */
function ChapterEntry({ item, workRef, language, t }: {
  item: Item; workRef: string; language: string | undefined; t: Translated;
}) {
  const id = idOf(item.occurrence);
  // Main withholds the label of a chapter the reader cannot read; that is not an untitled chapter.
  const label = item.label?.value ?? (item.availability === 'unavailable' ? t.unavailableChapter
    : item.number ? t.chapterNumber(item.number) : t.untitledChapter);
  const body = <>
    <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
    <span className="grid min-w-0 flex-1">
      <span lang={item.label?.language} className="truncate font-medium">{label}</span>
      {item.availability === 'unavailable'
        ? <span className="text-muted-foreground text-xs">{t.chapterNotInLanguage}</span> : null}
    </span>
  </>;
  const href = id && item.availability === 'available' ? chapterHref(workRef, id, language) : null;
  return <li>
    {href ? <Link href={href} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 outline-none
      transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
      {body}<ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" /></Link>
      : <div aria-disabled="true" className="flex items-center gap-3 py-3 opacity-70">{body}</div>}
  </li>;
}

/** The chapters of one group, loaded when it opens; Main pages them, so a long volume links to its own page. */
type GroupPage = { status: 'idle' } | { status: 'loading' } | { status: 'failed' }
  | { status: 'loaded'; items: Item[]; more: boolean };

/**
 * One volume, part or extras of the top level: a disclosure whose button says
 * what it is and how many chapters it holds. The current one arrives open with
 * its chapters; another reads its first page from Main when it first opens.
 */
function ContentsGroup({ item, workRef, query, initial, loadGroup, locale, t }: {
  item: Item; workRef: string; query: ContentsQuery; initial: ContentsPage | null;
  loadGroup: (parent: string) => Promise<ContentsPage | null>; locale: UiLocale; t: Translated;
}) {
  const [open, setOpen] = useState(initial !== null);
  const [page, setPage] = useState<GroupPage>(initial ? { status: 'loaded', items: initial.items,
    more: Boolean(initial.nextCursor) } : { status: 'idle' });
  const name = groupName(item, locale, t);
  const load = async () => {
    setPage({ status: 'loading' });
    try {
      const read = await loadGroup(item.occurrence);
      setPage(read ? { status: 'loaded', items: read.items, more: Boolean(read.nextCursor) } : { status: 'failed' });
    } catch { setPage({ status: 'failed' }); }
  };
  const groupHref = workHref(workRef, 'contents', null, { parent: idOf(item.occurrence) ?? undefined,
    language: query.language });
  return <li className="py-1">
    <Collapsible open={open} onOpenChange={details => {
      setOpen(details.open);
      if (details.open && page.status === 'idle') void load();
    }}>
      <CollapsibleTrigger className="-mx-2 flex w-[calc(100%+1rem)] items-center gap-3 rounded-xl px-2 py-3 text-start
        outline-none transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <ChevronDownIcon aria-hidden="true" className={cn('size-4 shrink-0 text-muted-foreground transition-transform',
          !open && '-rotate-90 rtl:rotate-90')} />
        <span className="grid min-w-0 flex-1">
          <span lang={item.label?.language} className="truncate font-semibold">{name}</span>
          <span className="text-muted-foreground text-xs">{groupFacts(item, locale, t)}</span>
        </span>
      </CollapsibleTrigger>
      <CollapsibleContent>
        <div className="border-border/60 border-s ps-4 ms-2">
          {page.status === 'loaded' ? page.items.length ? <ol className="grid divide-y divide-border/60">
            {page.items.map(child => child.role === 'chapter'
              ? <ChapterEntry key={child.occurrence} item={child} workRef={workRef} language={query.language} t={t} />
              : null)}
          </ol> : <p className="py-3 text-muted-foreground text-sm">{t.noGroupChapters}</p>
            : page.status === 'failed' ? <p role="alert" className="flex flex-wrap items-center gap-2 py-3 text-sm
              text-destructive-foreground">{t.groupChaptersFailed}
              <button type="button" onClick={() => void load()} className={buttonVariants({ variant: 'outline',
                size: 'sm' })}>{t.retry}</button></p>
            : <div role="status" aria-label={t.loadingGroup} className="grid gap-2 py-3">
              <Skeleton className="h-5 w-2/3" /><Skeleton className="h-5 w-1/2" /></div>}
          {page.status === 'loaded' && page.more ? <Link href={groupHref} className={cn(buttonVariants({
            variant: 'ghost', size: 'sm' }), 'my-2')}>{t.allGroupChapters({ group: name })}</Link> : null}
        </div>
      </CollapsibleContent>
    </Collapsible>
  </li>;
}

/** A Work with no contents that is read as its one selected text: its title, kind and language. */
export interface OneText { title: WorkName; book: boolean; language: string }

/** The one entry of a Work read as one text: the whole text, opened in the reader. */
function OneTextContents({ oneText, workRef, locale, messages }: {
  oneText: OneText; workRef: string; locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const href = textHref(workRef);
  return <Region id="work-contents" title={t.contents}
    aside={<span className="text-muted-foreground text-sm">
      {t.contentsIn({ language: languageName(oneText.language, locale) })}</span>}>
    <Link href={href} className={cn(buttonVariants(), 'justify-self-start')}>
      <BookOpenIcon aria-hidden="true" />{t.startReading}</Link>
    <p className="text-muted-foreground text-sm">{oneText.book ? t.oneTextBook : t.oneTextWork}</p>
    <ol className="grid divide-y divide-border/60 border-border/60 border-y">
      <li><Link href={href} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 outline-none
        transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
        <FileTextIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
        <span className="grid min-w-0 flex-1">
          <span lang={oneText.title.language} dir={oneText.title.direction} className="truncate font-medium">
            {oneText.title.value}</span>
          <span className="text-muted-foreground text-xs">{t.wholeText}</span>
        </span>
        <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" /></Link></li>
    </ol>
  </Region>;
}

/**
 * The Main Version's table of contents. The top level lists chapters and the
 * Book's volumes, parts and extras; each group opens in place, the current one
 * already open. A group's own page (`parent`) lists all its chapters, paged. A
 * chapter with no publication in this language is listed but not linked, so the
 * gap is visible. A Work with no contents but a selected text lists that text.
 */
export function ContentsRegion({ contents, workRef, id, query, oneText = null, opened = null, loadGroup, groupAction,
  locale, messages }: {
  contents: Loaded<ContentsPage>; workRef: string; query: ContentsQuery;
  /** The Work's ID, for reading a group's chapters when it opens. */
  id?: string;
  /** The text the Work is read as when it has no contents; null when it has none. */
  oneText?: OneText | null;
  /** The open group's first page of chapters, read with the top level. */
  opened?: { occurrence: string; page: ContentsPage } | null;
  /** Reads a group's first page; stories pass a stand-in. */
  loadGroup?: (parent: string) => Promise<ContentsPage | null>;
  /** The page's server action that reads a group as the page reads (`contents-actions.ts`). */
  groupAction?: typeof readContentsGroup;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const readGroup = loadGroup ?? (groupAction && id
    ? (parent: string) => groupAction(id, idOf(parent) ?? '', query.language) : null);
  const here = { parent: query.parent, language: query.language };
  const firstPage = workHref(workRef, 'contents', null, here);
  const back = query.parent ? <Link href={workHref(workRef, 'contents', null, { language: query.language,
    open: query.parent })} className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-self-start')}>
    <ArrowLeftIcon aria-hidden="true" className="rtl:rotate-180" />{t.backToContents}</Link> : null;
  // Main answers 404 when the Main Version has no composition, and 400 when it has no language to read in.
  const none = !contents.ok && (contents.failure === 'missing' || (contents.failure === 'invalid' && !query.cursor));
  const empty = contents.ok && !contents.data.items.length && !query.parent && !query.cursor;
  if ((none || empty) && oneText && !query.parent) {
    return <OneTextContents oneText={oneText} workRef={workRef} locale={locale} messages={messages} />;
  }
  if (none) {
    return <Region id="work-contents" title={t.contents}>
      {back}
      <EmptyState icon={ListTreeIcon} headingLevel={3} title={t.noContents} description={t.noContentsBody} />
    </Region>;
  }
  if (!contents.ok) {
    return <Region id="work-contents" title={t.contents}>
      {back}
      <RegionFailure title={t.contentsUnavailable} failure={contents.failure} messages={messages} restartHref={firstPage} />
    </Region>;
  }
  const { items, nextCursor, language } = contents.data;
  const firstChapter = !query.parent && !query.cursor ? items.find(item => item.role === 'chapter'
    && item.availability === 'available') ?? (items[0]?.role === 'group' && opened?.occurrence === items[0].occurrence
    ? opened.page.items.find(item => item.role === 'chapter' && item.availability === 'available') : undefined)
    : undefined;
  const firstId = firstChapter ? idOf(firstChapter.occurrence) : null;
  return <Region id="work-contents" title={t.contents}
    aside={language ? <span className="text-muted-foreground text-sm">
      {t.contentsIn({ language: languageName(language, locale) })}</span> : null}>
    {firstId ? <Link href={chapterHref(workRef, firstId, query.language)}
      className={cn(buttonVariants(), 'justify-self-start')}>
      <BookOpenIcon aria-hidden="true" />{t.startReading}</Link> : null}
    {back}
    {items.length ? <ol className="grid divide-y divide-border/60 border-border/60 border-y">
      {items.map(item => item.role === 'group' && readGroup
        ? <ContentsGroup key={item.occurrence} item={item} workRef={workRef} query={query}
          initial={opened?.occurrence === item.occurrence ? opened.page : null} loadGroup={readGroup}
          locale={locale} t={t} />
        : item.role === 'group' ? <li key={item.occurrence}>
          <Link href={workHref(workRef, 'contents', null, { parent: idOf(item.occurrence) ?? undefined,
            language: query.language })} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 outline-none
            transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            <ListTreeIcon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
            <span className="grid min-w-0 flex-1">
              <span lang={item.label?.language} className="truncate font-semibold">{groupName(item, locale, t)}</span>
              <span className="text-muted-foreground text-xs">{groupFacts(item, locale, t)}</span>
            </span>
            <ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground rtl:rotate-180" /></Link>
        </li>
        : <ChapterEntry key={item.occurrence} item={item} workRef={workRef} language={query.language} t={t} />)}
    </ol> : <EmptyState icon={ListTreeIcon} headingLevel={3} title={t.noContents} />}
    {query.cursor || nextCursor ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {query.cursor ? <Link href={firstPage} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={workHref(workRef, 'contents', null, { ...here, cursor: nextCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}

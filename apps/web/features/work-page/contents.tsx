import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import { ArrowLeftIcon, BookOpenIcon, ChevronRightIcon, FileTextIcon, FolderIcon, ListTreeIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { UiLocale } from '../../i18n/define.ts';
import { EmptyState } from '../shell/empty-state.tsx';
import { languageName } from './format.ts';
import type { WorkPageMessages } from './messages.ts';
import { Region, RegionFailure } from './region.tsx';
import { chapterHref, type ContentsQuery, idOf, textHref, workHref } from './route.ts';
import type { ContentsPage, Loaded, WorkName } from './types.ts';

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
 * One level of the Main Version's table of contents. Parts open their own
 * level; chapters open the reader; a chapter with no publication in this
 * language is listed but not linked, so the gap is visible. A Work with no
 * contents but a selected text lists that text as its one entry.
 */
export function ContentsRegion({ contents, workRef, query, oneText = null, locale, messages }: {
  contents: Loaded<ContentsPage>; workRef: string; query: ContentsQuery;
  /** The text the Work is read as when it has no contents; null when it has none. */
  oneText?: OneText | null;
  locale: UiLocale; messages: WorkPageMessages;
}) {
  const t = materializeData(messages, { locale });
  const here = { parent: query.parent, language: query.language };
  const firstPage = workHref(workRef, 'contents', null, here);
  const back = query.parent ? <Link href={workHref(workRef, 'contents', null, { language: query.language })}
    className={cn(buttonVariants({ variant: 'ghost', size: 'sm' }), 'justify-self-start')}>
    <ArrowLeftIcon aria-hidden="true" />{t.backToContents}</Link> : null;
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
  const first = !query.parent && !query.cursor
    ? items.find(item => item.role === 'chapter' && item.availability === 'available') : undefined;
  const firstId = first ? idOf(first.occurrence) : null;
  // A chapter without a title is named by its place, which a page after the first cannot know.
  const numbers = new Map(query.cursor ? [] : items.filter(item => item.role === 'chapter')
    .map((item, index) => [item.occurrence, index + 1] as const));
  return <Region id="work-contents" title={t.contents}
    aside={language ? <span className="text-muted-foreground text-sm">
      {t.contentsIn({ language: languageName(language, locale) })}</span> : null}>
    {firstId ? <Link href={chapterHref(workRef, firstId, query.language)}
      className={cn(buttonVariants(), 'justify-self-start')}>
      <BookOpenIcon aria-hidden="true" />{t.startReading}</Link> : null}
    {back}
    {items.length ? <ol className="grid divide-y divide-border/60 border-border/60 border-y">
      {items.map(item => {
        const id = idOf(item.occurrence);
        const group = item.role === 'group';
        // Main withholds the label of a chapter the reader cannot read; that is not an untitled chapter.
        const number = numbers.get(item.occurrence);
        const label = item.label?.value ?? (group ? t.untitledPart
          : item.availability === 'unavailable' ? t.unavailableChapter
            : number && !query.parent ? t.chapterNumber(number) : t.untitledChapter);
        const Icon = group ? FolderIcon : FileTextIcon;
        const body = <>
          <Icon aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          <span className="grid min-w-0 flex-1">
            <span lang={item.label?.language} className="truncate font-medium">{label}</span>
            {group ? <span className="text-muted-foreground text-xs">{t.part}</span> : null}
            {item.availability === 'unavailable'
              ? <span className="text-muted-foreground text-xs">{t.chapterNotInLanguage}</span> : null}
          </span>
        </>;
        const href = !id ? null : group ? workHref(workRef, 'contents', null, { parent: id, language: query.language })
          : item.availability === 'available' ? chapterHref(workRef, id, query.language) : null;
        return <li key={item.occurrence}>
          {href ? <Link href={href} className="-mx-2 flex items-center gap-3 rounded-xl px-2 py-3 outline-none
            transition-colors hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring">
            {body}<ChevronRightIcon aria-hidden="true" className="size-4 text-muted-foreground" /></Link>
            : <div aria-disabled="true" className="flex items-center gap-3 py-3 opacity-70">{body}</div>}
        </li>;
      })}
    </ol> : <EmptyState icon={ListTreeIcon} headingLevel={3} title={t.noContents} />}
    {query.cursor || nextCursor ? <nav aria-label={t.pagination} className="flex flex-wrap justify-between gap-2">
      {query.cursor ? <Link href={firstPage} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
        {t.firstPage}</Link> : <span />}
      {nextCursor ? <Link href={workHref(workRef, 'contents', null, { ...here, cursor: nextCursor })}
        className={buttonVariants({ variant: 'outline', size: 'sm' })}>{t.nextPage}</Link> : null}
    </nav> : null}
  </Region>;
}

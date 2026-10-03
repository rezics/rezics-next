import { cn } from '@rezics/ui/utils';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { AuthorNames } from './author-names.tsx';
import { messages } from './messages.ts';
import { RatingInline } from './rating.tsx';
import { ShelfMark } from './reader-actions.tsx';
import { CatalogueCover } from './cover.tsx';
import { type CatalogueWork, otherLanguageTitle, shortWorkId } from './work.ts';

/** A Work's display title, or its short ID while Main cannot name it. */
export function workTitle(work: Pick<CatalogueWork, 'id' | 'title'>, locale: UiLocale): string {
  return work.title?.value ?? materializeData(messages[locale], { locale }).untitled({ id: shortWorkId(work.id) });
}

/**
 * The cover as a link to the Work. It repeats the title link, so it is left
 * out of the tab order and the accessibility tree; the title is the one stop.
 */
export function CoverLink({ work, avatarQuery, size, className, children }: {
  work: CatalogueWork; avatarQuery?: string; size?: 'xs' | 'sm' | 'md' | 'lg' | 'xl' | 'fill'; className?: string;
  children?: ReactNode;
}) {
  return <div className={cn('relative', className)}>
    <Link href={work.href} tabIndex={-1} aria-hidden="true" className="block outline-none">
      <CatalogueCover work={work} avatarQuery={avatarQuery} size={size}
        className="transition-[translate,box-shadow] duration-300 ease-out group-hover/tile:-translate-y-1
          group-hover/tile:shadow-[0_2px_4px_rgb(0_0_0/0.1),0_16px_32px_-12px_rgb(0_0_0/0.4)]
          motion-reduce:transition-none" />
    </Link>
    {children}
  </div>;
}

/**
 * One Work in a shelf or grid, Goodreads-style: a tall cover with no card
 * around it, the title in the Work-title face, authors in grey and a compact
 * rating. The shelf control sits on the cover's corner.
 */
export function WorkTile({ work, slot = 2 / 3, headingLevel = 3, avatarQuery, locale, titleStart, titleEnd,
  className }: {
  work: CatalogueWork;
  /** The row's tallest cover proportion; shorter covers stand on its foot so titles line up. */
  slot?: number;
  headingLevel?: 2 | 3 | 4;
  avatarQuery?: string;
  locale: UiLocale;
  /**
   * Marks beside the title, such as a chart position before it and a Zone's
   * "Why here?" stamp after it. They stay off the cover, whose own title
   * they would hide.
   */
  titleStart?: ReactNode;
  titleEnd?: ReactNode;
  className?: string;
}) {
  const t = materializeData(messages[locale], { locale });
  const Heading = `h${headingLevel}` as const;
  const title = workTitle(work, locale);
  const unfinished = work.completion === 'ongoing' || work.completion === 'hiatus';
  // Relative, so screen-reader-only text stays inside a scrolling row rather than widening the page.
  return <article className={cn('group/tile relative flex min-w-0 flex-col', className)}>
    <div className="relative w-full" style={{ aspectRatio: String(slot) }}>
      <CoverLink work={work} avatarQuery={avatarQuery} className="absolute inset-x-0 bottom-0 w-full">
        <ShelfMark work={work.id} title={title} locale={locale} />
      </CoverLink>
    </div>
    <div className="mt-3 flex min-w-0 items-start gap-1.5">
      {titleStart}
      <Heading lang={work.title?.language} dir={work.title?.direction}
        className="line-clamp-2 min-w-0 flex-1 text-pretty font-medium font-work-title text-[1.0625rem]/snug">
        <Link href={work.href} className="rounded-sm outline-none decoration-1 underline-offset-2 hover:underline
          focus-visible:ring-2 focus-visible:ring-ring">{title}</Link>
      </Heading>
      {titleEnd}
    </div>
    {otherLanguageTitle(work.title, locale) ? <p className="sr-only">{t.fallbackTitle}</p> : null}
    {work.authors.length ? <p className="mt-0.5 truncate text-muted-foreground text-sm">
      <AuthorNames authors={work.authors} /></p>
      : null}
    {work.creditSummary ? <p className="mt-0.5 text-muted-foreground text-xs">{work.creditSummary}</p> : null}
    {/* An unfinished serial says so beside its rating, clear of the cover's own title and author. */}
    {work.rating || unfinished ? <div className="mt-1 flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
      {work.rating ? <RatingInline rating={work.rating} locale={locale} /> : null}
      {unfinished ? <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-[0.6875rem] text-muted-foreground">
        {work.completion === 'ongoing' ? t.ongoing : t.hiatus}</span> : null}
    </div> : null}
    {work.tagline ? <p lang={work.tagline.language} dir={work.tagline.direction}
      className="mt-1.5 line-clamp-2 text-pretty text-muted-foreground text-sm/snug">{work.tagline.value}</p> : null}
  </article>;
}

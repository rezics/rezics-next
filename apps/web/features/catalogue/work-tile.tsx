import { cn } from '@rezics/ui/utils';
import { WorkCover } from '@rezics/ui/work-cover';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { messages } from './messages.ts';
import { RatingInline } from './rating.tsx';
import { ShelfMark } from './reader-actions.tsx';
import { type CatalogueWork, coverImage, shortWorkId } from './work.ts';

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
      <WorkCover title={work.title?.value ?? ''} lang={work.title?.language} dir={work.title?.direction}
        authors={work.authors} kind={work.kind} seed={work.cover?.kind === 'fallback' ? work.cover.key : work.id}
        image={coverImage(work.cover, avatarQuery)} size={size}
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
export function WorkTile({ work, slot = 2 / 3, headingLevel = 3, avatarQuery, locale, className }: {
  work: CatalogueWork;
  /** The row's tallest cover proportion; shorter covers stand on its foot so titles line up. */
  slot?: number;
  headingLevel?: 2 | 3 | 4;
  avatarQuery?: string;
  locale: UiLocale;
  className?: string;
}) {
  const t = materializeData(messages[locale], { locale });
  const Heading = `h${headingLevel}` as const;
  const title = workTitle(work, locale);
  // Relative, so screen-reader-only text stays inside a scrolling row rather than widening the page.
  return <article className={cn('group/tile relative flex min-w-0 flex-col', className)}>
    <div className="flex items-end" style={{ aspectRatio: String(slot) }}>
      <CoverLink work={work} avatarQuery={avatarQuery} className="w-full">
        {work.completion === 'ongoing' || work.completion === 'hiatus'
          ? <span className="absolute start-2 bottom-2 z-20 rounded-full bg-background/92 px-2 py-0.5 font-medium
            text-[0.6875rem] text-foreground shadow-[0_1px_4px_rgb(0_0_0/0.18)] backdrop-blur">
            {work.completion === 'ongoing' ? t.ongoing : t.hiatus}</span> : null}
        <ShelfMark work={work.id} title={title} locale={locale} />
      </CoverLink>
    </div>
    <Heading lang={work.title?.language} dir={work.title?.direction}
      className="mt-3 line-clamp-2 text-pretty font-medium font-work-title text-[1.0625rem]/snug">
      <Link href={work.href} className="rounded-sm outline-none decoration-1 underline-offset-2 hover:underline
        focus-visible:ring-2 focus-visible:ring-ring">{title}</Link>
    </Heading>
    {work.title?.basis === 'fallback' ? <p className="sr-only">{t.fallbackTitle}</p> : null}
    {work.authors.length ? <p className="mt-0.5 truncate text-muted-foreground text-sm">{work.authors.join(', ')}</p>
      : null}
    {work.rating ? <RatingInline rating={work.rating} locale={locale} className="mt-1" /> : null}
    {work.tagline ? <p lang={work.tagline.language} dir={work.tagline.direction}
      className="mt-1.5 line-clamp-2 text-pretty text-muted-foreground text-sm/snug">{work.tagline.value}</p> : null}
  </article>;
}

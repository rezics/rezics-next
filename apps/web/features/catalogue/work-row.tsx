import { cn } from '@rezics/ui/utils';
import { materializeData } from 'native-i18n';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { AuthorNames } from './author-names.tsx';
import { messages } from './messages.ts';
import { RatingInline } from './rating.tsx';
import { ShelfButton } from './reader-actions.tsx';
import { type CatalogueWork, otherLanguageTitle } from './work.ts';
import { CoverLink, workTitle } from './work-tile.tsx';

/**
 * One Work in a result list: cover, title, authors and rating, why it is
 * here beneath, and the shelf action at the end of the row.
 */
export function WorkRow({ work, headingLevel = 2, avatarQuery, locale, shelf = 'primary', children, className }: {
  work: CatalogueWork; headingLevel?: 2 | 3; avatarQuery?: string; locale: UiLocale;
  /**
   * The shelf action's weight: `primary` where shelving is what the list is
   * for (search), `secondary` in a list that is about someone (a profile),
   * `none` on the reader's own Works.
   */
  shelf?: 'primary' | 'secondary' | 'none';
  /** Why the Work is listed, such as search match reasons. */
  children?: ReactNode;
  className?: string;
}) {
  const t = materializeData(messages[locale], { locale });
  const Heading = `h${headingLevel}` as const;
  const title = workTitle(work, locale);
  return <article className={cn('group/tile relative grid grid-cols-[4.5rem_minmax(0,1fr)] gap-x-4 sm:grid-cols-[5.5rem_minmax(0,1fr)_auto]',
    'sm:gap-x-6', className)}>
    <CoverLink work={work} avatarQuery={avatarQuery} className="row-span-2 self-start sm:row-span-1" />
    <div className="grid min-w-0 content-start gap-1">
      <Heading lang={work.title?.language} dir={work.title?.direction}
        className="text-pretty font-medium font-work-title text-lg/snug [overflow-wrap:anywhere] sm:text-xl/snug">
        <Link href={work.href} className="rounded-sm outline-none decoration-1 underline-offset-2 hover:underline
          focus-visible:ring-2 focus-visible:ring-ring">{title}</Link>
      </Heading>
      {otherLanguageTitle(work.title, locale) ? <p className="sr-only">{t.fallbackTitle}</p> : null}
      {work.authors.length ? <p className="text-muted-foreground"><AuthorNames authors={work.authors} /></p> : null}
      {work.rating ? <RatingInline rating={work.rating} locale={locale} /> : null}
      {work.tagline ? <p lang={work.tagline.language} dir={work.tagline.direction}
        className="line-clamp-2 text-pretty text-muted-foreground">{work.tagline.value}</p> : null}
      {children ? <div className="mt-1.5 text-muted-foreground text-sm">{children}</div> : null}
    </div>
    {shelf === 'none' ? null : <div className="col-start-2 mt-3 self-start sm:col-start-3 sm:mt-0">
      <ShelfButton work={work.id} title={title} locale={locale} size="sm"
        variant={shelf === 'secondary' ? 'outline' : 'default'} className="w-44" />
    </div>}
  </article>;
}

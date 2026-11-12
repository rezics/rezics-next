import type { ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale, type Locale } from '../../paraglide/runtime.js';
import { hostedBookHref, hostedBookSubjectHref } from './address';

/** Catalogue and Studio share the same reader destination; a draft revision is never a public read selector. */
export function HostedBookReaderLink({
  catalogueId,
  subjectId,
  releaseRevisionId,
  locale = getLocale(),
  children,
}: {
  catalogueId: string;
  subjectId?: string;
  releaseRevisionId?: string;
  locale?: Locale;
  children?: ReactNode;
}) {
  return (
    <a
      href={hostedBookHref(catalogueId, locale, { release: releaseRevisionId, subject: subjectId })}
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 min-w-11 whitespace-normal text-start' })}
    >
      {children ?? m.book_reader_contents({}, { locale })}
    </a>
  );
}

/** Subject hosts need no inferred catalogue identity or private Progress association. */
export function HostedBookSubjectReaderLink({
  subjectId,
  locale = getLocale(),
}: {
  subjectId: string;
  locale?: string;
}) {
  return (
    <a
      href={hostedBookSubjectHref(subjectId, locale as Locale)}
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 min-w-11 whitespace-normal text-start' })}
    >
      {m.book_reader_open_books({}, { locale: locale as Locale })}
    </a>
  );
}

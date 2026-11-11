import type { ReactNode } from 'react';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { getLocale, type Locale } from '../../paraglide/runtime.js';
import { hostedBookHref } from './address';

/** Catalogue and Studio share the same reader destination; a draft revision is never a public read selector. */
export function HostedBookReaderLink({
  catalogueId,
  releaseRevisionId,
  locale = getLocale(),
  children,
}: {
  catalogueId: string;
  releaseRevisionId?: string;
  locale?: Locale;
  children?: ReactNode;
}) {
  return (
    <a
      href={hostedBookHref(catalogueId, locale, { release: releaseRevisionId })}
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 min-w-11 whitespace-normal text-start' })}
    >
      {children ?? m.book_reader_contents({}, { locale })}
    </a>
  );
}

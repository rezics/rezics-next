import { libraryShelfType, shelfHref } from '../../library/settings-adapter';
import { m } from '../../paraglide/messages.js';

export const bookLinkClass =
  'inline-flex min-h-11 min-w-11 items-center rounded-md px-3 py-2 text-sm font-medium text-primary underline-offset-4 hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';

/** Keep the originating public visit mounted. The destination owns sign-in and every private read. */
export function BookShelfLink({ locale, type }: { locale: string; type: string }) {
  if (!libraryShelfType(type)) return null;
  const options = { locale: locale as never };
  return (
    <a className={bookLinkClass} href={shelfHref(locale, { type })} target="_blank" rel="noopener">
      {m.books_catalogue_shelf({}, options)}
      <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
    </a>
  );
}

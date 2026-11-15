import { buttonVariants } from '@rezics/ui/shadcn/button';
import { libraryShelfType, shelfHref } from '../../library/settings-adapter';
import { m } from '../../paraglide/messages.js';

export const bookLinkClass = buttonVariants({
  variant: 'link',
  className: 'h-auto min-h-7 max-w-full justify-start whitespace-normal [overflow-wrap:anywhere]',
});

/** Keep the originating public visit mounted. The destination owns sign-in and every private read. */
export function BookShelfLink({
  locale,
  type,
  label,
  language,
}: {
  locale: string;
  type: string;
  label?: string;
  language?: string | null;
}) {
  if (!libraryShelfType(type)) return null;
  const options = { locale: locale as never };
  return (
    <a className={bookLinkClass} href={shelfHref(locale, { type })} target="_blank" rel="noopener">
      {label && (
        <>
          <span lang={language ?? undefined}>{label}</span>
          <span aria-hidden="true"> — </span>
        </>
      )}
      {m.books_catalogue_shelf({}, options)}
      <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
    </a>
  );
}

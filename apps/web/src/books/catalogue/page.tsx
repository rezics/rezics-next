import { useId } from 'react';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { bookDiscoveryHref, type BookCatalogueChoice } from './model';
import { BookShelfLink, bookLinkClass } from './shelf-link';

export function BookCataloguePage({
  locale,
  choices,
}: {
  locale: string;
  choices: readonly BookCatalogueChoice[];
}) {
  const options = { locale: locale as never };
  const queryId = useId();
  const typeId = useId();
  const ready = choices.filter((choice) => choice.state === 'ready');
  const label = (choice: BookCatalogueChoice) => choice.label || choice.type;

  return (
    <section className="mx-auto max-w-5xl space-y-8">
      <header className="space-y-3">
        <PageHeading>{m.books_catalogue_title({}, options)}</PageHeading>
        <p className="max-w-prose text-muted-foreground">{m.books_catalogue_intro({}, options)}</p>
        <p className="max-w-prose text-sm text-muted-foreground">{m.books_catalogue_return({}, options)}</p>
      </header>
      {ready.length > 0 && (
        <form action={`/${locale}/search`} method="get" target="_blank" rel="noopener" className="flex flex-wrap items-end gap-3">
          <div className="min-w-0 flex-1 basis-64 space-y-2">
            <label htmlFor={queryId} className="block text-sm font-medium">{m.search_heading({}, options)}</label>
            <input id={queryId} name="q" type="search" className="min-h-11 w-full rounded-md border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring" />
          </div>
          <div className="min-w-0 space-y-2">
            <label htmlFor={typeId} className="block text-sm font-medium">{m.books_catalogue_kind({}, options)}</label>
            <select id={typeId} name="type" className="min-h-11 max-w-full rounded-md border bg-background px-3 text-foreground focus-visible:outline-2 focus-visible:outline-ring">
              {ready.map((choice) => <option key={choice.type} value={choice.type} lang={choice.language ?? undefined}>{label(choice)}</option>)}
            </select>
          </div>
          <button className={bookLinkClass} type="submit">
            {m.nav_search({}, options)}
            <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
          </button>
        </form>
      )}
      <ul className="grid min-w-0 gap-4 md:grid-cols-3">
        {choices.map((choice) => (
          <li key={choice.type} className="flex min-w-0 flex-col gap-4 rounded-xl border p-5">
            <h2 className="text-xl font-semibold [overflow-wrap:anywhere]" lang={choice.language ?? undefined}>{label(choice)}</h2>
            {choice.state === 'ready' ? (
              <>
                {choice.description && <p className="text-sm text-muted-foreground [overflow-wrap:anywhere]" lang={choice.descriptionLanguage ?? undefined}>{choice.description}</p>}
                <div className="mt-auto flex flex-wrap gap-1">
                  <a className={bookLinkClass} href={bookDiscoveryHref(locale, choice.type)} target="_blank" rel="noopener">
                    {m.books_catalogue_browse({}, options)}
                    <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
                  </a>
                  <BookShelfLink locale={locale} type={choice.type} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">{choice.state === 'missing' ? m.books_catalogue_missing({}, options) : m.books_catalogue_unavailable({}, options)}</p>
            )}
          </li>
        ))}
      </ul>
      {choices.some((choice) => choice.state === 'unavailable') && (
        <a className={bookLinkClass} href={`/${locale}/books`}>{m.books_catalogue_retry({}, options)}</a>
      )}
      <a className={bookLinkClass} href={`/${locale}/library/continue`} target="_blank" rel="noopener">
        {m.library_continue({}, options)}
        <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
      </a>
    </section>
  );
}

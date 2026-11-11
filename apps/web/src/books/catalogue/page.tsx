import { useId } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { bookDiscoveryHref, type BookCatalogueChoice } from './model';
import { BookShelfLink, bookLinkClass } from './shelf-link';

const choiceLabel = (choice: BookCatalogueChoice) => choice.label || choice.type;

/** Submit the exact released Type to Search's canonical route; Search admits the query. */
function BookSearch({ locale, choices }: { locale: string; choices: readonly BookCatalogueChoice[] }) {
  const queryId = useId();
  const typeId = useId();
  const options = { locale: locale as never };
  return (
    <form
      action={`/${locale}/search`}
      method="get"
      target="_blank"
      rel="noopener"
      className="flex min-w-0 flex-wrap items-end gap-3"
    >
      <Field className="min-w-0 flex-1 basis-64">
        <FieldLabel htmlFor={queryId}>{m.search_heading({}, options)}</FieldLabel>
        <Input id={queryId} name="q" type="search" className="min-h-11" />
      </Field>
      <Field className="min-w-0 basis-52">
        <FieldLabel htmlFor={typeId}>{m.books_catalogue_kind({}, options)}</FieldLabel>
        <Select
          name="type"
          defaultValue={choices[0]!.type}
          items={choices.map((choice) => ({
            value: choice.type,
            label: <span lang={choice.language ?? undefined}>{choiceLabel(choice)}</span>,
          }))}
        >
          <SelectTrigger id={typeId} className="min-h-11 w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {choices.map((choice) => (
                <SelectItem key={choice.type} value={choice.type}>
                  <span lang={choice.language ?? undefined}>{choiceLabel(choice)}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Button className="min-h-11" type="submit">
        {m.nav_search({}, options)}
        <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
      </Button>
    </form>
  );
}

export function BookCataloguePage({ locale, choices }: { locale: string; choices: readonly BookCatalogueChoice[] }) {
  const options = { locale: locale as never };
  const ready = choices.filter((choice) => choice.state === 'ready');
  return (
    <section className="mx-auto max-w-5xl space-y-8" data-slot="book-catalogue">
      <header className="space-y-3">
        <PageHeading>{m.books_catalogue_title({}, options)}</PageHeading>
        <p className="max-w-prose text-muted-foreground">{m.books_catalogue_intro({}, options)}</p>
        <p className="max-w-prose text-sm text-muted-foreground">{m.books_catalogue_return({}, options)}</p>
      </header>
      {ready.length > 0 && <BookSearch key={ready.map(({ type }) => type).join('|')} locale={locale} choices={ready} />}
      <ul className="grid min-w-0 gap-4 md:grid-cols-3">
        {choices.map((choice) => (
          <li
            key={choice.type}
            className="flex min-w-0 flex-col gap-4 rounded-xl border p-5"
            data-book-type={choice.type}
          >
            <h2 className="text-xl font-semibold [overflow-wrap:anywhere]" lang={choice.language ?? undefined}>
              {choiceLabel(choice)}
            </h2>
            {choice.state === 'ready' ? (
              <>
                {choice.description && (
                  <p
                    className="text-sm text-muted-foreground [overflow-wrap:anywhere]"
                    lang={choice.descriptionLanguage ?? undefined}
                  >
                    {choice.description}
                  </p>
                )}
                <div className="mt-auto flex flex-wrap gap-1">
                  <a
                    className={bookLinkClass}
                    href={bookDiscoveryHref(locale, choice.type)}
                    target="_blank"
                    rel="noopener"
                  >
                    {m.books_catalogue_browse({}, options)}
                    <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
                  </a>
                  <BookShelfLink locale={locale} type={choice.type} />
                </div>
              </>
            ) : (
              <p className="text-sm text-muted-foreground">
                {choice.state === 'missing'
                  ? m.books_catalogue_missing({}, options)
                  : m.books_catalogue_unavailable({}, options)}
              </p>
            )}
          </li>
        ))}
      </ul>
      {choices.some((choice) => choice.state === 'unavailable') && (
        <a className={bookLinkClass} href={`/${locale}/books`}>
          {m.books_catalogue_retry({}, options)}
        </a>
      )}
      <a className={bookLinkClass} href={`/${locale}/library/continue`} target="_blank" rel="noopener">
        {m.library_continue({}, options)}
        <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
      </a>
    </section>
  );
}

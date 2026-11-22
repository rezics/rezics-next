import { useId } from 'react';
import { ArrowUpRight, BookCopy, BookOpen, LibraryBig } from 'lucide-react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Field, FieldLabel } from '@rezics/ui/shadcn/field';
import { Input } from '@rezics/ui/shadcn/input';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';
import { cn } from '@rezics/ui/utils';
import { m } from '../../paraglide/messages.js';
import { PageHeading } from '../../shell/page-heading';
import { bookDiscoveryHref, type BookCatalogueChoice } from './model';
import { BookShelfLink, bookLinkClass } from './shelf-link';

const bookKinds = {
  'schema:Book': { label: m.work_franchise_kind_book, Icon: BookOpen },
  'schema:BookSeries': { label: m.work_franchise_kind_book_series, Icon: LibraryBig },
  'bf:Instance': { label: m.library_copy_edition, Icon: BookCopy },
};

function choiceLabel(choice: BookCatalogueChoice, locale: string) {
  if (choice.label && choice.label !== choice.type) return choice.label;
  return bookKinds[choice.type].label({}, { locale: locale as never });
}

const browseClass = cn(
  buttonVariants({ variant: 'outline' }),
  'h-auto min-h-7 max-w-full shrink justify-center whitespace-normal [overflow-wrap:anywhere]',
);

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
      data-slot="book-catalogue-search"
      className="flex min-w-0 flex-col flex-wrap gap-3 rounded-lg border bg-card p-4 sm:flex-row sm:items-end"
    >
      <Field className="min-w-0 sm:flex-1 sm:basis-60">
        <FieldLabel htmlFor={queryId}>{m.search_heading({}, options)}</FieldLabel>
        <Input id={queryId} name="q" type="search" />
      </Field>
      <Field className="min-w-0 sm:basis-44">
        <FieldLabel htmlFor={typeId}>{m.books_catalogue_kind({}, options)}</FieldLabel>
        <Select
          name="type"
          defaultValue={choices[0]!.type}
          items={choices.map((choice) => ({
            value: choice.type,
            label: <span lang={choice.language ?? undefined}>{choiceLabel(choice, locale)}</span>,
          }))}
        >
          <SelectTrigger id={typeId} className="w-full">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              {choices.map((choice) => (
                <SelectItem key={choice.type} value={choice.type}>
                  <span lang={choice.language ?? undefined}>{choiceLabel(choice, locale)}</span>
                </SelectItem>
              ))}
            </SelectGroup>
          </SelectContent>
        </Select>
      </Field>
      <Button className="h-auto min-h-7 w-full min-w-0 whitespace-normal sm:w-auto" type="submit">
        {m.nav_search({}, options)}
        <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
      </Button>
    </form>
  );
}

function TypeRow({ locale, choice }: { locale: string; choice: BookCatalogueChoice }) {
  const options = { locale: locale as never };
  const title = choiceLabel(choice, locale);
  const { Icon } = bookKinds[choice.type];
  return (
    <li
      className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] items-start gap-x-3 gap-y-2 py-4 sm:grid-cols-[auto_minmax(0,1fr)_auto] sm:items-center sm:gap-x-4"
      data-book-type={choice.type}
    >
      <span className="row-span-2 grid size-10 place-items-center rounded-lg bg-muted text-muted-foreground sm:row-span-1">
        <Icon className="size-5" strokeWidth={1.6} aria-hidden="true" />
      </span>
      <div className="min-w-0 space-y-1">
        <h2
          className="text-lg font-semibold tracking-tight [overflow-wrap:anywhere]"
          lang={choice.language ?? undefined}
        >
          {title}
        </h2>
        {choice.state === 'ready' ? (
          choice.description ? (
            <p
              className="max-w-prose text-sm text-muted-foreground [overflow-wrap:anywhere]"
              lang={choice.descriptionLanguage ?? undefined}
            >
              {choice.description}
            </p>
          ) : null
        ) : (
          <p className="text-sm text-muted-foreground">
            {choice.state === 'missing'
              ? m.books_catalogue_missing({}, options)
              : m.books_catalogue_unavailable({}, options)}
          </p>
        )}
      </div>
      {choice.state === 'ready' ? (
        <a
          className={cn(browseClass, 'col-start-2 justify-self-start sm:col-start-3')}
          href={bookDiscoveryHref(locale, choice.type)}
          target="_blank"
          rel="noopener"
        >
          {m.books_catalogue_browse({}, options)} <ArrowUpRight aria-hidden="true" />
          <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
        </a>
      ) : null}
    </li>
  );
}

export function BookCataloguePage({ locale, choices }: { locale: string; choices: readonly BookCatalogueChoice[] }) {
  const options = { locale: locale as never };
  const ready = choices.filter((choice) => choice.state === 'ready');
  return (
    <section className="mx-auto min-w-0 max-w-3xl space-y-5" data-slot="book-catalogue">
      <header className="space-y-3">
        <PageHeading>{m.books_catalogue_title({}, options)}</PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">
          {m.books_catalogue_intro({}, options)}
        </p>
      </header>
      {ready.length > 0 && <BookSearch key={ready.map(({ type }) => type).join('|')} locale={locale} choices={ready} />}
      <ul className="min-w-0 divide-y border-y" data-slot="book-catalogue-types">
        {choices.map((choice) => (
          <TypeRow key={choice.type} locale={locale} choice={choice} />
        ))}
      </ul>
      {choices.some((choice) => choice.state === 'unavailable') && (
        <a className={bookLinkClass} href={`/${locale}/books`}>
          {m.books_catalogue_retry({}, options)}
        </a>
      )}
      <div className="space-y-3 pt-1" data-slot="book-catalogue-personal">
        <ul className="flex min-w-0 flex-col">
          {ready.map((choice) => (
            <li key={choice.type} className="min-w-0">
              <BookShelfLink
                locale={locale}
                type={choice.type}
                label={choiceLabel(choice, locale)}
                language={choice.language ?? null}
              />
            </li>
          ))}
          <li className="min-w-0">
            <a className={bookLinkClass} href={`/${locale}/library/continue`} target="_blank" rel="noopener">
              {m.library_continue({}, options)}
              <span className="sr-only"> — {m.books_catalogue_new_tab({}, options)}</span>
            </a>
          </li>
        </ul>
      </div>
    </section>
  );
}

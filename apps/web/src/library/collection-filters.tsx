import { useEffect, useState, type FormEvent } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { CollectionFilterParams } from './collection-filter-params';
import type { SuggestionResult } from '../search/suggestions';
import type { FilterDocument } from '@rezics/filter';
import { collectionFilterAddress } from './collection-filter-params';
import { Drawer, DrawerContent, DrawerHeader, DrawerTitle, DrawerTrigger } from '@rezics/ui/shadcn/drawer';

export type CollectionFilterProperty = { id: string; label: string; datatype: string; unit?: string };

/** Shared rendered outcomes for filtered empty, unsupported, and preparing reads. */
export function CollectionFilterFeedback({
  id,
  filter,
  ignored = [],
  status,
  empty,
  unavailable = false,
  emptyLabel,
  buttonClass,
}: {
  id: string;
  filter?: FilterDocument | undefined;
  ignored?: string[] | undefined;
  status?: 'unsupported' | 'preparing' | 'failed' | undefined;
  empty: boolean;
  unavailable?: boolean;
  emptyLabel: string;
  buttonClass?: string;
}) {
  return (
    <>
      {ignored.length ? <p role="status">{m.collection_filter_ignored({ filter: ignored.join(', ') })}</p> : null}
      {status === 'unsupported' ? <p role="status">{m.collection_filter_unsupported()}</p> : null}
      {status === 'preparing' ? (
        <p role="status">
          {m.collection_filter_preparing()} {m.collection_filter_retry_later()}
        </p>
      ) : null}
      {empty && !unavailable && status !== 'preparing' ? (
        <>
          <p className="text-muted-foreground">
            {filter && status !== 'unsupported' ? m.collection_filter_no_match() : emptyLabel}
          </p>
          {filter ? (
            <a
              className={buttonClass ?? 'inline-flex min-h-10 items-center rounded-lg border border-border px-3'}
              href={collectionFilterAddress(getLocale(), id, {}, {})}
            >
              {m.collection_filter_clear()}
            </a>
          ) : null}
        </>
      ) : null}
    </>
  );
}

/** Shared filter form for curated and dynamic Collection pages. */
export function CollectionFilters({
  id,
  type,
  properties,
  params,
}: {
  id: string;
  type: string;
  properties: CollectionFilterProperty[];
  params: CollectionFilterParams;
}) {
  const [open, setOpen] = useState(false);
  const locale = getLocale();
  function submit(event: FormEvent<HTMLFormElement>) {
    event.preventDefault();
    const form = new FormData(event.currentTarget);
    const params = new URLSearchParams();
    form.forEach((value, key) => {
      if (key.startsWith('f.') || (key.startsWith('l.') && String(value))) params.append(key, String(value));
    });
    for (const property of properties.filter((item) => item.datatype === 'quantity')) {
      const from = String(form.get(`range.from.${property.id}`) ?? '').trim();
      const to = String(form.get(`range.to.${property.id}`) ?? '').trim();
      if (from || to) params.set(`r.${property.id}`, `${from},${to}`);
    }
    const query = params.toString();
    window.location.assign(`/${locale}/collections/${encodeURIComponent(id)}${query ? `?${query}` : ''}`);
  }
  if (properties.length === 0) return null;
  return (
    <section className="min-w-0">
      <Drawer open={open} onOpenChange={setOpen}>
        <DrawerTrigger className="mb-3 min-h-10 w-full rounded-lg border border-border px-3 lg:hidden">
          {m.collection_filters()}
        </DrawerTrigger>
        <DrawerContent className="lg:hidden">
          <DrawerHeader>
            <DrawerTitle>{m.collection_filters()}</DrawerTitle>
          </DrawerHeader>
          <form
            onSubmit={submit}
            method="get"
            action={`/${locale}/collections/${encodeURIComponent(id)}`}
            className="max-h-[70vh] min-h-0 overflow-y-auto p-4"
          >
            <FilterFields id={id} type={type} locale={locale} properties={properties} params={params} />
          </form>
        </DrawerContent>
      </Drawer>
      <form
        onSubmit={submit}
        method="get"
        action={`/${locale}/collections/${encodeURIComponent(id)}`}
        className="hidden min-w-0 rounded-xl border border-border p-4 lg:block"
      >
        <FilterFields id={id} type={type} locale={locale} properties={properties} params={params} />
      </form>
    </section>
  );
}

function FilterFields({
  id,
  type,
  locale,
  properties,
  params,
}: {
  id: string;
  type: string;
  locale: string;
  properties: CollectionFilterProperty[];
  params: CollectionFilterParams;
}) {
  return (
    <>
      <input type="hidden" name="type" value={type} />
      <h2 className="mb-4 font-medium">{m.collection_filters()}</h2>
      {properties.map((property) => (
        <fieldset key={property.id} className="mb-4 min-w-0 space-y-2">
          <legend className="text-sm font-medium">
            {property.label}
            {property.unit ? ` (${property.unit})` : ''}
          </legend>
          {property.datatype === 'wikibase-item' ? (
            <ConceptSuggestion
              property={property}
              {...(params.selected[property.id]?.[0] ? { selected: params.selected[property.id]![0]! } : {})}
              {...(params.selectedLabels[property.id] ? { selectedLabel: params.selectedLabels[property.id]! } : {})}
            />
          ) : (
            <div className="grid grid-cols-2 gap-2">
              <label className="min-w-0 text-sm">
                {m.collection_filter_from()}
                <input
                  className="block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2"
                  type="number"
                  name={`range.from.${property.id}`}
                  defaultValue={params.ranges[property.id]?.from ?? ''}
                />
              </label>
              <label className="min-w-0 text-sm">
                {m.collection_filter_to()}
                <input
                  className="block w-full min-w-0 rounded-md border border-border bg-background px-2 py-2"
                  type="number"
                  name={`range.to.${property.id}`}
                  defaultValue={params.ranges[property.id]?.to ?? ''}
                />
              </label>
            </div>
          )}
        </fieldset>
      ))}
      <div className="sticky bottom-0 flex flex-wrap gap-2 bg-background py-3 lg:static">
        <button className="min-h-10 rounded-lg bg-primary px-4 text-primary-foreground" type="submit">
          {m.collection_filter_apply()}
        </button>
        <a
          className="inline-flex min-h-10 items-center rounded-lg border border-border px-4"
          href={`/${locale}/collections/${encodeURIComponent(id)}`}
        >
          {m.collection_filter_clear()}
        </a>
      </div>
    </>
  );
}

function ConceptSuggestion({
  property,
  selected,
  selectedLabel,
}: {
  property: CollectionFilterProperty;
  selected?: string;
  selectedLabel?: string;
}) {
  const locale = getLocale();
  const [query, setQuery] = useState(selectedLabel ?? '');
  const [choices, setChoices] = useState<{ id: string; label: string }[]>([]);
  const [choice, setChoice] = useState<{ id: string; label: string } | undefined>(
    selected && selectedLabel ? { id: selected, label: selectedLabel } : undefined,
  );
  const [value, setValue] = useState(selected ?? '');
  useEffect(() => {
    if (choice && query === choice.label) return;
    const searchText = query.trim() || selected;
    if (!searchText) {
      setChoices([]);
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(
      () => {
        void fetch(`/api/search/suggestions?q=${encodeURIComponent(searchText)}&locale=${encodeURIComponent(locale)}`, {
          signal: controller.signal,
        })
          .then((response) => (response.ok ? (response.json() as Promise<SuggestionResult>) : undefined))
          .then((result) => {
            const concepts = (result?.subjects ?? []).filter(
              (subject) => subject.type === 'skos:Concept' || subject.summary?.types?.includes('skos:Concept'),
            );
            const selectedSubject = query ? undefined : concepts.find((subject) => subject.id === selected);
            if (selectedSubject) {
              const label = selectedSubject.labels[locale] ?? selectedSubject.labels.en ?? selected!;
              setChoice({ id: selected!, label });
              setValue(selected!);
              setQuery(label);
            }
            setChoices(
              concepts.map((subject) => ({
                id: subject.id,
                label: subject.labels[locale] ?? subject.labels.en ?? subject.id,
              })),
            );
          })
          .catch((error) => {
            if (!(error instanceof DOMException && error.name === 'AbortError')) setChoices([]);
          });
      },
      query ? 200 : 0,
    );
    return () => {
      window.clearTimeout(timer);
      controller.abort();
    };
  }, [query, locale, selected, choice]);
  function search(text: string) {
    setQuery(text);
    setValue('');
    setChoice(undefined);
  }
  return (
    <div className="relative min-w-0">
      <input
        aria-label={property.label}
        autoComplete="off"
        className="w-full min-w-0 rounded-md border border-border bg-background px-3 py-2"
        onChange={(event) => search(event.target.value)}
        value={query}
        placeholder={m.collection_filter_concept()}
      />
      <input type="hidden" name={`l.${property.id}`} value={choice?.label ?? ''} />
      <input type="hidden" name={`f.${property.id}`} value={value} />
      {choices.length ? (
        <ul
          role="listbox"
          className="absolute z-10 mt-1 max-h-48 w-full overflow-auto rounded-md border border-border bg-background p-1 shadow-lg"
        >
          {choices.map((item) => (
            <li key={item.id}>
              <button
                type="button"
                role="option"
                aria-selected={choice?.id === item.id}
                className="w-full rounded px-2 py-2 text-left hover:bg-muted"
                onClick={() => {
                  setChoice(item);
                  setValue(item.id);
                  setQuery(item.label);
                  setChoices([]);
                }}
              >
                {item.label}
              </button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}

import { createServerFn } from '@tanstack/react-start';
import type { KernelClient } from '@rezics/client';
import {
  Combobox,
  ComboboxContent,
  ComboboxEmpty,
  ComboboxInput,
  ComboboxItem,
  ComboboxList,
  useListCollection,
} from '@rezics/ui/combobox';
import { Link, useNavigate } from '@tanstack/react-router';
import { useEffect, useState } from 'react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { kernelClient } from '../kernel/client.ts';

type SearchResult = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$search']['post']>>['data']>;
type SuggestResult = NonNullable<Awaited<ReturnType<KernelClient['subjects']['$suggest']['get']>>['data']>;
const readSearch = createServerFn({ method: 'GET' })
  .validator((input: unknown) => {
    if (
      !input ||
      typeof input !== 'object' ||
      !('query' in input) ||
      typeof input.query !== 'string' ||
      input.query.length > 256 ||
      !('cursor' in input) ||
      (input.cursor !== undefined && typeof input.cursor !== 'string')
    )
      throw new Error('Invalid search');
    return { query: input.query, cursor: input.cursor as string | undefined };
  })
  .handler(async ({ data }): Promise<SearchResult> => {
    const result = await kernelClient().subjects.$search.post({
      text: data.query,
      limit: 100,
      ...(data.cursor ? { cursor: data.cursor } : {}),
    });
    if (result.error) throw new Error('Search failed');
    return result.data as SearchResult;
  });

export function SearchPage({ query, cursor, result }: { query: string; cursor?: string; result?: SearchResult }) {
  const [formQuery, setFormQuery] = useState(query);
  const locale = getLocale();
  return (
    <section className="mx-auto max-w-3xl space-y-6">
      <h1 className="font-serif text-3xl">{m.search_heading()}</h1>
      <form method="get" action={`/${locale}/search`} className="flex gap-2">
        <label className="sr-only" htmlFor="search-query">
          {m.search_label()}
        </label>
        <input
          id="search-query"
          name="q"
          value={formQuery}
          onChange={(event) => setFormQuery(event.target.value)}
          className="h-10 min-w-0 flex-1 rounded-xl border border-border bg-background px-3"
        />
        <button className="rounded-xl bg-primary px-4 text-primary-foreground">{m.search_submit()}</button>
      </form>
      {query &&
        result &&
        (result.subjects.length ? (
          <>
            <p className="text-sm text-muted-foreground">{m.search_results()}</p>
            <ul className="divide-y divide-border/60 rounded-xl border border-border/60">
              {result.subjects.map((subject) => {
                const label = localizedLabel(subject.labels, locale);
                return (
                  <li key={subject.id} className="px-4 py-3">
                    <Link
                      to="/subjects/$id"
                      params={{ id: subject.id }}
                      lang={label.lang}
                      className="font-medium underline-offset-4 hover:underline"
                    >
                      {label.text}
                    </Link>
                  </li>
                );
              })}
            </ul>
            {result.next && (
              <Link
                to="/search"
                search={{ q: query, cursor: result.next }}
                className="inline-flex rounded-lg border px-3 py-2"
              >
                {m.search_more()}
              </Link>
            )}
          </>
        ) : (
          <p>{m.search_no_results()}</p>
        ))}
    </section>
  );
}

function localizedLabel(labels: Record<string, string>, locale: string): { text: string; lang?: string } {
  const order =
    locale === 'zh-Hant'
      ? ['zh-Hant', 'zh-Hans', 'en']
      : locale === 'zh-Hans'
        ? ['zh-Hans', 'zh-Hant', 'en']
        : [locale, 'en'];
  const lang = order.find((key) => labels[key]) ?? Object.keys(labels)[0];
  return { text: lang ? labels[lang]! : '', ...(lang && lang !== locale ? { lang } : {}) };
}

export { readSearch };

export function ShellSearch() {
  const locale = getLocale();
  const navigate = useNavigate();
  const [inputValue, setInputValue] = useState('');
  const collectionState = useListCollection({
    initialItems: [] as { value: string; label: string; subject: SuggestResult['subjects'][number] }[],
  });
  const collection = collectionState.collection;
  useEffect(() => {
    const value = inputValue.trim();
    if (!value) {
      collectionState.clear();
      return;
    }
    const controller = new AbortController();
    const timer = window.setTimeout(async () => {
      try {
        const response = await fetch(`/api/search/suggestions?q=${encodeURIComponent(value)}`, {
          signal: controller.signal,
        });
        if (!response.ok) return;
        const result = (await response.json()) as SuggestResult;
        collectionState.set(
          result.subjects.map((subject) => ({
            value: subject.id,
            label: localizedLabel(subject.labels, locale).text,
            subject,
          })),
        );
      } catch (error) {
        if (!(error instanceof DOMException && error.name === 'AbortError')) collectionState.clear();
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
  }, [inputValue, locale]);
  const submit = () => {
    if (inputValue.trim()) void navigate({ to: '/search', search: { q: inputValue.trim(), cursor: undefined } });
  };
  return (
    <Combobox
      collection={collection}
      onInputValueChange={({ inputValue: value }) => setInputValue(value)}
      onValueChange={({ value }) => {
        const id = value[0];
        if (id) void navigate({ to: '/subjects/$id', params: { id } });
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && !event.currentTarget.getAttribute('aria-activedescendant')) {
          event.preventDefault();
          submit();
        }
      }}
    >
      <ComboboxInput
        className="h-9 w-28 text-sm sm:w-44"
        aria-label={m.search_label()}
        placeholder={m.search_placeholder()}
        showTrigger={false}
      />
      <ComboboxContent>
        <ComboboxEmpty>{m.search_no_suggestions()}</ComboboxEmpty>
        <ComboboxList>
          {collection.items.map((item) => (
            <ComboboxItem item={item} key={item.value}>
              {item.label}
            </ComboboxItem>
          ))}
        </ComboboxList>
      </ComboboxContent>
    </Combobox>
  );
}

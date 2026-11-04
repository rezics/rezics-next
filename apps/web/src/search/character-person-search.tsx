import { useCallback, useState } from 'react';
import { queryOptions, useQuery } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import {
  CharacterPersonSelectionFields,
  useCharacterPersonReader,
  readCharacterPersonSelectionMetadata,
  editCharacterPersonSelection,
  type CharacterPersonSelection,
  type CharacterPersonSelectionMetadata,
} from './character-person-selection';
import { readDiscovery, type DiscoveryState } from './discovery';
import { DiscoveryResults } from './discovery-results';
import {
  type CharacterPersonSearch,
  characterPersonQueryKey,
  characterPersonHref,
  characterPersonRequest,
  characterPersonVisibleState,
  type CharacterPersonForm as CharacterPersonFormState,
  type ParsedCharacterPersonSearch,
} from './character-person';

const characterPersonSearchSchema = v.object({
  mode: v.picklist(['characters', 'people']),
  name: v.string(),
  works: v.array(v.string()),
  role: v.optional(v.string()),
  languages: v.array(v.string()),
  threshold: v.picklist([0, 1, 2]),
  sort: v.picklist(['name', 'relevance']),
  cursor: v.optional(v.string()),
});

const readCharacterPerson = createServerFn({ method: 'GET' })
  .validator(v.object({ locale: v.string(), search: characterPersonSearchSchema }))
  .handler(async ({ data }) => {
    const request = characterPersonRequest(data.search as CharacterPersonSearch);
    return readDiscovery(request, async (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal: getRequest().signal } }),
    );
  });

export function characterPersonQueryOptions(
  locale: string,
  search: CharacterPersonSearch,
  principal: string,
  current?: () => boolean,
) {
  return queryOptions({
    queryKey: characterPersonQueryKey(locale, principal, search),
    queryFn: async ({ signal }): Promise<{ discovery: DiscoveryState; restarted: boolean }> => {
      try {
        if (current && !current()) throw new DOMException('Reader retired', 'AbortError');
        const result = await readCharacterPerson({ data: { locale, search }, signal });
        signal.throwIfAborted();
        if (current && !current()) throw new DOMException('Reader retired', 'AbortError');
        return result;
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        return { discovery: { status: 'unavailable' }, restarted: false };
      }
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    enabled: true,
  });
}

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function searchPath(locale: string): string {
  return `/${encodeURIComponent(locale)}/search/characters`;
}

function searchForm(search: CharacterPersonSearch): CharacterPersonFormState {
  return {
    mode: search.mode,
    name: search.name,
    works: search.works.join('\n'),
    role: search.role ?? '',
    languages: search.languages.join(', '),
    threshold: String(search.threshold),
    sort: search.sort,
  };
}

function CharacterPersonForm({
  form,
  locale,
  reader,
  metadata,
  preparing,
  retryMetadata,
  onDraftChange,
  onReady,
}: {
  form: CharacterPersonFormState;
  locale: string;
  reader: ReturnType<typeof useCharacterPersonReader>;
  metadata: CharacterPersonSelectionMetadata | undefined;
  preparing: boolean;
  retryMetadata(): void;
  onDraftChange(): void;
  onReady(ready: boolean): void;
}) {
  const options = messageOptions(locale);
  const [mode, setMode] = useState(form.mode === 'people' ? ('people' as const) : ('characters' as const));
  const [languages, setLanguages] = useState(form.languages);
  const [threshold, setThreshold] = useState(form.threshold);
  const [selection, setSelection] = useState<CharacterPersonSelection>({
    works: form.works.split(/\r?\n/).filter(Boolean),
    role: form.role,
  });
  const [selectionReady, setSelectionReady] = useState(false);
  const markReady = useCallback(
    (ready: boolean) => {
      setSelectionReady(ready);
      onReady(ready);
    },
    [onReady],
  );
  const changeSelection = (value: CharacterPersonSelection) => {
    if (value === selection) return;
    markReady(false);
    setSelection(value);
    onDraftChange();
  };
  const languageValues = languages
    .split(',')
    .map((tag) => tag.trim())
    .filter(Boolean);
  const validLanguages =
    languageValues.length > 0 &&
    languageValues.length <= 8 &&
    languageValues.every((tag) => /^[A-Za-z]{2,3}(?:-[A-Za-z0-9]{1,8})*$/.test(tag));
  const usableMetadata = validLanguages ? metadata : undefined;
  const hasSelection = selection.works.length > 0 || selection.role !== '';
  const canApply = !hasSelection || (selectionReady && !!usableMetadata && !preparing && reader.ready);
  return (
    <form
      action={searchPath(locale)}
      method="get"
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
      onChange={onDraftChange}
      onSubmit={(event) => {
        if (!canApply || !reader.current()) event.preventDefault();
      }}
    >
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_mode({}, options)}</span>
        <select
          className="h-10 rounded-md border bg-background px-3"
          name="mode"
          value={mode}
          onChange={(event) => {
            setMode(event.currentTarget.value === 'people' ? 'people' : 'characters');
            changeSelection(editCharacterPersonSelection(selection, { kind: 'mode' }));
          }}
        >
          <option value="characters">{m.character_person_characters({}, options)}</option>
          <option value="people">{m.character_person_people({}, options)}</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_name({}, options)}</span>
        <input className="h-10 rounded-md border bg-background px-3" name="name" defaultValue={form.name} />
      </label>
      <CharacterPersonSelectionFields
        key={JSON.stringify([selection, mode, languages, reader.identity, usableMetadata?.release])}
        value={selection}
        onChange={changeSelection}
        mode={mode}
        locale={locale}
        languages={languageValues}
        metadata={usableMetadata}
        preparing={preparing}
        reader={reader}
        retryMetadata={retryMetadata}
        onReady={markReady}
      />
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_languages({}, options)}</span>
        <input
          className="h-10 rounded-md border bg-background px-3 font-normal"
          name="language"
          value={languages}
          onChange={(event) => {
            markReady(false);
            setLanguages(event.currentTarget.value);
          }}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_threshold({}, options)}</span>
        <select
          className="h-10 rounded-md border bg-background px-3"
          name="threshold"
          value={threshold}
          onChange={(event) => setThreshold(event.currentTarget.value)}
        >
          <option value="0">{m.character_person_threshold_0({}, options)}</option>
          <option value="1">{m.character_person_threshold_1({}, options)}</option>
          <option value="2">{m.character_person_threshold_2({}, options)}</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_sort({}, options)}</span>
        <select className="h-10 rounded-md border bg-background px-3" name="sort" defaultValue={form.sort}>
          <option value="name">{m.character_person_sort_name({}, options)}</option>
          <option value="relevance">{m.character_person_sort_relevance({}, options)}</option>
        </select>
      </label>
      <div className="sm:col-span-2">
        <button className={buttonVariants()} type="submit" disabled={!canApply || !reader.ready}>
          {m.character_person_apply({}, options)}
        </button>
      </div>
    </form>
  );
}

export function CharacterPersonSearchPage({
  locale,
  parsed,
  principal,
}: {
  locale: string;
  parsed: ParsedCharacterPersonSearch;
  principal: string;
}) {
  const options = messageOptions(locale);
  const reader = useCharacterPersonReader(locale, JSON.stringify(parsed));
  const [dirty, setDirty] = useState(false);
  const [selectionReady, setSelectionReady] = useState(
    parsed.search.works.length === 0 && !parsed.search.role && !parsed.error,
  );
  const markDirty = useCallback(() => setDirty(true), []);
  const metadata = useQuery({
    queryKey: ['character-person-selection-metadata', reader.identity],
    queryFn: async ({ signal }) => {
      const result = await readCharacterPersonSelectionMetadata({ signal });
      signal.throwIfAborted();
      if (!reader.current()) throw new DOMException('Reader retired', 'AbortError');
      return result;
    },
    enabled: reader.ready,
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const currentMetadata = metadata.isError || metadata.isFetching ? undefined : (metadata.data ?? undefined);
  const selected = parsed.search.works.length > 0 || !!parsed.search.role;
  const enabled = reader.ready && !parsed.error && !dirty && selectionReady && (!selected || !!currentMetadata);
  const query = useQuery({
    ...characterPersonQueryOptions(locale, parsed.search, `${principal}:${reader.identity}`, reader.current),
    enabled,
  });
  const state: DiscoveryState = dirty
    ? { status: 'loading' }
    : characterPersonVisibleState(parsed, !enabled || query.isFetching, query.data);
  const restartHref = characterPersonHref(locale, parsed.search);
  const next = state.status === 'ready' ? state.page.next : null;
  const pageEmpty = state.status === 'ready' && state.page.hits.length === 0 && next !== null;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <PageHeading>{m.character_person_heading({}, options)}</PageHeading>
      <p className="text-muted-foreground">{m.character_person_intro({}, options)}</p>
      <a className="text-sm underline" href={`/${encodeURIComponent(locale)}/search`}>
        {m.character_person_mixed_search({}, options)}
      </a>
      <CharacterPersonForm
        form={parsed.form ?? searchForm(parsed.search)}
        locale={locale}
        reader={reader}
        metadata={currentMetadata}
        preparing={metadata.isFetching}
        retryMetadata={() => {
          void metadata.refetch();
        }}
        onDraftChange={markDirty}
        onReady={setSelectionReady}
      />
      {parsed.error && (
        <p className="text-sm text-destructive" role="alert">
          {parsed.error === 'role_requires_work'
            ? m.character_person_role_requires_work({}, options)
            : m.character_person_invalid({}, options)}
        </p>
      )}
      {pageEmpty && (
        <p className="text-sm text-muted-foreground" role="status">
          {m.character_person_page_empty({}, options)}
        </p>
      )}
      {dirty ? (
        <p role="status" className="text-muted-foreground">
          {m.character_person_apply_changes({}, options)}
        </p>
      ) : (
        <DiscoveryResults state={state} locale={locale} restartHref={restartHref} />
      )}
      {!dirty && ['unavailable', 'not-ready'].includes(state.status) && (
        <button
          type="button"
          className={buttonVariants({ variant: 'outline' })}
          onClick={() => {
            if (reader.current()) void query.refetch();
          }}
        >
          {m.character_person_retry({}, options)}
        </button>
      )}
      {next && (
        <nav aria-label={m.character_person_pagination({}, options)}>
          <a className={buttonVariants({ variant: 'outline' })} href={characterPersonHref(locale, parsed.search, next)}>
            {m.character_person_continue({}, options)}
          </a>
        </nav>
      )}
    </main>
  );
}

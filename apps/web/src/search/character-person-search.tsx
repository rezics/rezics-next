import { queryOptions, useQuery } from '@tanstack/react-query';
import { createServerFn } from '@tanstack/react-start';
import { getRequest } from '@tanstack/react-start/server';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import * as v from 'valibot';
import { kernelClient } from '../kernel/client';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { readDiscovery, type DiscoveryState } from './discovery';
import { DiscoveryResults } from './discovery-results';
import {
  characterPersonHref,
  characterPersonRequest,
  type CharacterPersonForm as CharacterPersonFormState,
  type CharacterPersonSearch,
  type ParsedCharacterPersonSearch,
} from './character-person';

const readCharacterPerson = createServerFn({ method: 'GET' })
  .validator(
    v.object({
      locale: v.string(),
      request: v.unknown(),
    }),
  )
  .handler(async ({ data }) => {
    const request = data.request as ReturnType<typeof characterPersonRequest>;
    return readDiscovery(request, async (body) =>
      kernelClient(data.locale).subjects.$search.post(body, { fetch: { signal: getRequest().signal } }),
    );
  });

export function characterPersonQueryOptions(
  locale: string,
  search: CharacterPersonSearch,
  principal: string,
) {
  const request = characterPersonRequest(search);
  return queryOptions({
    queryKey: ['character-person-search', locale, principal, request],
    queryFn: async ({ signal }): Promise<{ discovery: DiscoveryState; restarted: boolean }> => {
      try {
        return await readCharacterPerson({ data: { locale, request }, signal });
      } catch (error) {
        if (signal.aborted || (error instanceof Error && error.name === 'AbortError')) throw error;
        return { discovery: { status: 'unavailable' }, restarted: false };
      }
    },
    staleTime: 0,
    gcTime: 0,
    retry: false,
    refetchOnMount: true,
    refetchOnWindowFocus: true,
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
}: {
  form: CharacterPersonFormState;
  locale: string;
}) {
  const options = messageOptions(locale);
  return (
    <form action={searchPath(locale)} method="get" className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2">
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_mode({}, options)}</span>
        <select className="h-10 rounded-md border bg-background px-3" name="mode" defaultValue={form.mode}>
          <option value="characters">{m.character_person_characters({}, options)}</option>
          <option value="people">{m.character_person_people({}, options)}</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_name({}, options)}</span>
        <input className="h-10 rounded-md border bg-background px-3" name="name" defaultValue={form.name} />
      </label>
      <label className="grid gap-1 text-sm font-medium sm:col-span-2">
        <span>{m.character_person_works({}, options)}</span>
        <textarea
          className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
          name="work"
          aria-describedby="character-person-works-help"
          defaultValue={form.works}
        />
        <span id="character-person-works-help" className="font-normal text-muted-foreground">
          {m.character_person_works_help({}, options)}
        </span>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_role({}, options)}</span>
        <input
          className="h-10 rounded-md border bg-background px-3"
          name="role"
          defaultValue={form.role}
          aria-describedby="character-person-role-help"
        />
        <span id="character-person-role-help" className="font-normal text-muted-foreground">
          {m.character_person_role_help({}, options)}
        </span>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_languages({}, options)}</span>
        <input
          className="h-10 rounded-md border bg-background px-3 font-normal"
          name="language"
          defaultValue={form.languages}
        />
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_threshold({}, options)}</span>
        <select className="h-10 rounded-md border bg-background px-3" name="threshold" defaultValue={form.threshold}>
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
        <button className={buttonVariants()} type="submit">
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
  const query = useQuery({ ...characterPersonQueryOptions(locale, parsed.search, principal), enabled: !parsed.error });
  const state: DiscoveryState = parsed.error
    ? { status: 'invalid' }
    : query.isFetching || !query.data
      ? { status: 'loading' }
      : query.data.discovery;
  const restartHref = characterPersonHref(locale, { ...parsed.search, cursor: undefined });
  const next = state.status === 'ready' ? state.page.next : null;
  const pageEmpty = state.status === 'ready' && state.page.hits.length === 0 && next !== null;
  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <PageHeading>{m.character_person_heading({}, options)}</PageHeading>
      <p className="text-muted-foreground">{m.character_person_intro({}, options)}</p>
      <CharacterPersonForm form={parsed.form ?? searchForm(parsed.search)} locale={locale} />
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
      <DiscoveryResults state={state} locale={locale} restartHref={restartHref} />
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

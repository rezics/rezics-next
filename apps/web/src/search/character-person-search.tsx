import { useCallback, useEffect, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { buttonVariants } from '@rezics/ui/shadcn/button';
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
import type { DiscoveryState } from './discovery';
import { characterPersonQueryOptions } from './character-person-window-query';
import { characterPersonWindowFacts } from './character-person-window';
import { SearchWindowControls, useSearchWindow } from './search-window';
import { DiscoveryKinds } from './discovery-kinds';
import { QuerySharePreview } from './query-share-preview';
import { subjectVisitReturnHref } from '../features/pages/subject-visit-navigation';
export { characterPersonQueryOptions } from './character-person-window-query';
import { DiscoveryResults } from './discovery-results';
import {
  type CharacterPersonMode,
  type CharacterPersonSearch,
  characterPersonHref,
  characterPersonSearchFromFields,
  creditRoleIds,
  parseCharacterPersonSearch,
  type CharacterPersonForm as CharacterPersonFormState,
  type ParsedCharacterPersonSearch,
} from './character-person';
import { resolveConditionEntityLabels } from './condition-entity';
import { readCharacterPersonKinds, prepareCharacterPersonShare } from './character-person-window-server';
import { Select, SelectContent, SelectGroup, SelectItem, SelectTrigger, SelectValue } from '@rezics/ui/shadcn/select';

function messageOptions(locale: string) {
  return { locale: locales.find((value) => value === locale) ?? 'en' };
}

function searchPath(locale: string): string {
  return `/${encodeURIComponent(locale)}/search/characters`;
}

function formMode(value: string): CharacterPersonMode {
  return value === 'people' || value === 'works' ? value : 'characters';
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
  const [mode, setMode] = useState(formMode(form.mode));
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
        <Select
          name="mode"
          value={mode}
          onValueChange={(nextSelectValue) => {
            const next = formMode(nextSelectValue ?? '');
            setMode(next);
            const edited = editCharacterPersonSelection(selection, { kind: 'mode' });
            // Work operands do not apply to works mode, so none remains in a hidden draft.
            changeSelection(next === 'works' ? { ...edited, works: [] } : edited);
          }}
        >
          <SelectTrigger className="h-10 rounded-md border bg-background px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="characters">{m.character_person_characters({}, options)}</SelectItem>
              <SelectItem value="people">{m.character_person_people({}, options)}</SelectItem>
              <SelectItem value="works">{m.character_person_credited_works({}, options)}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
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
        <Select
          name="threshold"
          value={threshold === '' ? null : threshold}
          onValueChange={(nextSelectValue) => setThreshold(nextSelectValue ?? '')}
        >
          <SelectTrigger className="h-10 rounded-md border bg-background px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="0">{m.character_person_threshold_0({}, options)}</SelectItem>
              <SelectItem value="1">{m.character_person_threshold_1({}, options)}</SelectItem>
              <SelectItem value="2">{m.character_person_threshold_2({}, options)}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.character_person_sort({}, options)}</span>
        <Select name="sort" defaultValue={form.sort === '' ? null : form.sort}>
          <SelectTrigger className="h-10 rounded-md border bg-background px-3">
            <SelectValue />
          </SelectTrigger>
          <SelectContent>
            <SelectGroup>
              <SelectItem value="name">{m.character_person_sort_name({}, options)}</SelectItem>
              <SelectItem value="relevance">{m.character_person_sort_relevance({}, options)}</SelectItem>
            </SelectGroup>
          </SelectContent>
        </Select>
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
  const router = useRouter({ warn: false });
  const executedHref = characterPersonHref(locale, parsed.search, parsed.search.cursor);
  const reader = useCharacterPersonReader(locale, executedHref);
  // A pending router address can precede replacement of the rendered match's props.
  const current = () => {
    if (!reader.current()) return false;
    if (!router) return true;
    const location = router.state.location;
    const actual = parseCharacterPersonSearch(location.search, locale);
    return (
      location.pathname.replace(/\/$/, '') === '/search/characters' &&
      !actual.error &&
      characterPersonHref(locale, actual.search, actual.search.cursor) === executedHref
    );
  };
  const [dirty, setDirty] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => setHydrated(true), []);
  const [selectionReady, setSelectionReady] = useState(
    parsed.search.works.length === 0 && !parsed.search.role && !parsed.error,
  );
  const markDirty = useCallback(() => setDirty(true), []);
  const metadata = useQuery({
    queryKey: ['character-person-selection-metadata', reader.identity],
    queryFn: async ({ signal }) => {
      const result = await readCharacterPersonSelectionMetadata({ signal });
      signal.throwIfAborted();
      if (!current()) throw new DOMException('Reader retired', 'AbortError');
      return result;
    },
    enabled: reader.ready && current(),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const currentMetadata = metadata.isError || metadata.isFetching ? undefined : (metadata.data ?? undefined);
  const selected = parsed.search.works.length > 0 || !!parsed.search.role;
  const enabled =
    reader.ready && current() && !parsed.error && !dirty && selectionReady && (!selected || !!currentMetadata);
  const query = useQuery({
    ...characterPersonQueryOptions(locale, parsed.search, `${principal}:${reader.identity}`, current),
    enabled,
  });
  const state: DiscoveryState = parsed.error
    ? { status: 'invalid' }
    : !enabled || query.isFetching
      ? { status: 'loading' }
      : query.isError
        ? { status: 'unavailable' }
        : (query.data?.discovery ?? { status: 'loading' });
  // Role labels for credited hits use the same release-bound reader as the selection's role operand.
  const roleIds = state.status === 'ready' ? creditRoleIds(state.page.hits) : [];
  const roleTargets = currentMetadata?.roleTargets.works ?? [];
  const roleLabels = useQuery({
    queryKey: ['character-person-credit-roles', locale, reader.identity, currentMetadata?.release, roleIds],
    queryFn: async ({ signal }) => {
      const result = await resolveConditionEntityLabels(
        roleIds,
        roleTargets,
        {
          locale,
          languages: parsed.search.languages,
          reader: reader.identity,
          ...(currentMetadata ? { release: currentMetadata.release } : {}),
          available: true,
        },
        signal,
      );
      signal.throwIfAborted();
      if (!current()) throw new DOMException('Reader retired', 'AbortError');
      return result;
    },
    enabled:
      parsed.search.mode === 'works' &&
      roleIds.length > 0 &&
      roleTargets.length > 0 &&
      !!currentMetadata &&
      reader.ready &&
      current(),
    retry: false,
    gcTime: 0,
    staleTime: 0,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
  });
  const facts = characterPersonWindowFacts(locale, parsed, state, current);
  const windowNavigation = useSearchWindow({
    cursor: facts.cursor,
    href: facts.href,
    isCurrent: facts.current,
    locale,
    session: principal,
    ready: facts.ready,
    settled: facts.settled,
    preparing: facts.preparing,
    recoverable: facts.recoverable,
    checkpoint: facts.checkpoint,
    enabled: facts.enabled && !dirty,
  });
  const next = state.status === 'ready' ? state.page.next : null;
  const sparse = state.status === 'ready' && state.page.hits.length === 0 && next !== null;
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
      {parsed.search.mode === 'works' && !dirty && state.status === 'ready' && (
        <form action={searchPath(locale)} method="get" className="rounded-lg border p-4">
          <input type="hidden" name="mode" value="works" />
          <input type="hidden" name="name" value={parsed.search.name} />
          {parsed.search.role && <input type="hidden" name="role" value={parsed.search.role} />}
          {parsed.search.languages.map((language) => (
            <input key={language} type="hidden" name="language" value={language} />
          ))}
          <input type="hidden" name="threshold" value={String(parsed.search.threshold)} />
          <input type="hidden" name="sort" value={parsed.search.sort} />
          <DiscoveryKinds
            key={JSON.stringify([executedHref, state.page.as_of])}
            initial={state.page.kinds}
            checkpoint={state.page.as_of}
            selected={parsed.search.kinds}
            locale={locale}
            hydrated={hydrated}
            load={(cursor, signal) =>
              readCharacterPersonKinds({
                data: { locale, search: parsed.search, cursor },
                signal,
              })
            }
          />
        </form>
      )}
      {parsed.search.mode === 'works' && !dirty && state.status === 'ready' && (
        <QuerySharePreview
          key={executedHref}
          locale={locale}
          changed={false}
          prepare={(signal) =>
            prepareCharacterPersonShare({
              data: { locale, search: characterPersonSearchFromFields({ ...parsed.search, cursor: undefined }) },
              signal,
            })
          }
        />
      )}
      {parsed.error && (
        <p className="text-sm text-destructive" role="alert">
          {parsed.error === 'role_requires_work'
            ? m.character_person_role_requires_work({}, options)
            : m.character_person_invalid({}, options)}
        </p>
      )}
      <section
        ref={windowNavigation.regionRef}
        aria-label={m.character_person_results({}, options)}
        data-character-person-results
        data-search-recovery={state.status === 'ready' ? undefined : state.status}
        tabIndex={-1}
        aria-busy={state.status === 'loading'}
        className="space-y-4"
      >
        {dirty ? (
          <p role="status" className="text-muted-foreground">
            {m.character_person_apply_changes({}, options)}
          </p>
        ) : sparse ? (
          <p className="text-sm text-muted-foreground" role="status">
            {m.character_person_page_empty({}, options)}
          </p>
        ) : (
          <DiscoveryResults
            state={state}
            locale={locale}
            creditRoleLabels={roleLabels.data?.labels}
            subjectHrefFor={(subject) => subjectVisitReturnHref(subject, locale, executedHref)}
            {...(state.status === 'restart' ? { restartHref: facts.firstHref } : {})}
          />
        )}
        {!dirty && ['unavailable', 'not-ready', 'preparing'].includes(state.status) && (
          <button
            type="button"
            className={buttonVariants({ variant: 'outline' })}
            onClick={() => {
              if (current()) void query.refetch({ cancelRefetch: false });
            }}
          >
            {m.character_person_retry({}, options)}
          </button>
        )}
      </section>
      {!dirty && facts.enabled && (
        <SearchWindowControls
          window={windowNavigation}
          cursor={facts.cursor}
          query={parsed.search.name}
          locale={locale}
          next={next}
          nextLabel={m.character_person_continue({}, options)}
          enabled={state.status !== 'loading'}
        />
      )}
    </main>
  );
}

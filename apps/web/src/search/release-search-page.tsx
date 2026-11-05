import { Fragment, useEffect, useRef, useState } from 'react';
import { useSearchWindow } from './search-window';
import { ReleaseWindowControls } from './release-window-controls';
import type { ReaderOrigin } from '../session/reader';
import { ReleaseChildWindow, useReleaseChildOwner } from './release-child-window';
import { ReleaseResultRow } from './release-child-row';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { discoveryMessage } from './discovery-results';
import { localizedLabel } from './results';
import { type ReleaseSearchState } from './release-search-query';
import {
  HEADER_SUGGESTION_LIMIT,
  loadGlobalHeaderSuggestions,
  readHeaderSuggestions,
} from './header-search/suggestions';
import type { SuggestionResult } from './suggestions';
import {
  releaseSearchHref,
  type ParsedReleaseSearch,
  type ReleaseSearchForm,
  type ReleaseSearchSelections,
  type ReleaseSearchSubjectSelection,
} from './release-search';

export type ReleaseSearchType = { id: string; label: string };

const fieldClass = 'h-10 rounded-md border bg-background px-3 font-normal';

function ReleaseSearchSubjectPicker({
  name,
  label,
  help,
  locale,
  invalid,
  initial,
}: {
  name: 'platform' | 'developer' | 'publisher';
  label: string;
  help: string;
  locale: string;
  invalid: boolean;
  initial?: ReleaseSearchSubjectSelection;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const inputId = `release-search-${name}`;
  const listId = `${inputId}-suggestions`;
  const inputRef = useRef<HTMLInputElement>(null);
  const [query, setQuery] = useState('');
  const [selection, setSelection] = useState(initial);
  const [suggestions, setSuggestions] = useState<SuggestionResult>();
  const [status, setStatus] = useState<'idle' | 'loading' | 'ready' | 'empty' | 'unavailable'>('idle');
  const [activeIndex, setActiveIndex] = useState(-1);
  const active = suggestions?.subjects[activeIndex];

  useEffect(() => {
    const text = query.trim();
    if (text.length < 2) {
      setSuggestions(undefined);
      setStatus('idle');
      return;
    }
    const controller = new AbortController();
    setStatus('loading');
    void readHeaderSuggestions(loadGlobalHeaderSuggestions, text, locale, controller.signal)
      .then((page) => {
        setSuggestions(page);
        setStatus(page.subjects.length ? 'ready' : 'empty');
        setActiveIndex(-1);
      })
      .catch((error: unknown) => {
        if (error instanceof Error && error.name === 'AbortError') return;
        setSuggestions(undefined);
        setStatus('unavailable');
      });
    return () => controller.abort();
  }, [query, locale]);

  const choose = (subject: SuggestionResult['subjects'][number]) => {
    const text = localizedLabel(subject.labels, locale).text || subject.id;
    setSelection({ id: subject.id, label: text, type: subject.type });
    setQuery('');
    setSuggestions(undefined);
    setStatus('idle');
    setActiveIndex(-1);
    inputRef.current?.setCustomValidity('');
  };
  const statusText =
    status === 'loading'
      ? m.header_search_loading({}, options)
      : status === 'empty'
        ? m.search_no_suggestions({}, options)
        : status === 'unavailable'
          ? m.search_suggestions_unavailable({}, options)
          : undefined;

  return (
    <div className="grid gap-1 text-sm font-medium">
      <label htmlFor={inputId}>{label}</label>
      <input
        ref={inputRef}
        id={inputId}
        className={fieldClass}
        type="search"
        autoComplete="off"
        placeholder={m.search_placeholder({}, options)}
        value={query}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={query.trim().length >= 2 && status !== 'idle'}
        aria-controls={listId}
        aria-activedescendant={active ? `${listId}-${activeIndex}` : undefined}
        aria-invalid={invalid || undefined}
        aria-describedby={`${inputId}-help ${inputId}-status`}
        onChange={(event) => {
          const text = event.currentTarget.value;
          setSelection(undefined);
          setQuery(text);
          setActiveIndex(-1);
          event.currentTarget.setCustomValidity(text.trim() ? help : '');
        }}
        onKeyDown={(event) => {
          const count = suggestions?.subjects.length ?? 0;
          if (event.key === 'ArrowDown' && count) {
            event.preventDefault();
            setActiveIndex((index) => Math.min(index + 1, count - 1));
          } else if (event.key === 'ArrowUp' && count) {
            event.preventDefault();
            setActiveIndex((index) => Math.max(index - 1, 0));
          } else if (event.key === 'Enter' && active) {
            event.preventDefault();
            choose(active);
          } else if (event.key === 'Escape') {
            setQuery('');
            setActiveIndex(-1);
            inputRef.current?.setCustomValidity('');
          }
        }}
      />
      <input type="hidden" name={name} value={selection?.id ?? ''} />
      <span id={`${inputId}-help`} className="font-normal text-muted-foreground">
        {help}
      </span>
      {selection && (
        <div
          role="group"
          aria-label={label}
          className="flex flex-wrap items-center gap-2 rounded-md border p-2 font-normal"
        >
          <span>{selection.label ?? m.search_suggestions_unavailable({}, options)}</span>
          {selection.type && <span className="text-muted-foreground">{selection.type}</span>}
          <code className="text-xs text-muted-foreground">{selection.id}</code>
          <button type="button" className="underline" onClick={() => setSelection(undefined)}>
            {m.library_subject_clear({}, options)}
          </button>
        </div>
      )}
      <p id={`${inputId}-status`} role="status" aria-live="polite" className="font-normal text-muted-foreground">
        {statusText}
      </p>
      {status === 'ready' && suggestions && (
        <ul
          id={listId}
          role="listbox"
          aria-label={m.header_search_suggestions({}, options)}
          className="rounded-md border"
        >
          {suggestions.subjects.slice(0, HEADER_SUGGESTION_LIMIT).map((subject, index) => {
            const subjectLabel = localizedLabel(subject.labels, locale);
            const typeLabel = localizedLabel(suggestions.types[subject.type] ?? {}, locale);
            return (
              <li
                key={subject.id}
                id={`${listId}-${index}`}
                role="option"
                aria-selected={activeIndex === index}
                className="cursor-pointer px-3 py-2 hover:bg-muted"
                onMouseDown={(event) => event.preventDefault()}
                onClick={() => choose(subject)}
              >
                <span lang={subjectLabel.lang}>{subjectLabel.text || subject.id}</span>
                <span className="text-muted-foreground"> · {typeLabel.text || subject.type}</span>
                <code className="ml-2 text-xs text-muted-foreground">{subject.id}</code>
              </li>
            );
          })}
        </ul>
      )}
    </div>
  );
}

export function ReleaseSearchFormView({
  parsed,
  types,
  locale,
  selections,
}: {
  parsed: ParsedReleaseSearch;
  types: ReleaseSearchType[];
  locale: string;
  selections?: ReleaseSearchSelections;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const { form, controls, invalid } = parsed;
  const input = (name: keyof ReleaseSearchForm, label: string, help?: string) => (
    <label className="grid gap-1 text-sm font-medium">
      <span>{label}</span>
      <input
        className={fieldClass}
        name={name}
        defaultValue={form[name]}
        aria-invalid={invalid.includes(name) || undefined}
        aria-describedby={help ? `release-search-${name}-help` : undefined}
      />
      {help && (
        <span id={`release-search-${name}-help`} className="font-normal text-muted-foreground">
          {help}
        </span>
      )}
    </label>
  );
  const subjectHelp = m.release_search_subject_help({}, options);
  const subjectPicker = (name: 'platform' | 'developer' | 'publisher', label: string) => {
    const initial = selections?.[name] ?? (form[name] ? { id: form[name] } : undefined);
    return (
      <ReleaseSearchSubjectPicker
        name={name}
        label={label}
        help={subjectHelp}
        locale={locale}
        invalid={invalid.includes(name)}
        {...(initial ? { initial } : {})}
      />
    );
  };
  return (
    <form
      method="get"
      action={`/${encodeURIComponent(locale)}/search/releases`}
      className="grid gap-4 rounded-lg border p-4 sm:grid-cols-2"
    >
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_subtype({}, options)}</span>
        <select
          className={fieldClass}
          name="subtype"
          defaultValue={form.subtype}
          aria-invalid={invalid.includes('subtype') || undefined}
        >
          {!types.some((type) => type.id === form.subtype) && <option value={form.subtype}>{form.subtype}</option>}
          {types.map((type) => (
            <option key={type.id} value={type.id}>
              {type.label}
            </option>
          ))}
        </select>
      </label>
      {input('q', m.release_search_text({}, options))}
      {(controls?.platform || form.platform) && subjectPicker('platform', m.release_search_platform({}, options))}
      {(controls?.language || controls?.platform?.languageQualifier || form.releaseLanguage) &&
        input('releaseLanguage', m.release_search_languages({}, options))}
      {input('language', m.release_search_display_languages({}, options))}
      {(controls?.date || form.gte || form.lte) && (
        <>
          {input('gte', m.release_search_date_lower({}, options))}
          {input('lte', m.release_search_date_upper({}, options))}
        </>
      )}
      {(controls?.ageRating || form.ageGte || form.ageLte || form.ageUnit) && (
        <>
          {input('ageGte', m.release_search_age_lower({}, options))}
          {input('ageLte', m.release_search_age_upper({}, options))}
          <label className="grid gap-1 text-sm font-medium">
            <span>{m.release_search_age_unit({}, options)}</span>
            <select
              className={fieldClass}
              name="ageUnit"
              defaultValue={form.ageUnit}
              aria-invalid={invalid.includes('ageUnit') || undefined}
            >
              <option value="">—</option>
              {form.ageUnit && !controls?.ageRating?.units.includes(form.ageUnit) && (
                <option value={form.ageUnit}>{form.ageUnit}</option>
              )}
              {controls?.ageRating?.units.map((unit) => (
                <option key={unit} value={unit}>
                  {unit}
                </option>
              ))}
            </select>
          </label>
        </>
      )}
      {(['developer', 'publisher'] as const).map(
        (role) =>
          (controls?.producers.some((producer) => producer.role === role) || form[role]) && (
            <div key={role}>
              {subjectPicker(
                role,
                role === 'developer'
                  ? m.release_search_developer({}, options)
                  : m.release_search_publisher({}, options),
              )}
            </div>
          ),
      )}
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_sort({}, options)}</span>
        <select
          className={fieldClass}
          name="sort"
          defaultValue={form.sort}
          aria-invalid={invalid.includes('sort') || undefined}
        >
          {!['name', 'relevance'].includes(form.sort) && <option value={form.sort}>{form.sort}</option>}
          <option value="name">{m.release_search_sort_name({}, options)}</option>
          <option value="relevance">{m.release_search_sort_relevance({}, options)}</option>
        </select>
      </label>
      <label className="grid gap-1 text-sm font-medium">
        <span>{m.release_search_spoilers({}, options)}</span>
        <select
          className={fieldClass}
          name="threshold"
          defaultValue={form.threshold}
          aria-invalid={invalid.includes('threshold') || undefined}
        >
          {!['0', '1', '2'].includes(form.threshold) && <option value={form.threshold}>{form.threshold}</option>}
          <option value="0">{m.release_search_spoilers_0({}, options)}</option>
          <option value="1">{m.release_search_spoilers_1({}, options)}</option>
          <option value="2">{m.release_search_spoilers_2({}, options)}</option>
        </select>
      </label>
      {form.condition && (
        <label className="grid gap-1 text-sm font-medium sm:col-span-2">
          <span>{m.release_search_condition({}, options)}</span>
          <textarea
            className="min-h-20 rounded-md border bg-background px-3 py-2 font-normal"
            name="condition"
            defaultValue={form.condition}
            aria-invalid={invalid.includes('condition') || undefined}
          />
        </label>
      )}
      {invalid.length > 0 && (
        <p role="alert" className="text-sm text-destructive sm:col-span-2">
          {m.release_search_invalid({}, options)}
        </p>
      )}
      <div className="sm:col-span-2">
        <button type="submit" className={buttonVariants()}>
          {m.release_search_apply({}, options)}
        </button>
      </div>
    </form>
  );
}

/** Grouped cards use server-confirmed current links and independent child cursors. */
export function ReleaseSearchPage({
  locale,
  parsed,
  types = [],
  selections,
  state,
  retryHref,
  reader,
}: {
  locale: string;
  parsed?: ParsedReleaseSearch;
  types?: ReleaseSearchType[];
  selections?: ReleaseSearchSelections;
  state: ReleaseSearchState;
  retryHref?: string;
  reader?: ReaderOrigin;
}) {
  const options = { locale: locales.find((value) => value === locale) ?? 'en' };
  const current = () => !reader || reader.isCurrent();
  const page = current() && 'page' in state ? state.page : undefined;
  const next = page?.next ?? null;
  const pageEmpty = page !== undefined && page.groups.length === 0 && next !== null;
  const restartHref = parsed
    ? releaseSearchHref(locale, parsed.form)
    : (retryHref ?? `/${encodeURIComponent(locale)}/search/releases`);

  const visit = useSearchWindow({
    cursor: parsed?.search.cursor,
    href: (cursor) => (parsed ? releaseSearchHref(locale, parsed.form, cursor) : restartHref),
    isCurrent: current,
    locale,
    session: null,
    ready: page?.status === 'ready',
    preparing: page?.status === 'preparing',
    settled: state.status !== 'loading',
    checkpoint: page?.as_of,
    recoverable: state.status === 'unavailable' || state.status === 'preparing',
    enabled: !!parsed && !parsed.invalid.length,
  });

  const owner = useReleaseChildOwner(
    JSON.stringify([locale, parsed?.form, parsed?.search, parsed?.invalid, page ?? state.status]),
    reader,
  );

  return (
    <main className="mx-auto max-w-5xl space-y-6 px-4 py-6">
      <PageHeading>{m.release_search_heading({}, options)}</PageHeading>
      <p className="text-muted-foreground">{m.release_search_intro({}, options)}</p>
      {parsed && (
        <ReleaseSearchFormView
          key={JSON.stringify(parsed.form)}
          parsed={parsed}
          types={types}
          locale={locale}
          {...(selections ? { selections } : {})}
        />
      )}
      {parsed && (
        <ReleaseWindowControls
          visit={visit}
          locale={locale}
          cursor={parsed.search.cursor}
          next={next}
          status={state.status}
          enabled={state.status !== 'loading' && !parsed.invalid.length && current()}
        />
      )}
      <section
        ref={visit.regionRef}
        tabIndex={-1}
        aria-label={m.release_search_window_results({}, options)}
        aria-busy={state.status === 'loading' || visit.busy || undefined}
        data-release-group-results
      >
        {!parsed?.invalid.length && !page && (
          <div
            role={
              ['unavailable', 'restart', 'invalid', 'unsupported', 'denied'].includes(state.status) ? 'alert' : 'status'
            }
            data-search-recovery={state.status}
            aria-busy={state.status === 'loading'}
            className="grid justify-items-start gap-3 rounded-lg border p-4"
          >
            <p>{discoveryMessage(state.status, locale)}</p>
            {state.status !== 'loading' && state.status !== 'unavailable' && (
              <a href={restartHref} className={buttonVariants({ variant: 'outline' })}>
                {state.status === 'restart'
                  ? m.discovery_restart_action({}, options)
                  : m.search_facet_retry({}, options)}
              </a>
            )}
          </div>
        )}
        {pageEmpty && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.release_search_page_empty({}, options)}
          </p>
        )}
        {page && page.status === 'preparing' && (
          <p role="status" aria-live="polite" className="text-sm text-muted-foreground">
            {discoveryMessage('preparing', locale)}
          </p>
        )}
        {page && page.groups.length > 0 && (
          <ul role="list" data-slot="release-search-results" className="space-y-2">
            {page.groups.map((group) => {
              if (group.kind === 'release')
                return <ReleaseResultRow key={`release:${group.id}`} card={group.release} locale={locale} />;
              return (
                <Fragment key={`work:${group.id}`}>
                  <ReleaseResultRow card={group.work} locale={locale} />
                  <ReleaseChildWindow
                    key={owner.id}
                    owner={owner}
                    group={group}
                    locale={locale}
                    {...(parsed ? { parsed } : {})}
                    restartHref={restartHref}
                  />
                </Fragment>
              );
            })}
          </ul>
        )}
        {page && page.status === 'ready' && page.groups.length === 0 && next === null && !parsed?.search.cursor && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.search_no_results({}, options)}
          </p>
        )}
        {page && page.status === 'ready' && (page.groups.length > 0 || parsed?.search.cursor) && next === null && (
          <p role="status" className="text-sm text-muted-foreground">
            {m.release_search_terminal({}, options)}
          </p>
        )}
      </section>
    </main>
  );
}

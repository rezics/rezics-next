import { useRecentSearches } from '../recent';
import { Cover, coverRatio, type CoverRatio } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { ArrowLeft, ArrowUp, Search, SlidersHorizontal } from 'lucide-react';
import { useEffect, useId, useReducer, useRef, useState, type ComponentProps, type RefObject } from 'react';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { subjectHref } from '../../subject/subject-href';
import { hitYear, localizedLabel, SubjectMeta } from '../results';
import type { SuggestionResult } from '../suggestions';
import { headerSearchAction, removesHeaderScope } from './authority';
import { useHeaderSearchFilterRegion, type HeaderSearchFilterRegion } from './filter-region';
import { ScopeChip } from './scope-chip';
import { initialHeaderSearchState, reduceHeaderSearchState, type HeaderSearchState } from './state';
import { loadGlobalHeaderSuggestions, type HeaderSuggestionLoader } from './suggestions';
import { RezicsMark } from '../../shell/mobile-mark';
import { RecentPanel, type SearchDiscovery } from '../recent-panel';
import type { SearchRealmDiscoveryLoader } from '../realm-discovery-section';
import type { RecentEntry, RecentHistory } from '../recent-history';
import { nextSuggestion, startTypeahead, validSuggestionText } from '../typeahead';
import type { SearchScope } from './types';

export type HeaderSearchProps = {
  locale: string;
  history?: RecentHistory | undefined;
  discovery?: SearchDiscovery | undefined;
  loadRealmDiscovery?: SearchRealmDiscoveryLoader | undefined;
  scope?: SearchScope | undefined;
  initialQuery?: string;
  fields?: readonly [string, string][] | undefined;
  loadSuggestions?: HeaderSuggestionLoader;
  /** Only supply this for an existing suggestion operation that enforces the current scope. */
  loadScopedSuggestions?: HeaderSuggestionLoader;
  onNavigate?(href: string): void;
  /** Resolve a member's list presentation only when supplied by the read. Otherwise use its own type. */
  suggestionRatio?: ((suggestion: SuggestionResult['subjects'][number]) => CoverRatio | undefined) | undefined;
  /** Reserved named empty action slot. No action is rendered. */
  slots?: { ask?: null };
  /** Use the same full-screen sheet when an enclosing surface requires it. */
  presentation?: 'responsive' | 'sheet';
};

type ViewProps = Pick<
  HeaderSearchProps,
  'locale' | 'fields' | 'suggestionRatio' | 'history' | 'discovery' | 'loadRealmDiscovery'
> & {
  id: string;
  state: HeaderSearchState;
  region: HeaderSearchFilterRegion | null;
  inputRef?: RefObject<HTMLInputElement | null>;
  formRef?: RefObject<HTMLFormElement | null>;
  inputProps?: ComponentProps<'input'>;
  formProps?: ComponentProps<'form'>;
  onOpen?(): void;
  onClose?(): void;
  onRemoveScope?(): void;
  onFilters?(): void;
  onSuggestion?(href: string): void;
  onActive?(index: number): void;
  onRetry?(): void;
  onRecent?(entry: RecentEntry): void;
  onQuery?(query: string): void;
  triggerRef?: RefObject<HTMLButtonElement | null>;
  recent?: React.ReactNode;
};

/** The real single-input presenter, also rendered by the stack-free regression. */
export function HeaderSearchView({
  id,
  state,
  locale,
  fields = [],
  region,
  inputRef,
  formRef,
  inputProps,
  formProps,
  onOpen,
  onClose,
  onRemoveScope = () => undefined,
  onFilters,
  onSuggestion,
  onActive,
  onRetry,
  suggestionRatio,
  triggerRef,
  recent,
  history,
  discovery,
  loadRealmDiscovery,
  onRecent,
  onQuery,
}: ViewProps) {
  const { expanded, phoneSheet, scope, query, suggestions, result, activeIndex } = state;
  const action = headerSearchAction(locale, scope);
  const count = new Intl.NumberFormat(locale).format(region?.activeCount ?? 0);
  const subjects = suggestions === 'ready' ? (result?.subjects ?? []) : [];
  const status = !action
    ? m.header_search_scope_unavailable()
    : suggestions === 'closed'
      ? m.platform_closed_message()
      : suggestions === 'restart'
        ? m.search_suggestions_restart()
        : suggestions === 'credentials'
          ? m.search_suggestions_credentials()
          : suggestions === 'invalid'
            ? m.search_suggestions_invalid()
            : suggestions === 'preparing'
              ? m.discovery_not_ready()
              : suggestions === 'error'
                ? m.search_suggestions_failed()
                : suggestions === 'loading'
                  ? m.header_search_loading()
                  : suggestions === 'empty'
                    ? m.search_no_suggestions()
                    : suggestions === 'unavailable'
                      ? m.search_suggestions_unavailable()
                      : '';
  // Plain GET forms replace an action's query string; retain its declared context as hidden controls.
  const target = action ? new URL(action, 'https://rezics.invalid') : undefined;
  const retained = scope
    ? [...(target?.searchParams ?? [])].filter(([key]) => key !== 'q' && key !== 'cursor')
    : fields;
  return (
    <div data-header-search data-expanded={expanded} className="relative min-w-0 w-full">
      <button
        ref={triggerRef}
        type="button"
        onClick={onOpen}
        aria-labelledby={`${id}-trigger-label`}
        aria-expanded={expanded}
        aria-controls={`${id}-form`}
        className={cn(
          'header-search-trigger flex h-11 w-full min-w-0 items-center gap-3 rounded-full border border-border/60 bg-muted/50 px-4 text-start text-sm text-muted-foreground outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring md:hidden',
          expanded && 'hidden',
        )}
      >
        <RezicsMark />
        <span id={`${id}-trigger-label`} className="truncate">
          {query || (scope ? m.header_search_in_scope({ scope: scope.name }) : m.header_search_global())}
        </span>
      </button>
      <form
        {...formProps}
        ref={formRef}
        id={`${id}-form`}
        role={phoneSheet ? 'dialog' : 'search'}
        aria-modal={phoneSheet || undefined}
        aria-label={m.search_label()}
        method="get"
        action={target?.pathname}
        data-phone-sheet={phoneSheet}
        className={cn(
          'header-search-surface bg-background text-foreground',
          expanded
            ? cn(
                'fixed inset-0 z-50 flex h-dvh flex-col overflow-y-auto overscroll-contain p-3 pb-[max(.75rem,env(safe-area-inset-bottom))]',
                !phoneSheet &&
                  'md:absolute md:inset-auto md:top-0 md:h-auto md:max-h-[min(80dvh,42rem)] md:w-full md:rounded-3xl md:border md:border-border md:p-0 md:shadow-xl',
              )
            : 'hidden rounded-full border border-border md:block',
        )}
      >
        {retained.map(([name, value], index) => (
          <input key={`${name}-${index}`} type="hidden" name={name} value={value} />
        ))}
        <div
          data-search-composer
          className={cn(
            expanded && 'shrink-0 rounded-3xl bg-card shadow-lg',
            expanded && !phoneSheet && 'md:bg-popover md:text-popover-foreground md:shadow-xl',
          )}
        >
          <div className="flex min-h-11 min-w-0 items-center gap-2 px-3">
            {expanded ? (
              <button
                type="button"
                onClick={onClose}
                aria-label={m.header_search_close()}
                className={cn(
                  'grid size-11 shrink-0 place-items-center rounded-full outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring',
                  !phoneSheet && 'md:hidden',
                )}
              >
                <ArrowLeft aria-hidden="true" className="size-5" />
              </button>
            ) : null}
            <Search
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 text-muted-foreground',
                expanded && (phoneSheet ? 'hidden' : 'hidden md:block'),
              )}
            />
            {scope && <ScopeChip scope={scope} onRemove={onRemoveScope} />}
            <input
              {...inputProps}
              ref={inputRef}
              name={action ? 'q' : undefined}
              type="text"
              role="combobox"
              aria-label={m.search_label()}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={expanded}
              aria-controls={expanded ? `${id}-suggestions` : undefined}
              aria-activedescendant={expanded && subjects[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
              aria-describedby={expanded && status ? `${id}-status` : undefined}
              placeholder={scope ? m.header_search_in_scope({ scope: scope.name }) : m.header_search_global()}
              value={query}
              autoComplete="off"
              maxLength={256}
              className="h-11 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:rounded-lg focus-visible:ring-2 focus-visible:ring-ring"
            />
          </div>
          {expanded && (
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
              <Button
                type="button"
                variant="outline"
                size="default"
                disabled={!region}
                onClick={onFilters}
                title={!region ? m.header_search_filters_unavailable() : undefined}
              >
                <SlidersHorizontal aria-hidden="true" className="size-4" />
                {m.search_filters()}
                {region && region.activeCount > 0 ? ` (${count})` : ''}
              </Button>
              <Button
                type="submit"
                size="icon"
                className="rounded-full"
                disabled={!action || !query.trim()}
                aria-label={m.search_submit()}
              >
                <ArrowUp aria-hidden="true" className="size-4" />
              </Button>
            </div>
          )}
        </div>
        {expanded && (
          <div className="flex min-h-0 flex-1 flex-col">
            {!query.trim() && (
              <RecentPanel
                recent={recent}
                language={locale}
                query={query}
                global={!scope}
                history={history}
                discovery={discovery}
                loadRealmDiscovery={loadRealmDiscovery}
                onSelect={onRecent}
                onQuery={onQuery}
              />
            )}
            {status && (
              <p id={`${id}-status`} role="status" className="px-4 py-5 text-sm text-muted-foreground">
                {status}
              </p>
            )}
            {onRetry && ['error', 'unavailable', 'preparing', 'restart'].includes(suggestions) && (
              <Button type="button" variant="outline" className="mx-4 w-fit" onClick={onRetry}>
                {m.search_facet_retry()}
              </Button>
            )}
            <ul
              id={`${id}-suggestions`}
              role="listbox"
              aria-label={m.header_search_suggestions()}
              aria-busy={suggestions === 'loading'}
              className="min-h-0 flex-1 overflow-y-auto px-2 py-2"
            >
              {subjects.map((suggestion, index) => {
                const label = localizedLabel(suggestion.labels, locale);
                const subject = coverSubject(suggestion.id, label.text, suggestion.summary, suggestion.type);
                const href = subjectHref({ id: suggestion.id, label: label.text }, locale).href;
                return (
                  <li
                    key={suggestion.id}
                    id={`${id}-option-${index}`}
                    role="option"
                    aria-selected={activeIndex === index}
                    onPointerMove={() => onActive?.(index)}
                    className={cn('rounded-xl', activeIndex === index && 'bg-accent')}
                  >
                    <a
                      href={href}
                      tabIndex={-1}
                      onPointerDown={(event) => {
                        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
                          event.preventDefault();
                      }}
                      className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={(event) => {
                        if (
                          onSuggestion &&
                          !event.metaKey &&
                          !event.ctrlKey &&
                          !event.shiftKey &&
                          !event.altKey &&
                          event.button === 0
                        ) {
                          event.preventDefault();
                          onSuggestion(href);
                        }
                      }}
                    >
                      <Cover
                        subject={subject}
                        cover={coverOf(suggestion.summary)}
                        size="xs"
                        ratio={suggestionRatio?.(suggestion) ?? coverRatio(subject.types)}
                        src={coverSrc}
                        decorative
                      />
                      <span className="flex min-w-0 flex-col gap-1">
                        <span className="truncate text-sm font-medium" lang={label.lang}>
                          {label.text}
                        </span>
                        <SubjectMeta
                          type={localizedLabel(result?.types?.[suggestion.type] ?? {}, locale)}
                          year={hitYear(suggestion.facts)}
                          locale={locale}
                          className="text-xs text-muted-foreground"
                        />
                      </span>
                    </a>
                  </li>
                );
              })}
            </ul>
          </div>
        )}
        {/* Keep a default submit control for plain GET submission before the composer is expanded. */}
        {!expanded && (
          <button type="submit" className="sr-only" tabIndex={-1} disabled={!action}>
            {m.search_submit()}
          </button>
        )}
      </form>
      <noscript>
        <style>{'.header-search-trigger{display:none}.header-search-surface{display:block}'}</style>
      </noscript>
    </div>
  );
}

function HeaderSearchController({
  locale,
  scope,
  initialQuery = '',
  fields,
  loadSuggestions = loadGlobalHeaderSuggestions,
  loadScopedSuggestions,
  onNavigate,
  suggestionRatio,
  presentation = 'responsive',
  history,
  discovery,
  loadRealmDiscovery,
}: HeaderSearchProps) {
  const [state, dispatch] = useReducer(reduceHeaderSearchState, undefined, () =>
    initialHeaderSearchState(scope, initialQuery),
  );
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returningFocus = useRef(false);
  const request = useRef<(() => void) | null>(null);
  const [attempt, retry] = useReducer((value: number) => value + 1, 0);
  const [composing, setComposing] = useState(false);
  const region = useHeaderSearchFilterRegion();
  useEffect(() => {
    dispatch({ type: 'sync-scope', scope });
  }, [scope]);
  useEffect(() => {
    dispatch({ type: 'sync-query', query: initialQuery });
  }, [initialQuery]);
  useEffect(() => {
    if (!state.expanded || !state.query.trim() || composing) return;
    if (!validSuggestionText(state.query)) {
      dispatch({ type: 'suggestions', state: 'invalid' });
      return;
    }
    const loader = state.scope ? loadScopedSuggestions : loadSuggestions;
    if (!loader || !headerSearchAction(locale, state.scope)) {
      dispatch({ type: 'suggestions', state: 'unavailable' });
      return;
    }
    dispatch({ type: 'suggestions', state: 'loading' });
    const cancel = startTypeahead(
      loader,
      state.query,
      locale,
      state.scope,
      (result) => dispatch({ type: 'suggestions', state: result.subjects.length ? 'ready' : 'empty', result }),
      (failure) => dispatch({ type: 'suggestions', state: failure }),
    );
    request.current = cancel;
    return cancel;
  }, [state.query, state.scope, state.expanded, locale, composing, attempt, loadSuggestions, loadScopedSuggestions]);
  const close = (reason: 'escape' | 'outside', restore = false) => {
    request.current?.();
    dispatch({ type: reason });
    // A new opening reads current native data; no result survives dismissal or account navigation.
    dispatch({ type: 'invalidate' });
    if (restore) {
      returningFocus.current = true;
      if (state.phoneSheet)
        requestAnimationFrame(() => {
          if (window.matchMedia('(max-width: 767px)').matches) trigger.current?.focus();
          else input.current?.focus();
          returningFocus.current = false;
        });
      else {
        input.current?.focus();
        returningFocus.current = false;
      }
    }
  };
  const open = () => {
    dispatch({
      type: presentation === 'sheet' || window.matchMedia('(max-width: 767px)').matches ? 'open-phone' : 'focus',
    });
    if (state.query.trim() && state.suggestions === 'idle') dispatch({ type: 'query', query: state.query });
    requestAnimationFrame(() => input.current?.focus());
  };
  useEffect(() => {
    if (!state.expanded) return;
    const outside = (event: PointerEvent) => {
      if (!form.current?.contains(event.target as Node)) close('outside');
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [state.expanded]);
  useEffect(() => {
    if (!state.phoneSheet) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    return () => {
      document.body.style.overflow = previous;
    };
  }, [state.phoneSheet]);
  useEffect(() => {
    const discard = () => close('outside');
    const hidden = () => {
      if (document.hidden) discard();
    };
    window.addEventListener('pagehide', discard);
    document.addEventListener('visibilitychange', hidden);
    return () => {
      window.removeEventListener('pagehide', discard);
      document.removeEventListener('visibilitychange', hidden);
    };
  }, []);
  const visit = (href: string) => {
    close('outside');
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  };
  const submitQuery = (query: string, scope: SearchScope | undefined) => {
    const action = headerSearchAction(locale, scope);
    if (!action || (!query.trim() && !scope)) return;
    history?.remember(query, scope);
    const url = new URL(action, window.location.origin);
    url.searchParams.delete('q');
    url.searchParams.delete('cursor');
    // Follow the same native GET context as the mounted form. Native routes revalidate remembered scopes.
    if (!scope) for (const [key, value] of fields ?? []) url.searchParams.append(key, value);
    if (query.trim()) url.searchParams.set('q', query);
    visit(`${url.pathname}${url.search}`);
  };
  return (
    <HeaderSearchView
      id={id}
      history={history}
      discovery={discovery}
      loadRealmDiscovery={loadRealmDiscovery}
      onQuery={(query) => submitQuery(query, undefined)}
      onRecent={(entry) => {
        dispatch({ type: 'sync-scope', scope: entry.scope });
        dispatch({ type: 'query', query: entry.query });
        if (headerSearchAction(locale, entry.scope)) submitQuery(entry.query, entry.scope);
        else input.current?.focus();
      }}
      state={state}
      locale={locale}
      fields={fields}
      region={state.scope ? null : region}
      inputRef={input}
      formRef={form}
      triggerRef={trigger}
      suggestionRatio={suggestionRatio}
      onOpen={open}
      onClose={() => close('escape', true)}
      onRemoveScope={() => {
        request.current?.();
        dispatch({ type: 'remove-scope' });
        input.current?.focus();
      }}
      onSuggestion={(href) => {
        history?.remember(state.query, state.scope);
        visit(href);
      }}
      onActive={(index) => dispatch({ type: 'active', index })}
      onRetry={retry}
      onFilters={() => {
        close('outside');
        region?.open();
      }}
      inputProps={{
        onFocus: () => {
          if (!state.expanded && !returningFocus.current) open();
        },
        onClick: () => {
          if (!state.expanded) open();
        },
        onChange: (event) => {
          request.current?.();
          if (!state.expanded) open();
          dispatch({ type: 'query', query: event.currentTarget.value });
        },
        onCompositionStart: () => {
          request.current?.();
          dispatch({ type: 'invalidate' });
          setComposing(true);
        },
        onCompositionEnd: (event) => {
          dispatch({ type: 'query', query: event.currentTarget.value });
          setComposing(false);
        },
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return;
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !state.expanded) {
            event.preventDefault();
            open();
            return;
          }
          if (removesHeaderScope(event.key, state.query, state.scope)) {
            request.current?.();
            event.preventDefault();
            dispatch({ type: 'remove-scope' });
          }
          const subjects = state.result?.subjects ?? [];
          const next = nextSuggestion(event.key, state.activeIndex, subjects.length);
          if (next !== undefined && state.expanded) {
            event.preventDefault();
            dispatch({ type: 'active', index: next });
            document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
          }
          if (event.key === 'Enter' && state.expanded && state.activeIndex >= 0 && subjects[state.activeIndex]) {
            event.preventDefault();
            const hit = subjects[state.activeIndex]!;
            history?.remember(state.query, state.scope);
            visit(subjectHref({ id: hit.id, label: localizedLabel(hit.labels, locale).text }, locale).href);
          }
        },
      }}
      formProps={{
        onSubmit: (event) => {
          const action = headerSearchAction(locale, state.scope);
          if (composing || !action || !state.query.trim()) {
            event.preventDefault();
            return;
          }
          history?.remember(state.query, state.scope);
          if (!onNavigate) return;
          event.preventDefault();
          const url = new URL(action, window.location.origin);
          url.search = new URLSearchParams(new FormData(event.currentTarget) as never).toString();
          url.searchParams.set('q', state.query);
          visit(`${url.pathname}${url.search}`);
        },
        onBlur: (event) => {
          if (!state.phoneSheet && !event.currentTarget.contains(event.relatedTarget as Node | null)) close('outside');
        },
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return;
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close('escape', true);
          }
          if (event.key === 'Tab' && state.phoneSheet) {
            const controls = Array.from(
              form.current?.querySelectorAll<HTMLElement>('input:not([type="hidden"]),a[href],button:not(:disabled)') ??
                [],
            ).filter((control) => control.tabIndex >= 0 && control.getClientRects().length > 0);
            const first = controls[0],
              last = controls.at(-1);
            if (event.shiftKey && document.activeElement === first) {
              event.preventDefault();
              last?.focus();
            } else if (!event.shiftKey && document.activeElement === last) {
              event.preventDefault();
              first?.focus();
            }
          }
        },
      }}
    />
  );
}

function ConnectedHeaderSearch(props: HeaderSearchProps) {
  const history = useRecentSearches();
  return <HeaderSearchController {...props} history={history} />;
}
export function HeaderSearch(props: HeaderSearchProps) {
  return props.history ? <HeaderSearchController {...props} /> : <ConnectedHeaderSearch {...props} />;
}

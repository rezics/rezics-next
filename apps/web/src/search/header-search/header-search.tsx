import { Cover, coverRatio, type CoverRatio } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { ArrowUp, Search, X } from 'lucide-react';
import { useEffect, useId, useReducer, useRef, type ComponentProps, type RefObject } from 'react';
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
import { loadGlobalHeaderSuggestions, readHeaderSuggestions, type HeaderSuggestionLoader } from './suggestions';
import type { SearchScope } from './types';

export type HeaderSearchProps = {
  locale: string;
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

type ViewProps = Pick<HeaderSearchProps, 'locale' | 'fields' | 'suggestionRatio'> & {
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
  triggerRef?: RefObject<HTMLButtonElement | null>;
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
  suggestionRatio,
  triggerRef,
}: ViewProps) {
  const { expanded, phoneSheet, scope, query, suggestions, result, activeIndex } = state;
  const action = headerSearchAction(locale, scope);
  const count = new Intl.NumberFormat(locale).format(region?.activeCount ?? 0);
  const subjects = result?.subjects ?? [];
  const status = !action
    ? m.header_search_scope_unavailable()
    : suggestions === 'error'
      ? m.search_suggestions_failed()
      : suggestions === 'loading'
        ? m.header_search_loading()
        : suggestions === 'empty'
          ? m.search_no_suggestions()
          : suggestions === 'unavailable'
            ? m.header_search_scope_unavailable()
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
        aria-label={m.search_label()}
        aria-expanded={expanded}
        aria-controls={`${id}-form`}
        className={cn(
          'header-search-trigger grid size-10 place-items-center rounded-full hover:bg-accent md:hidden',
          expanded && 'hidden',
        )}
      >
        <Search aria-hidden="true" className="size-5" />
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
          'header-search-surface border border-border bg-background text-foreground focus-within:border-ring',
          expanded
            ? cn(
                'fixed inset-0 z-50 flex h-dvh flex-col overflow-y-auto p-3',
                !phoneSheet &&
                  'md:absolute md:inset-auto md:top-0 md:h-auto md:max-h-[min(80dvh,42rem)] md:w-full md:rounded-3xl md:p-0 md:shadow-xl',
              )
            : 'hidden rounded-full md:block',
        )}
      >
        {retained.map(([name, value], index) => (
          <input key={`${name}-${index}`} type="hidden" name={name} value={value} />
        ))}
        <div className="flex min-h-11 min-w-0 items-center gap-2 px-3">
          <Search aria-hidden="true" className="size-4 shrink-0 text-muted-foreground" />
          {scope && <ScopeChip scope={scope} onRemove={onRemoveScope} />}
          <input
            {...inputProps}
            ref={inputRef}
            name={action ? 'q' : undefined}
            type="text"
            role="combobox"
            aria-label={m.search_label()}
            aria-autocomplete="list"
            aria-expanded={expanded}
            aria-controls={expanded ? `${id}-suggestions` : undefined}
            aria-activedescendant={expanded && activeIndex >= 0 ? `${id}-option-${activeIndex}` : undefined}
            aria-describedby={expanded && status ? `${id}-status` : undefined}
            placeholder={scope ? m.header_search_in_scope({ scope: scope.name }) : m.header_search_global()}
            value={query}
            autoComplete="off"
            maxLength={256}
            className="h-11 min-w-0 flex-1 border-0 bg-transparent text-sm outline-none placeholder:text-muted-foreground focus-visible:outline-none"
          />
          <button
            type="button"
            onClick={onClose}
            aria-label={m.header_search_close()}
            className={cn(
              'grid size-9 shrink-0 place-items-center rounded-full hover:bg-accent',
              !phoneSheet && 'md:hidden',
              !expanded && 'hidden',
            )}
          >
            <X aria-hidden="true" className="size-4" />
          </button>
        </div>
        {expanded && (
          <div className="flex min-h-0 flex-1 flex-col">
            {status && (
              <p id={`${id}-status`} role="status" className="px-4 py-5 text-sm text-muted-foreground">
                {status}
              </p>
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
                    className={cn('rounded-xl', activeIndex === index && 'bg-accent')}
                  >
                    <a
                      href={href}
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
            <div className="mt-auto flex items-center justify-between gap-3 border-t border-border/60 p-3">
              <Button
                type="button"
                variant="ghost"
                size="sm"
                disabled={!region}
                onClick={onFilters}
                title={!region ? m.header_search_filters_unavailable() : undefined}
              >
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
        <style>
          {
            '.header-search-trigger{display:none}.header-search-surface{display:block}@media(max-width:767px){[data-header-search]{position:fixed;inset-inline:1rem;top:4.5rem;width:auto}}'
          }
        </style>
      </noscript>
    </div>
  );
}

export function HeaderSearch({
  locale,
  scope,
  initialQuery = '',
  fields,
  loadSuggestions = loadGlobalHeaderSuggestions,
  loadScopedSuggestions,
  onNavigate,
  suggestionRatio,
  presentation = 'responsive',
}: HeaderSearchProps) {
  const [state, dispatch] = useReducer(reduceHeaderSearchState, undefined, () =>
    initialHeaderSearchState(scope, initialQuery),
  );
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returningFocus = useRef(false);
  const request = useRef<AbortController | null>(null);
  const region = useHeaderSearchFilterRegion();
  useEffect(() => {
    dispatch({ type: 'sync-scope', scope });
  }, [scope]);
  useEffect(() => {
    dispatch({ type: 'sync-query', query: initialQuery });
  }, [initialQuery]);
  useEffect(() => {
    if (!state.query.trim() || state.suggestions !== 'loading') return;
    const loader = state.scope ? loadScopedSuggestions : loadSuggestions;
    if (!loader || !headerSearchAction(locale, state.scope)) {
      dispatch({ type: 'suggestions', state: 'unavailable' });
      return;
    }
    const controller = new AbortController();
    request.current = controller;
    const timer = setTimeout(async () => {
      try {
        const result = await readHeaderSuggestions(loader, state.query.trim(), locale, controller.signal, state.scope);
        if (!controller.signal.aborted)
          dispatch({ type: 'suggestions', state: result.subjects.length ? 'ready' : 'empty', result });
      } catch {
        if (!controller.signal.aborted) dispatch({ type: 'suggestions', state: 'error' });
      }
    }, 200);
    return () => {
      clearTimeout(timer);
      controller.abort();
    };
    // State changes from a response or opening/closing the surface never issue another operation.
  }, [state.query, state.scope, locale, loadSuggestions, loadScopedSuggestions]);
  const close = (reason: 'escape' | 'outside', restore = false) => {
    request.current?.abort();
    dispatch({ type: reason });
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
  const visit = (href: string) => {
    close('outside');
    if (onNavigate) onNavigate(href);
    else window.location.assign(href);
  };
  return (
    <HeaderSearchView
      id={id}
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
        dispatch({ type: 'remove-scope' });
        input.current?.focus();
      }}
      onSuggestion={visit}
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
          if (!state.expanded) open();
          dispatch({ type: 'query', query: event.currentTarget.value });
        },
        onKeyDown: (event) => {
          if (event.nativeEvent.isComposing) return;
          if (removesHeaderScope(event.key, state.query, state.scope)) {
            event.preventDefault();
            dispatch({ type: 'remove-scope' });
          }
          const subjects = state.result?.subjects ?? [];
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && subjects.length) {
            event.preventDefault();
            if (!state.expanded) open();
            const next =
              event.key === 'ArrowDown'
                ? (state.activeIndex + 1) % subjects.length
                : state.activeIndex < 0
                  ? subjects.length - 1
                  : (state.activeIndex - 1 + subjects.length) % subjects.length;
            dispatch({ type: 'active', index: next });
            document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
          }
          if (event.key === 'Enter' && state.expanded && state.activeIndex >= 0 && subjects[state.activeIndex]) {
            event.preventDefault();
            const hit = subjects[state.activeIndex]!;
            visit(subjectHref({ id: hit.id, label: localizedLabel(hit.labels, locale).text }, locale).href);
          }
        },
      }}
      formProps={{
        onSubmit: (event) => {
          const action = headerSearchAction(locale, state.scope);
          if (!action || !state.query.trim()) {
            event.preventDefault();
            return;
          }
          if (!onNavigate) return;
          event.preventDefault();
          const url = new URL(action, window.location.origin);
          url.search = new URLSearchParams(new FormData(event.currentTarget) as never).toString();
          url.searchParams.set('q', state.query.trim());
          visit(`${url.pathname}${url.search}`);
        },
        onBlur: (event) => {
          if (!state.phoneSheet && !event.currentTarget.contains(event.relatedTarget as Node | null)) close('outside');
        },
        onKeyDown: (event) => {
          if (event.key === 'Escape') {
            event.preventDefault();
            event.stopPropagation();
            close('escape', true);
          }
          if (event.key === 'Tab' && state.phoneSheet) {
            const controls = Array.from(
              form.current?.querySelectorAll<HTMLElement>('input:not([type="hidden"]),a[href],button:not(:disabled)') ??
                [],
            );
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

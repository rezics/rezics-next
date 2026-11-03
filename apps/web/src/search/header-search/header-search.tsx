import { useRecentSearches } from '../recent';
import { Cover, coverRatio, type CoverRatio } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { Kbd } from '@rezics/ui/shadcn/kbd';
import { cn } from '@rezics/ui/utils';
import { ArrowLeft, ArrowUp, Search, SlidersHorizontal } from 'lucide-react';
import {
  useEffect,
  useId,
  useLayoutEffect,
  useReducer,
  useRef,
  useState,
  type ComponentProps,
  type RefObject,
} from 'react';
import { m } from '../../paraglide/messages.js';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { subjectHref } from '../../subject/subject-href';
import { hitYear, localizedLabel, SubjectMeta } from '../results';
import type { SuggestionResult } from '../suggestions';
import { headerSearchAction, removesHeaderScope } from './authority';
import { useHeaderSearchFilterRegion, type HeaderSearchFilterRegion } from './filter-region';
import { ScopeChip } from './scope-chip';
import {
  headerSearchScopeKey,
  initialHeaderSearchState,
  reduceHeaderSearchState,
  type HeaderSearchState,
} from './state';
import { loadGlobalHeaderSuggestions, type HeaderSuggestionLoader } from './suggestions';
import { RezicsMark } from '../../shell/mobile-mark';
import { RecentPanel, type SearchDiscovery } from '../recent-panel';
import type { SearchRealmDiscoveryLoader } from '../realm-discovery-section';
import { applyRecentSearch, type RecentEntry, type RecentHistory } from '../recent-history';
import { nextSuggestion, startTypeahead, validSuggestionText } from '../typeahead';
import type { SearchScope } from './types';
import { canEnterHeaderSearch } from './keyboard';
import { isWithinGlobalSearchQueryLimit } from '../query-text-limit';
import type { BrowserSession } from '../../session/browser-state';
import { headerSearchSessionKey } from './session-key';
import { useSearchRetryWait } from '../search-recovery-retry';

const controlFocus =
  'focus-visible:ring-0 focus-visible:border-foreground focus-visible:outline-2 focus-visible:outline-foreground focus-visible:outline-offset-2';
const compactSearch = '(max-width: 1023px)';
const retryableSuggestions = ['error', 'unavailable', 'preparing', 'restart'];

type HeaderSuggestionOwner = {
  sessionKey: string | null;
  locale: string;
  query: string;
  scopeKey: string;
  loader: HeaderSuggestionLoader | undefined;
};

function sameHeaderSuggestionOwner(a: HeaderSuggestionOwner | null, b: HeaderSuggestionOwner): boolean {
  return Boolean(
    a &&
    a.sessionKey === b.sessionKey &&
    a.locale === b.locale &&
    a.query === b.query &&
    a.scopeKey === b.scopeKey &&
    a.loader === b.loader,
  );
}

export type HeaderSearchProps = {
  locale: string;
  /** ShellSearch supplies the installed session observation; isolated presenters default to anonymous. */
  session?: BrowserSession;
  /** Read the same owner at dispatch time, including cache changes queued before a render. */
  readSession?: () => BrowserSession;
  observeSession?: (retire: () => void) => () => void;
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
  /** Opt in only for the default ShellSearch owner; isolated instances never claim the document shortcut. */
  keyboardShortcut?: boolean;
};

type ViewProps = Pick<
  HeaderSearchProps,
  'locale' | 'fields' | 'suggestionRatio' | 'history' | 'discovery' | 'loadRealmDiscovery' | 'keyboardShortcut'
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
  canSelectSuggestion?(): boolean;
  onActive?(index: number): void;
  onRetry?(activation?: { keyboard: boolean }): void;
  onRecent?(entry: RecentEntry): void;
  onQuery?(query: string): void;
  queryLimitError?: boolean;
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
  canSelectSuggestion,
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
  queryLimitError = false,
  keyboardShortcut = false,
}: ViewProps) {
  const { expanded, phoneSheet, scope, query, suggestions, result, activeIndex } = state;
  const retryable = onRetry !== undefined && retryableSuggestions.includes(suggestions);
  const retryWaiting = useSearchRetryWait(retryable ? state.retryAt : undefined);
  const action = headerSearchAction(locale, scope);
  const messageOptions = { locale: locale as never };
  const count = new Intl.NumberFormat(locale).format(region?.activeCount ?? 0);
  const subjects = suggestions === 'ready' ? (result?.subjects ?? []) : [];
  const triggerLabel =
    query ||
    (scope
      ? m.header_search_in_scope({ scope: scope.name }, messageOptions)
      : m.header_search_global({}, messageOptions));
  const shortcutLabel = 'Ctrl/⌘ K';
  const triggerName = keyboardShortcut ? `${triggerLabel} ${shortcutLabel}` : triggerLabel;
  const showQueryLimitError = !scope && queryLimitError;
  const status = !action
    ? m.header_search_scope_unavailable({}, messageOptions)
    : suggestions === 'closed'
      ? m.platform_closed_message({}, messageOptions)
      : suggestions === 'restart'
        ? m.search_suggestions_restart({}, messageOptions)
        : suggestions === 'credentials'
          ? m.search_suggestions_credentials({}, messageOptions)
          : suggestions === 'invalid'
            ? m.search_suggestions_invalid({}, messageOptions)
            : suggestions === 'preparing'
              ? m.discovery_not_ready({}, messageOptions)
              : suggestions === 'error'
                ? m.search_suggestions_failed({}, messageOptions)
                : suggestions === 'loading'
                  ? m.header_search_loading({}, messageOptions)
                  : suggestions === 'empty'
                    ? m.search_no_suggestions({}, messageOptions)
                    : suggestions === 'unavailable'
                      ? m.search_suggestions_unavailable({}, messageOptions)
                      : '';
  // Plain GET forms replace an action's query string; retain its declared context as hidden controls.
  const target = action ? new URL(action, 'https://rezics.invalid') : undefined;
  const retained = scope
    ? [...(target?.searchParams ?? [])].filter(([key]) => key !== 'q' && key !== 'cursor')
    : fields;
  return (
    <div
      data-header-search
      data-expanded={expanded}
      role={phoneSheet ? 'dialog' : undefined}
      aria-modal={phoneSheet || undefined}
      aria-label={phoneSheet ? m.search_label({}, messageOptions) : undefined}
      className="relative min-w-0 w-full"
    >
      {keyboardShortcut && (
        <span id={`${id}-keyboard-help`} className="sr-only">
          {m.header_search_keyboard_help({}, messageOptions)}
        </span>
      )}
      <button
        ref={triggerRef}
        type="button"
        onClick={onOpen}
        aria-label={triggerName}
        aria-expanded={expanded}
        aria-controls={`${id}-form`}
        aria-keyshortcuts={keyboardShortcut ? 'Control+k Meta+k' : undefined}
        aria-describedby={keyboardShortcut ? `${id}-keyboard-help` : undefined}
        title={keyboardShortcut ? m.header_search_keyboard_help({}, messageOptions) : undefined}
        className={cn(
          'header-search-trigger flex h-11 w-full min-w-0 items-center gap-3 rounded-full border border-border/60 bg-muted/50 px-4 text-start text-sm text-muted-foreground outline-none hover:bg-accent lg:hidden',
          controlFocus,
          expanded && 'hidden',
        )}
      >
        <RezicsMark />
        <span className="truncate">{triggerLabel}</span>
        {keyboardShortcut && (
          <>
            {' '}
            <Kbd className="ms-auto shrink-0">{shortcutLabel}</Kbd>
          </>
        )}
      </button>
      <form
        {...formProps}
        ref={formRef}
        id={`${id}-form`}
        role="search"
        aria-label={m.search_label({}, messageOptions)}
        method="get"
        action={target?.pathname}
        data-phone-sheet={phoneSheet}
        className={cn(
          'header-search-surface bg-background text-foreground',
          expanded
            ? cn(
                'fixed inset-0 z-50 flex h-dvh flex-col overflow-hidden overscroll-contain p-3 pt-[max(.75rem,env(safe-area-inset-top))] pb-[max(.75rem,env(safe-area-inset-bottom))] ps-[max(.75rem,env(safe-area-inset-left))] pe-[max(.75rem,env(safe-area-inset-right))]',
                !phoneSheet &&
                  'lg:absolute lg:inset-auto lg:top-0 lg:h-auto lg:max-h-[min(80dvh,42rem)] lg:w-full lg:rounded-3xl lg:border lg:border-border lg:p-0 lg:shadow-xl',
              )
            : 'hidden rounded-full border border-border lg:block',
        )}
      >
        {retained.map(([name, value], index) => (
          <input key={`${name}-${index}`} type="hidden" name={name} value={value} />
        ))}
        <div
          data-search-composer
          className={cn(expanded ? 'shrink-0 rounded-t-3xl border-b border-border/60' : 'rounded-full')}
        >
          <div className={cn('flex min-h-11 min-w-0 items-center gap-2 px-4', expanded && 'py-2')}>
            {expanded ? (
              <button
                type="button"
                onClick={onClose}
                aria-label={m.header_search_close({}, messageOptions)}
                className={cn(
                  'grid size-11 shrink-0 place-items-center rounded-full outline-none hover:bg-accent',
                  controlFocus,
                  !phoneSheet && 'lg:hidden',
                )}
              >
                <ArrowLeft aria-hidden="true" className="size-5" />
              </button>
            ) : null}
            <Search
              aria-hidden="true"
              className={cn(
                'size-4 shrink-0 text-muted-foreground',
                expanded && (phoneSheet ? 'hidden' : 'hidden lg:block'),
              )}
            />
            {scope && <ScopeChip scope={scope} locale={locale} onRemove={onRemoveScope} />}
            <input
              {...inputProps}
              ref={inputRef}
              name={action ? 'q' : undefined}
              type="text"
              role="combobox"
              aria-label={m.search_label({}, messageOptions)}
              aria-autocomplete="list"
              aria-haspopup="listbox"
              aria-expanded={expanded}
              aria-controls={expanded ? `${id}-suggestions` : undefined}
              aria-activedescendant={expanded && subjects[activeIndex] ? `${id}-option-${activeIndex}` : undefined}
              aria-keyshortcuts={keyboardShortcut ? 'Control+k Meta+k' : undefined}
              aria-invalid={showQueryLimitError || undefined}
              aria-describedby={
                [
                  keyboardShortcut && `${id}-keyboard-help`,
                  expanded && status && `${id}-status`,
                  showQueryLimitError && `${id}-query-limit-error`,
                ]
                  .filter(Boolean)
                  .join(' ') || undefined
              }
              title={keyboardShortcut ? m.header_search_keyboard_help({}, messageOptions) : undefined}
              placeholder={
                scope
                  ? m.header_search_in_scope({ scope: scope.name }, messageOptions)
                  : m.header_search_global({}, messageOptions)
              }
              value={query}
              autoComplete="off"
              maxLength={scope ? 256 : undefined}
              className="h-11 min-w-0 flex-1 rounded-lg border-0 bg-transparent px-2 py-3 text-sm placeholder:text-muted-foreground focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-foreground focus-visible:-outline-offset-2"
            />
            {keyboardShortcut && (
              <Kbd aria-hidden="true" className="shrink-0">
                Ctrl/⌘ K
              </Kbd>
            )}
          </div>
          {expanded && (
            <div className="flex items-center justify-between gap-3 px-4 pb-3 pt-2">
              <Button
                type="button"
                variant="outline"
                size="default"
                className={cn('min-h-11', controlFocus)}
                disabled={!region}
                onClick={onFilters}
                title={!region ? m.header_search_filters_unavailable({}, messageOptions) : undefined}
              >
                <SlidersHorizontal aria-hidden="true" className="size-4" />
                {m.search_filters({}, messageOptions)}
                {region && region.activeCount > 0 ? ` (${count})` : ''}
              </Button>
              <Button
                type="submit"
                size="icon"
                className={cn('size-11 rounded-full', controlFocus)}
                disabled={!action || !query.trim()}
                aria-label={m.search_submit({}, messageOptions)}
              >
                <ArrowUp aria-hidden="true" className="size-4" />
              </Button>
            </div>
          )}
        </div>
        {showQueryLimitError && (
          <p id={`${id}-query-limit-error`} role="alert" className="px-4 pb-3 text-sm text-destructive">
            {m.search_query_limit_error({}, messageOptions)}
          </p>
        )}
        {expanded && (
          <div className="min-h-0 flex-1 overflow-y-auto overscroll-contain">
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
            {retryWaiting && retryable && (
              <p role="status" className="px-4 pb-2 text-sm text-muted-foreground">
                {m.settings_retry_wait({}, messageOptions)}
              </p>
            )}
            {retryable && (
              <Button
                type="button"
                variant="outline"
                className="mx-4 w-fit"
                disabled={retryWaiting}
                onClick={(event) => {
                  if (retryWaiting) return;
                  onRetry?.({
                    keyboard:
                      event.detail === 0 && event.currentTarget.ownerDocument.activeElement === event.currentTarget,
                  });
                }}
              >
                {m.search_facet_retry({}, messageOptions)}
              </Button>
            )}
            <ul
              id={`${id}-suggestions`}
              role="listbox"
              aria-label={m.header_search_suggestions({}, messageOptions)}
              aria-busy={suggestions === 'loading'}
              className="px-2 py-2"
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
                        if (canSelectSuggestion && !canSelectSuggestion()) {
                          event.preventDefault();
                          return;
                        }
                        if (event.button === 0 && !event.metaKey && !event.ctrlKey && !event.shiftKey && !event.altKey)
                          event.preventDefault();
                      }}
                      className="flex items-center gap-3 rounded-xl px-2 py-2 hover:bg-accent focus-visible:outline-2 focus-visible:outline-ring"
                      onClick={(event) => {
                        if (canSelectSuggestion && !canSelectSuggestion()) {
                          event.preventDefault();
                          return;
                        }
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
                      onAuxClick={(event) => {
                        if (canSelectSuggestion && !canSelectSuggestion()) event.preventDefault();
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
            {m.search_submit({}, messageOptions)}
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
  session,
  readSession,
  observeSession: subscribeSession,
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
  keyboardShortcut = false,
}: HeaderSearchProps) {
  const [state, dispatch] = useReducer(reduceHeaderSearchState, undefined, () =>
    initialHeaderSearchState(scope, initialQuery),
  );
  const suppliedScopeKey = headerSearchScopeKey(scope);
  const appliedScopeKey = useRef(suppliedScopeKey);
  const scopeChanged = suppliedScopeKey !== appliedScopeKey.current;
  // A new supplied scope takes ownership during render; the reducer sync follows in layout.
  const requestScope = scopeChanged ? scope : state.scope;
  const requestScopeKey = headerSearchScopeKey(requestScope);
  const requestState = requestScope === state.scope ? state : { ...state, scope: requestScope };
  const id = useId();
  const input = useRef<HTMLInputElement>(null);
  const form = useRef<HTMLFormElement>(null);
  const trigger = useRef<HTMLButtonElement>(null);
  const returningFocus = useRef(false);
  const pendingFocus = useRef<'input' | 'return' | null>(null);
  const pendingRetryEntry = useRef(false);
  const priorFocus = useRef<HTMLElement | null>(null);
  const request = useRef<(() => void) | null>(null);
  const sessionKey = headerSearchSessionKey(session);
  const [observedSession, observeSession] = useState(sessionKey);
  const currentSession = useRef(sessionKey);
  const resultsRetired = useRef(false);
  currentSession.current = sessionKey;
  const sessionMatches = sessionKey !== null && sessionKey === observedSession;
  const loader = requestScope ? loadScopedSuggestions : loadSuggestions;
  const owner: HeaderSuggestionOwner = {
    sessionKey,
    locale,
    query: requestState.query,
    scopeKey: requestScopeKey,
    loader,
  };
  const renderedOwner = useRef(owner);
  renderedOwner.current = owner;
  const committedOwner = useRef(owner);
  const suggestionsOwner = useRef<HeaderSuggestionOwner | null>(null);
  const resultOwner = useRef<HeaderSuggestionOwner | null>(null);
  const requestGeneration = useRef(0);
  const sessionIsCurrent = () =>
    sessionMatches &&
    currentSession.current === sessionKey &&
    (!readSession || headerSearchSessionKey(readSession()) === sessionKey);
  // Mask during render as well as clearing stored state before input can select an old option.
  const canSelectSuggestion = () =>
    sessionIsCurrent() &&
    sameHeaderSuggestionOwner(renderedOwner.current, owner) &&
    sameHeaderSuggestionOwner(resultOwner.current, owner) &&
    !resultsRetired.current &&
    requestState.suggestions === 'ready' &&
    Boolean(requestState.result);
  const suggestionsCurrent = sameHeaderSuggestionOwner(suggestionsOwner.current, owner);
  const resultCurrent = sameHeaderSuggestionOwner(resultOwner.current, owner) && !resultsRetired.current;
  const visibleState: HeaderSearchState =
    sessionMatches && suggestionsCurrent
      ? {
          ...requestState,
          result: resultCurrent ? requestState.result : undefined,
          activeIndex: resultCurrent ? requestState.activeIndex : -1,
        }
      : { ...requestState, suggestions: 'idle', result: undefined, retryAt: undefined, activeIndex: -1 };
  const [attempt, retry] = useReducer((value: number) => value + 1, 0);
  const [composing, setComposing] = useState(false);
  const [queryLimitError, setQueryLimitError] = useState(false);
  const region = useHeaderSearchFilterRegion();
  const retireRetryEntry = () => {
    pendingRetryEntry.current = false;
  };
  const requestRetry = (activation?: { keyboard: boolean }) => {
    if (activation?.keyboard) pendingRetryEntry.current = true;
    retry();
  };
  useLayoutEffect(
    () =>
      subscribeSession?.(() => {
        requestGeneration.current += 1;
        retireRetryEntry();
        resultsRetired.current = true;
        suggestionsOwner.current = null;
        resultOwner.current = null;
        request.current?.();
        request.current = null;
        dispatch({ type: 'invalidate' });
        retry();
      }),
    [subscribeSession],
  );
  useLayoutEffect(() => {
    if (appliedScopeKey.current === suppliedScopeKey) return;
    appliedScopeKey.current = suppliedScopeKey;
    dispatch({ type: 'sync-scope', scope });
  }, [suppliedScopeKey]);
  useLayoutEffect(() => {
    if (sameHeaderSuggestionOwner(committedOwner.current, owner)) return;
    committedOwner.current = owner;
    requestGeneration.current += 1;
    retireRetryEntry();
    resultsRetired.current = true;
    suggestionsOwner.current = null;
    resultOwner.current = null;
    request.current?.();
    request.current = null;
    dispatch({ type: 'invalidate' });
  }, [owner.sessionKey, owner.locale, owner.query, owner.scopeKey, owner.loader]);
  useLayoutEffect(() => {
    requestGeneration.current += 1;
    retireRetryEntry();
    resultsRetired.current = true;
    suggestionsOwner.current = null;
    resultOwner.current = null;
    request.current?.();
    request.current = null;
    dispatch({ type: 'invalidate' });
    observeSession(sessionKey);
  }, [sessionKey]);
  useLayoutEffect(() => retireRetryEntry, []);
  useEffect(() => {
    dispatch({ type: 'sync-query', query: initialQuery });
  }, [initialQuery]);
  useEffect(() => {
    if (!sessionIsCurrent()) return;
    if (!requestState.expanded || !requestState.query.trim() || composing) return;
    if (!validSuggestionText(requestState.query)) {
      suggestionsOwner.current = owner;
      resultOwner.current = null;
      resultsRetired.current = false;
      dispatch({ type: 'suggestions', state: 'invalid' });
      return;
    }
    if (!loader || !headerSearchAction(locale, requestScope)) {
      suggestionsOwner.current = owner;
      resultOwner.current = null;
      resultsRetired.current = false;
      dispatch({ type: 'suggestions', state: 'unavailable' });
      return;
    }
    suggestionsOwner.current = owner;
    resultOwner.current = null;
    resultsRetired.current = true;
    dispatch({ type: 'suggestions', state: 'loading' });
    const generation = ++requestGeneration.current;
    const requestIsCurrent = () =>
      generation === requestGeneration.current &&
      sameHeaderSuggestionOwner(renderedOwner.current, owner) &&
      sessionIsCurrent();
    const cancel = startTypeahead(
      loader,
      requestState.query,
      locale,
      requestScope,
      (result) => {
        if (requestIsCurrent()) {
          suggestionsOwner.current = owner;
          resultOwner.current = owner;
          resultsRetired.current = false;
          dispatch({ type: 'suggestions', state: result.subjects.length ? 'ready' : 'empty', result });
        }
      },
      (failure, retryAt) => {
        if (requestIsCurrent()) {
          suggestionsOwner.current = owner;
          resultOwner.current = null;
          resultsRetired.current = false;
          dispatch({ type: 'suggestions', state: failure, retryAt });
        }
      },
    );
    request.current = cancel;
    return cancel;
  }, [
    requestState.query,
    requestScopeKey,
    requestState.expanded,
    locale,
    composing,
    attempt,
    loader,
    sessionKey,
    sessionMatches,
    readSession,
  ]);
  const close = (reason: 'escape' | 'outside', restore = false) => {
    request.current?.();
    dispatch({ type: reason });
    // A new opening reads current native data; no result survives dismissal or account navigation.
    dispatch({ type: 'invalidate' });
    pendingFocus.current = restore ? 'return' : null;
    pendingRetryEntry.current = false;
    if (!restore) priorFocus.current = null;
  };
  const open = () => {
    if (!state.expanded) {
      const active = input.current?.ownerDocument.activeElement;
      priorFocus.current = active instanceof HTMLElement ? active : null;
      pendingFocus.current = 'input';
    } else input.current?.focus();
    dispatch({
      type: presentation === 'sheet' || window.matchMedia(compactSearch).matches ? 'open-phone' : 'focus',
    });
    if (state.query.trim() && state.suggestions === 'idle') dispatch({ type: 'query', query: state.query });
  };
  // Focus only after the responsive input/trigger visibility has committed, including Escape restoration.
  useLayoutEffect(() => {
    const pending = pendingFocus.current;
    if (!pending) return;
    pendingFocus.current = null;
    returningFocus.current = true;
    if (pending === 'input') input.current?.focus();
    else {
      const prior = priorFocus.current;
      const fallback =
        window.matchMedia(compactSearch).matches || presentation === 'sheet' ? trigger.current : input.current;
      const target =
        prior?.isConnected &&
        prior !== prior.ownerDocument.body &&
        prior.getClientRects().length &&
        !prior.closest('[inert],[aria-hidden="true"]')
          ? prior
          : fallback;
      target?.focus({ preventScroll: true });
      if (target?.ownerDocument.activeElement !== target) fallback?.focus({ preventScroll: true });
      priorFocus.current = null;
    }
    returningFocus.current = false;
  }, [state.expanded, state.phoneSheet, presentation]);
  useLayoutEffect(() => {
    if (!pendingRetryEntry.current) return;
    if (!visibleState.expanded) {
      pendingRetryEntry.current = false;
      return;
    }
    if (retryableSuggestions.includes(visibleState.suggestions)) return;
    pendingRetryEntry.current = false;
    const document = input.current?.ownerDocument;
    const active = document?.activeElement;
    if (
      !input.current ||
      !document ||
      (active && active !== document.body && active !== document.documentElement && form.current?.contains(active))
    )
      return;
    input.current.focus();
  }, [visibleState.suggestions, visibleState.expanded, visibleState.phoneSheet]);
  useEffect(() => {
    if (!keyboardShortcut) return;
    const document = input.current?.ownerDocument;
    if (!document) return;
    const shortcut = (event: KeyboardEvent) => {
      const field = input.current;
      const entry = state.expanded || !window.matchMedia(compactSearch).matches ? field : trigger.current;
      if (composing || !field || !entry || !canEnterHeaderSearch(event, field, entry)) return;
      event.preventDefault();
      open();
    };
    document.addEventListener('keydown', shortcut);
    return () => document.removeEventListener('keydown', shortcut);
  }, [keyboardShortcut, composing, state.expanded, state.query, state.suggestions, presentation]);
  useEffect(() => {
    if (!state.expanded) return;
    const outside = (event: PointerEvent) => {
      if (!form.current?.contains(event.target as Node)) close('outside');
    };
    document.addEventListener('pointerdown', outside);
    return () => document.removeEventListener('pointerdown', outside);
  }, [state.expanded]);
  useEffect(() => {
    if (!state.expanded || presentation === 'sheet') return;
    const compact = window.matchMedia(compactSearch);
    const sync = () => dispatch({ type: compact.matches ? 'open-phone' : 'focus' });
    compact.addEventListener('change', sync);
    return () => compact.removeEventListener('change', sync);
  }, [state.expanded, presentation]);
  useEffect(() => {
    if (!state.phoneSheet) return;
    const previous = document.body.style.overflow;
    document.body.style.overflow = 'hidden';
    const viewport = window.visualViewport;
    const panel = form.current;
    // Mobile keyboards can shrink the visual viewport without changing dvh.
    const fit = () => {
      if (!viewport || !panel) return;
      panel.style.height = `${viewport.height}px`;
      panel.style.top = `${viewport.offsetTop}px`;
    };
    fit();
    viewport?.addEventListener('resize', fit);
    viewport?.addEventListener('scroll', fit);
    return () => {
      document.body.style.overflow = previous;
      viewport?.removeEventListener('resize', fit);
      viewport?.removeEventListener('scroll', fit);
      panel?.style.removeProperty('height');
      panel?.style.removeProperty('top');
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
  const searchLanguages = (scope?: SearchScope) => {
    const action = headerSearchAction(locale, scope);
    const context = scope
      ? [...(action ? new URL(action, 'https://rezics.invalid').searchParams : [])]
      : (fields ?? []);
    const selected = context.flatMap(([key, value]) => (key === 'language' ? [value] : []));
    return selected.length ? selected : undefined;
  };
  const submitQuery = (query: string, scope: SearchScope | undefined, resumed?: RecentEntry) => {
    const action = headerSearchAction(locale, scope);
    if (!action || (!query.trim() && !scope)) return;
    if (!scope && !isWithinGlobalSearchQueryLimit(query)) {
      setQueryLimitError(true);
      return;
    }
    setQueryLimitError(false);
    history?.remember(query, scope, resumed ? resumed.languages : searchLanguages(scope));
    const url = new URL(action, window.location.origin);
    url.searchParams.delete('q');
    url.searchParams.delete('cursor');
    // Follow the same native GET context as the mounted form. Native routes revalidate remembered scopes.
    if (!scope)
      for (const [key, value] of fields ?? []) if (!resumed || key !== 'language') url.searchParams.append(key, value);
    if (resumed) applyRecentSearch(url.searchParams, query, resumed.languages);
    else if (query.trim()) url.searchParams.set('q', query);
    visit(`${url.pathname}${url.search}`);
  };
  return (
    <HeaderSearchView
      id={id}
      keyboardShortcut={keyboardShortcut}
      history={history}
      discovery={discovery}
      loadRealmDiscovery={loadRealmDiscovery}
      onQuery={(query) => submitQuery(query, undefined)}
      onRecent={(entry) => {
        dispatch({ type: 'sync-scope', scope: entry.scope });
        dispatch({ type: 'query', query: entry.query });
        if (headerSearchAction(locale, entry.scope)) submitQuery(entry.query, entry.scope, entry);
        else input.current?.focus();
      }}
      state={visibleState}
      canSelectSuggestion={canSelectSuggestion}
      locale={locale}
      queryLimitError={queryLimitError}
      fields={fields}
      region={requestState.scope ? null : region}
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
        if (!canSelectSuggestion()) return;
        if (requestState.scope || isWithinGlobalSearchQueryLimit(requestState.query))
          history?.remember(requestState.query, requestState.scope, searchLanguages(requestState.scope));
        visit(href);
      }}
      onActive={(index) => {
        if (canSelectSuggestion()) dispatch({ type: 'active', index });
      }}
      onRetry={requestRetry}
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
          const query = event.currentTarget.value;
          dispatch({ type: 'query', query });
          if (requestState.scope || isWithinGlobalSearchQueryLimit(query)) setQueryLimitError(false);
        },
        onCompositionStart: () => {
          request.current?.();
          dispatch({ type: 'invalidate' });
          setComposing(true);
        },
        onCompositionEnd: (event) => {
          const query = event.currentTarget.value;
          dispatch({ type: 'query', query });
          if (requestState.scope || isWithinGlobalSearchQueryLimit(query)) setQueryLimitError(false);
          setComposing(false);
        },
        onKeyDown: (event) => {
          if (event.defaultPrevented || composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            return;
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && !state.expanded) {
            event.preventDefault();
            open();
            return;
          }
          if (removesHeaderScope(event.key, requestState.query, requestState.scope)) {
            request.current?.();
            event.preventDefault();
            dispatch({ type: 'remove-scope' });
          }
          const subjects = canSelectSuggestion() ? (visibleState.result?.subjects ?? []) : [];
          const next = nextSuggestion(event.key, visibleState.activeIndex, subjects.length);
          if (next !== undefined && state.expanded) {
            event.preventDefault();
            dispatch({ type: 'active', index: next });
            document.getElementById(`${id}-option-${next}`)?.scrollIntoView({ block: 'nearest' });
          }
          if (
            event.key === 'Enter' &&
            state.expanded &&
            visibleState.activeIndex >= 0 &&
            subjects[visibleState.activeIndex]
          ) {
            event.preventDefault();
            const hit = subjects[visibleState.activeIndex]!;
            if (requestState.scope || isWithinGlobalSearchQueryLimit(requestState.query))
              history?.remember(requestState.query, requestState.scope, searchLanguages(requestState.scope));
            visit(subjectHref({ id: hit.id, label: localizedLabel(hit.labels, locale).text }, locale).href);
          }
        },
      }}
      formProps={{
        onSubmit: (event) => {
          const action = headerSearchAction(locale, requestState.scope);
          if (composing || !action || !requestState.query.trim()) {
            event.preventDefault();
            return;
          }
          if (!requestState.scope && !isWithinGlobalSearchQueryLimit(requestState.query)) {
            event.preventDefault();
            setQueryLimitError(true);
            return;
          }
          setQueryLimitError(false);
          history?.remember(requestState.query, requestState.scope, searchLanguages(requestState.scope));
          if (!onNavigate) return;
          event.preventDefault();
          const url = new URL(action, window.location.origin);
          url.search = new URLSearchParams(new FormData(event.currentTarget) as never).toString();
          url.searchParams.set('q', requestState.query);
          visit(`${url.pathname}${url.search}`);
        },
        onBlur: (event) => {
          if (!state.phoneSheet && !event.currentTarget.contains(event.relatedTarget as Node | null)) close('outside');
        },
        onKeyDown: (event) => {
          if (event.defaultPrevented || composing || event.nativeEvent.isComposing || event.nativeEvent.keyCode === 229)
            return;
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

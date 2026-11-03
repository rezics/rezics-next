import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { FeedResults, type FeedResultsResult } from '../feed/feed-results';
import { homeFeedRecoveryMessages, type FeedEmptyContext } from '../feed/feed-empty-state';
import { homeFeedItemPresentation } from '../feed/home-feed-item';
import { HomeFeedActions } from '../feed/action-bar';
import type { VerificationConfig } from '../../report/turnstile';
import { createHomeKindChoices, homeKindChoice, type HomeKindsReader } from './home-feed-kinds';
import { createHomeSpaceSelection, type HomeSpaceReader } from './home-feed-spaces';
import { HomeFeedSpaceControl } from './home-feed-space-control';
import { HomeFeedKindControl } from './home-feed-kind-control';
import { HomeFeedQuestionControl } from './home-feed-question-control';
import { HomeFeedControls } from './home-feed-controls';
import type { HomeFeedFilterSummary } from './home-feed-filter-summary';
import {
  createHomeQuestionChoices,
  questionFeedFailure,
  type HomeQuestionsReader,
  type HomeQuestionReader,
} from './home-feed-questions';
import type { ReactNode } from 'react';
import {
  createHomeFeedWindow,
  HOME_FEED_HISTORY_CURSOR_LIMIT,
  homeFeedHistoryState,
  homeFeedNavigationDescriptor,
  readHomeFeedNavigationDescriptor,
  type FeedInput,
  type FeedItem,
  type FeedStream,
  type HomeFeedResult,
} from './home-feed-read';

function requestIdentity({ stream, cursor, kind, spaceId, ratingQuestionId }: FeedInput) {
  return JSON.stringify([stream, cursor ?? null, kind ?? null, spaceId ?? null, ratingQuestionId ?? null]);
}

function selectionIdentity({ stream, kind, spaceId, ratingQuestionId }: FeedInput) {
  return JSON.stringify([stream, kind ?? null, spaceId ?? null, ratingQuestionId ?? null]);
}

export function HomeFeed({
  result,
  locale,
  stream = 'home',
  signedIn = false,
  busy = false,
  input,
  onSelect,
  activeFilters = [],
  filterSelections = [],
  onClearFilters,
  kindControl,
  spaceControl,
  questionControl,
  catalogue,
  verification,
  suppressResultMessage = false,
  onRetry,
  onNext,
  onRestart,
}: {
  result: HomeFeedResult;
  locale: string;
  stream?: FeedStream;
  signedIn?: boolean;
  busy?: boolean;
  /** Current native request: a replacement selection or refresh cancels pagination focus. */
  input?: FeedInput;
  onSelect?: (stream: FeedStream) => void;
  activeFilters?: ReactNode[];
  filterSelections?: readonly HomeFeedFilterSummary[];
  onClearFilters?: (() => void) | undefined;
  kindControl?: ReactNode;
  spaceControl?: ReactNode;
  questionControl?: ReactNode;
  /** Native route TypeLists; the feed and Search retain their own adapters. */
  catalogue?: ReactNode;
  verification?: VerificationConfig | undefined;
  /** The selected metadata control already explains and recovers its own blocked selection. */
  suppressResultMessage?: boolean;
  onRetry?: () => void;
  onNext?: (cursor: string) => void;
  onRestart?: () => void;
}) {
  const options = { locale: locale as Locale };
  const filterId = useId();
  const boundary = useRef<HTMLElement>(null);
  const advancing = useRef<{ request: string | null } | null>(null);
  const requestKey = input ? requestIdentity(input) : null;
  useEffect(() => {
    if (!advancing.current) return;
    if (requestKey !== null && advancing.current.request !== requestKey) {
      advancing.current = null;
      return;
    }
    if (busy) return;
    advancing.current = null;
    boundary.current?.focus({ preventScroll: true });
    boundary.current?.scrollIntoView?.({ block: 'start' });
  }, [busy, result, requestKey]);
  const [filtersOpen, setFiltersOpen] = useState(false);
  const filterPanel = useRef<HTMLDivElement>(null);
  const focusFilters = useRef(false);
  const focusFirstFilter = () =>
    filterPanel.current
      ?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled)')
      ?.focus();
  useEffect(() => {
    if (!filtersOpen || !focusFilters.current) return;
    focusFilters.current = false;
    focusFirstFilter();
  }, [filtersOpen]);
  const page = result.state === 'ready' ? result.page : undefined;
  const [actionSource, setActionSource] = useState({ result, key: 0 });
  if (actionSource.result !== result) setActionSource({ result, key: actionSource.key + 1 });
  const currentActionResult = useRef(result);
  currentActionResult.current = result;
  const hasPreparing = page ? Object.values(page.sources).includes('preparing') : false;
  const hasUnavailable = page ? Object.values(page.sources).includes('unavailable') : false;
  const results: FeedResultsResult<FeedItem> =
    result.state === 'ready'
      ? {
          state: 'ready',
          items: result.page.feedItems,
          hasNext: result.page.next !== null,
          availability: {
            state: hasPreparing || hasUnavailable ? 'partial' : 'complete',
            sources: result.page.sources,
          },
        }
      : result.state === 'loading'
        ? { state: 'loading', code: result.code }
        : { state: result.state, code: result.code };
  const emptyContext: FeedEmptyContext = input?.cursor
    ? 'continuation'
    : filterSelections.length || activeFilters.length || input?.kind || input?.spaceId || input?.ratingQuestionId
      ? 'filtered'
      : stream === 'following'
        ? 'following'
        : 'discovery';
  const resultMessages = homeFeedRecoveryMessages(locale, emptyContext);
  return (
    <main
      className="mx-auto w-full max-w-3xl space-y-4 text-foreground"
      aria-busy={busy}
      data-feed-source-state={
        page
          ? Object.entries(page.sources)
              .filter(([, state]) => state !== 'not_requested')
              .map(([source, state]) => `${source}:${state}`)
              .join(' ')
          : undefined
      }
    >
      <h1 className="sr-only">{m.nav_home({}, options)}</h1>
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <nav aria-label={m.nav_home({}, options)} className="flex flex-wrap items-center gap-2">
          <Button
            className="min-h-11"
            variant={stream === 'home' ? 'secondary' : 'ghost'}
            aria-pressed={stream === 'home'}
            disabled={busy}
            onClick={() => onSelect?.('home')}
          >
            {m.nav_home({}, options)}
          </Button>
          {signedIn ? (
            <Button
              className="min-h-11"
              variant={stream === 'following' ? 'secondary' : 'ghost'}
              aria-pressed={stream === 'following'}
              disabled={busy}
              onClick={() => onSelect?.('following')}
            >
              {m.home_feed_following({}, options)}
            </Button>
          ) : null}
        </nav>
        <HomeFeedControls
          locale={locale}
          stream={stream}
          open={filtersOpen}
          onOpenChange={setFiltersOpen}
          id={filterId}
          panelRef={filterPanel}
          selections={filterSelections}
          onClear={onClearFilters}
          legacySummary={activeFilters}
        >
          {kindControl}
          {spaceControl}
          {questionControl}
        </HomeFeedControls>
      </div>
      {catalogue}
      {stream === 'home' ? (
        <p role="note" className="text-sm text-muted-foreground">
          {m.home_feed_public_discovery_unavailable({}, options)}
        </p>
      ) : null}
      <FeedResults
        boundaryRef={boundary}
        regionLabel={m.nav_home({}, options)}
        itemHeadingLevel={2}
        listAs="ol"
        result={results}
        busy={busy}
        messages={resultMessages}
        emptyContext={emptyContext}
        failureActions={{
          auth: (
            <a
              href={`/${locale}/auth/sign-in?return_to=${encodeURIComponent(`/${locale}/`)}`}
              className="inline-flex min-h-11 items-center justify-center rounded-lg bg-primary px-4 py-2 text-sm font-medium text-primary-foreground hover:opacity-90 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.account_sign_in({}, options)}
            </a>
          ),
        }}
        getItemKey={(item) => item.id}
        itemPresentation={(item) => {
          const presentation = homeFeedItemPresentation(item, locale);
          return {
            ...presentation,
            actions: (
              <HomeFeedActions
                key={item.id}
                item={item}
                locale={locale}
                signedIn={signedIn}
                verification={verification}
                origin={{ key: String(actionSource.key), isCurrent: () => currentActionResult.current === result }}
              >
                {presentation.actions}
              </HomeFeedActions>
            ),
          };
        }}
        onRetry={onRetry}
        onRestart={onRestart}
        suppressResultMessage={suppressResultMessage}
        nextControl={
          page?.next && onNext ? (
            <Button
              variant="outline"
              className="min-h-11"
              disabled={busy || !page.next}
              onClick={() => {
                if (busy || advancing.current || !page.next) return;
                advancing.current = { request: input ? requestIdentity({ ...input, cursor: page.next }) : null };
                onNext(page.next);
              }}
            >
              {busy && advancing.current ? m.home_feed_loading({}, options) : m.library_next_page({}, options)}
            </Button>
          ) : undefined
        }
        emptyActions={
          <>
            {emptyContext === 'continuation' && !page?.next && onRestart ? (
              <Button className="min-h-11" variant="outline" disabled={busy} onClick={onRestart}>
                {m.home_feed_restart({}, options)}
              </Button>
            ) : null}
            {emptyContext === 'filtered' ? (
              <Button
                className="min-h-11"
                variant="outline"
                aria-controls={filterId}
                aria-expanded={filtersOpen}
                onClick={() => {
                  if (filtersOpen) focusFirstFilter();
                  else {
                    focusFilters.current = true;
                    setFiltersOpen(true);
                  }
                }}
              >
                {m.search_filters({}, options)}
              </Button>
            ) : null}
            <a
              href={`/${locale}/search`}
              className="inline-flex min-h-11 items-center justify-center rounded-lg px-4 py-2 text-sm text-primary underline underline-offset-4 hover:bg-muted focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
            >
              {m.search_heading({}, options)}
            </a>
            {stream === 'following' && onSelect ? (
              <Button className="min-h-11" variant="outline" disabled={busy} onClick={() => onSelect('home')}>
                {m.home_feed_discovery({}, options)}
              </Button>
            ) : null}
          </>
        }
      />
    </main>
  );
}

/** Route and stories both mount this bounded default consumer. Viewer changes remount it synchronously. */
export function HomeFeedConsumer({
  initial,
  locale,
  signedIn,
  read,
  readKinds,
  readSpace,
  readQuestions,
  readQuestion,
  origin,
  catalogue,
  verification,
}: {
  initial: HomeFeedResult;
  locale: string;
  signedIn: boolean;
  read: (input: FeedInput, signal: AbortSignal) => Promise<HomeFeedResult>;
  readKinds: HomeKindsReader;
  readSpace: HomeSpaceReader;
  readQuestions: HomeQuestionsReader;
  readQuestion: HomeQuestionReader;
  origin: string;
  catalogue?: ReactNode;
  verification?: VerificationConfig | undefined;
}) {
  const window = useState(() => createHomeFeedWindow(initial, read))[0];
  const choices = useState(() => createHomeKindChoices(readKinds))[0];
  const restoreGeneration = useRef(0);
  const clearingSelections = useRef(false);
  const saveNavigation = (input: FeedInput, mode: 'push' | 'replace') => {
    if (typeof globalThis.window === 'undefined') return;
    const browser = globalThis.window;
    const descriptor = homeFeedNavigationDescriptor(input, browser.location, locale);
    const state = homeFeedHistoryState(browser.history.state, descriptor);
    if (mode === 'push') browser.history.pushState(state, '', browser.location.href);
    else browser.history.replaceState(state, '', browser.location.href);
  };
  // Store callbacks run after construction, when both independent selection stores exist.
  const questions = useState(() =>
    createHomeQuestionChoices(readQuestions, readQuestion, (question, result) => {
      if (clearingSelections.current) return;
      if (result === undefined) {
        restoreGeneration.current++;
        const { cursor: _cursor, ratingQuestionId: _question, ...selection } = window.snapshot().input;
        saveNavigation({ ...selection, ...(question ? { ratingQuestionId: question.id } : {}) }, 'push');
      }
      choices.retire();
      spaces.retire();
      const { cursor: _cursor, ratingQuestionId: _question, ...selection } = window.snapshot().input;
      const input = { ...selection, ...(question ? { ratingQuestionId: question.id } : {}) };
      window.retire(result && result.status !== 'ready' ? questionFeedFailure(result) : undefined, input);
      if ((!question || result?.status === 'ready') && !loadRefusal(input)) void window.load(input);
    }),
  )[0];
  const spaces = useState(() =>
    createHomeSpaceSelection(readSpace, (space, available) => {
      if (clearingSelections.current) return;
      restoreGeneration.current++;
      choices.retire();
      questions.retire();
      const { cursor: _cursor, spaceId: _space, ...selection } = window.snapshot().input;
      const input = { ...selection, ...(space ? { spaceId: space.spaceId } : {}) };
      const current =
        typeof globalThis.window === 'undefined'
          ? undefined
          : readHomeFeedNavigationDescriptor(globalThis.window.history.state, globalThis.window.location, locale)
              ?.input;
      saveNavigation(input, current && selectionIdentity(current) === selectionIdentity(input) ? 'replace' : 'push');
      window.retire(available ? undefined : { state: 'unavailable', code: 'space_unavailable' }, input);
      if (available && !loadRefusal(input)) void window.load(input);
    }),
  )[0];
  // These stores retain metadata only. Every feed request still goes through the single window.
  function loadRefusal(input: FeedInput): boolean {
    if (!spaces.snapshot().available) {
      window.retire({ state: 'unavailable', code: 'space_unavailable' }, input);
      return true;
    }
    const question = questions.snapshot();
    if (
      input.ratingQuestionId &&
      (question.selection !== 'ready' || question.selected?.id !== input.ratingQuestionId)
    ) {
      window.retire(
        question.selection === 'loading'
          ? undefined
          : questionFeedFailure(question.failure ?? { status: 'unavailable', code: 'question_unavailable' }),
        input,
      );
      return true;
    }
    return false;
  }
  const loadSelection = (input: FeedInput, historyMode: 'push' | 'replace' = 'push') => {
    restoreGeneration.current++;
    saveNavigation(input, historyMode);
    choices.retire();
    spaces.retire();
    questions.retire();
    window.retire(undefined, input);
    if (!loadRefusal(input)) void window.load(input);
  };
  const retry = () => {
    if (!spaces.snapshot().available) {
      if (spaces.snapshot().selected) void spaces.refresh();
      else void spaces.retry();
    } else if (
      window.snapshot().input.ratingQuestionId &&
      (questions.snapshot().selection !== 'ready' ||
        questions.snapshot().selected?.id !== window.snapshot().input.ratingQuestionId)
    ) {
      if (questions.snapshot().selected?.id === window.snapshot().input.ratingQuestionId) void questions.refresh();
      else void restoreSelection(window.snapshot().input);
    } else void window.load(window.snapshot().input);
  };
  const questionSnapshot = useSyncExternalStore(questions.subscribe, questions.snapshot, questions.snapshot);
  const spaceSnapshot = useSyncExternalStore(spaces.subscribe, spaces.snapshot, spaces.snapshot);
  const kinds = useSyncExternalStore(choices.subscribe, choices.snapshot, choices.snapshot);
  const snapshot = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  useEffect(
    () => () => {
      choices.retire();
      spaces.retire();
      questions.retire();
    },
    [choices, spaces, questions],
  );
  const options = { locale: locale as Locale };
  const removeKind = () => {
    choices.select(undefined);
    const { cursor: _cursor, kind: _kind, ...selection } = window.snapshot().input;
    loadSelection(selection);
  };
  const clearFilters = () => {
    // Store callbacks normally own independent selection changes. A bulk clear retires all
    // three synchronously, then passes one replacement through the same feed owner.
    const stream = window.snapshot().input.stream;
    restoreGeneration.current++;
    clearingSelections.current = true;
    try {
      choices.select(undefined);
      spaces.clear();
      void questions.select(undefined);
    } finally {
      clearingSelections.current = false;
    }
    loadSelection({ stream });
  };
  const filterSelections: HomeFeedFilterSummary[] = [];
  const suppliedKind = kinds.kinds?.values.find((kind) => kind.id === snapshot.input.kind);
  const selectedKind = suppliedKind ? homeKindChoice(suppliedKind, locale) : kinds.selected;
  if (snapshot.input.kind) {
    filterSelections.push({
      key: 'kind',
      label: m.home_kind_label({}, options),
      value: selectedKind?.text || m.home_kind_unnamed({}, options),
      lang: selectedKind?.lang,
      onRemove: removeKind,
    });
  }
  if (snapshot.input.spaceId) {
    const selected = spaceSnapshot.selected;
    filterSelections.push({
      key: 'space',
      label: m.home_space_selected({}, options),
      value: selected?.title ?? m.home_filter_metadata_unavailable({}, options),
      description: selected?.address ? `/spaces/${selected.address}` : undefined,
      state:
        spaceSnapshot.status === 'loading'
          ? m.home_space_loading({}, options)
          : !spaceSnapshot.available
            ? spaceSnapshot.status === 'denied'
              ? m.home_feed_denied({}, options)
              : spaceSnapshot.status === 'auth'
                ? m.home_feed_auth({}, options)
                : spaceSnapshot.status === 'closed'
                  ? m.home_feed_closed({}, options)
                  : m.home_space_unavailable({}, options)
            : undefined,
      onRemove: spaces.clear,
    });
  }
  if (snapshot.input.ratingQuestionId) {
    const selected = questionSnapshot.selected;
    const grains = {
      work: m.home_question_work,
      release: m.home_question_release,
      episode: m.home_question_episode,
      character: m.home_question_character,
    };
    const states = {
      loading: m.home_questions_loading,
      unavailable: m.home_questions_unavailable,
      auth: m.home_feed_auth,
      denied: m.home_questions_denied,
      closed: m.home_feed_closed,
      restart: m.home_questions_restart,
      invalid: m.home_questions_invalid,
      lost: m.home_questions_lost,
    };
    const number = new Intl.NumberFormat(locale);
    filterSelections.push({
      key: 'question',
      label: m.home_question_label({}, options),
      value: selected?.label ?? m.home_filter_metadata_unavailable({}, options),
      description: selected
        ? `${m.home_question_help({}, options)} ${m.home_question_metadata(
            {
              label: selected.label,
              revision: number.format(selected.revision),
              grain: grains[selected.grain]({}, options),
              min: number.format(selected.scale.min),
              max: number.format(selected.scale.max),
              step: number.format(selected.scale.displayStep),
            },
            options,
          )}`
        : m.home_question_help({}, options),
      state:
        questionSnapshot.selection !== 'none' && questionSnapshot.selection !== 'ready'
          ? states[questionSnapshot.selection]({}, options)
          : undefined,
      onRemove: () => void questions.select(undefined),
    });
  }
  const currentResult = snapshot.result;
  const spaceOwnsResultMessage =
    Boolean(spaceSnapshot.selected) &&
    !spaceSnapshot.available &&
    currentResult.state === 'unavailable' &&
    currentResult.code === 'space_unavailable';
  const questionFailure = questionSnapshot.failure ? questionFeedFailure(questionSnapshot.failure) : undefined;
  const questionOwnsResultMessage =
    Boolean(questionSnapshot.selected) &&
    ((questionSnapshot.selection === 'loading' && currentResult.state === 'loading') ||
      (questionFailure !== undefined &&
        currentResult.state !== 'ready' &&
        currentResult.state !== 'loading' &&
        currentResult.state === questionFailure.state &&
        currentResult.code === questionFailure.code));
  const filterOwnsResultMessage = spaceOwnsResultMessage || questionOwnsResultMessage;
  const restoreSelection = async (input: FeedInput, frontierUnavailable = false) => {
    const current = ++restoreGeneration.current;
    choices.retire();
    spaces.retire();
    questions.retire();
    window.retire({ state: 'loading', code: 'loading' }, input);
    choices.select(input.kind ? { id: input.kind, text: '' } : undefined);
    // Retire the previous question meaning before a Space refusal can stop restoration.
    void questions.restore(undefined);
    const space = await spaces.restore(input.spaceId);
    if (current !== restoreGeneration.current) return;
    if (input.spaceId && space === undefined) return;
    if (input.spaceId && space?.status !== 'ready') {
      window.retire({ state: 'unavailable', code: 'space_unavailable' }, input);
      return;
    }
    const question = await questions.restore(input.ratingQuestionId);
    if (current !== restoreGeneration.current) return;
    if (input.ratingQuestionId && question?.status !== 'ready') {
      window.retire(
        question ? questionFeedFailure(question) : { state: 'unavailable', code: 'question_unavailable' },
        input,
      );
      return;
    }
    if (frontierUnavailable) {
      window.retire({ state: 'cursor', code: 'frontier_unavailable' }, input);
      return;
    }
    void window.load(input);
  };
  const restoreFromHistory = (force: boolean) => {
    if (typeof globalThis.window === 'undefined') return;
    const browser = globalThis.window;
    const descriptor = readHomeFeedNavigationDescriptor(browser.history.state, browser.location, locale);
    const input =
      descriptor?.input && (signedIn || descriptor.input.stream !== 'following')
        ? descriptor.input
        : { stream: 'home' as const };
    if (!descriptor || (!signedIn && descriptor.input.stream === 'following')) saveNavigation(input, 'replace');
    const current = window.snapshot();
    if (
      force &&
      (requestIdentity(current.input) === requestIdentity(input) ||
        (descriptor?.frontierUnavailable === true &&
          typeof current.input.cursor === 'string' &&
          current.input.cursor.length > HOME_FEED_HISTORY_CURSOR_LIMIT &&
          selectionIdentity(current.input) === selectionIdentity(input))) &&
      current.result.state === 'ready'
    )
      return;
    if (
      !force &&
      !signedIn &&
      !descriptor?.frontierUnavailable &&
      requestIdentity(current.input) === requestIdentity(input) &&
      current.result.state === 'ready'
    ) {
      void spaces.restore(input.spaceId);
      void questions.restore(input.ratingQuestionId);
      choices.select(input.kind ? { id: input.kind, text: '' } : undefined);
      return;
    }
    void restoreSelection(input, descriptor?.frontierUnavailable === true);
  };
  useEffect(() => {
    const popstate = () => restoreFromHistory(true);
    const pageshow = (event: PageTransitionEvent) => {
      if (event.persisted) restoreFromHistory(true);
    };
    globalThis.window.addEventListener('popstate', popstate);
    globalThis.window.addEventListener('pageshow', pageshow);
    restoreFromHistory(false);
    return () => {
      globalThis.window.removeEventListener('popstate', popstate);
      globalThis.window.removeEventListener('pageshow', pageshow);
      restoreGeneration.current++;
      choices.retire();
      spaces.retire();
      questions.retire();
      window.clear();
    };
  }, [window, signedIn, locale]);
  return (
    <HomeFeed
      result={snapshot.result}
      catalogue={catalogue}
      verification={verification}
      locale={locale}
      signedIn={signedIn}
      stream={snapshot.input.stream}
      busy={snapshot.busy}
      input={snapshot.input}
      filterSelections={filterSelections}
      onClearFilters={clearFilters}
      suppressResultMessage={filterOwnsResultMessage}
      spaceControl={
        <HomeFeedSpaceControl selection={spaces} snapshot={spaceSnapshot} locale={locale} origin={origin} />
      }
      questionControl={
        <HomeFeedQuestionControl
          choices={questions}
          snapshot={questionSnapshot}
          locale={locale}
          selectedId={snapshot.input.ratingQuestionId}
          onRestore={() => void restoreSelection(window.snapshot().input)}
        />
      }
      kindControl={
        <HomeFeedKindControl
          choices={choices}
          snapshot={kinds}
          locale={locale}
          onSelect={(choice) => {
            choices.select(choice);
            const { cursor: _cursor, kind: _kind, ...selection } = snapshot.input;
            loadSelection({ ...selection, ...(choice ? { kind: choice.id } : {}) });
          }}
        />
      }
      onSelect={(stream) => {
        const { cursor: _cursor, ...selection } = snapshot.input;
        loadSelection({ ...selection, stream });
      }}
      onRetry={retry}
      onRestart={() => {
        const { cursor: _cursor, ...selection } = snapshot.input;
        loadSelection(selection, 'replace');
      }}
      onNext={(cursor) => {
        const input = { ...snapshot.input, cursor };
        saveNavigation(input, 'push');
        if (!loadRefusal(snapshot.input)) void window.load(input);
      }}
    />
  );
}

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { FeedResults, type FeedResultsResult } from '../feed/feed-results';
import { homeFeedRecoveryMessages, type FeedEmptyContext } from '../feed/feed-empty-state';
import { homeFeedItemPresentation } from '../feed/home-feed-item';
import { HomeFeedActions } from '../feed/action-bar';
import type { VerificationConfig } from '../../report/turnstile';
import { createHomeKindChoices, type HomeKindsReader } from './home-feed-kinds';
import { createHomeSpaceSelection, type HomeSpaceReader } from './home-feed-spaces';
import { HomeFeedSpaceControl } from './home-feed-space-control';
import { HomeFeedKindControl } from './home-feed-kind-control';
import { HomeFeedQuestionControl } from './home-feed-question-control';
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
    filterPanel.current?.querySelector<HTMLElement>('button:not(:disabled), input:not(:disabled), a[href], select:not(:disabled)')?.focus();
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
  const emptyContext: FeedEmptyContext = input?.cursor ? 'continuation'
    : activeFilters.length || input?.kind || input?.spaceId || input?.ratingQuestionId ? 'filtered'
    : stream === 'following' ? 'following' : 'discovery';
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
        <div className="flex min-w-0 flex-1 flex-wrap items-center gap-x-2 gap-y-1">
          <Button
            className="min-h-11 whitespace-nowrap"
            type="button"
            variant="outline"
            aria-expanded={filtersOpen}
            aria-controls={filterId}
            onClick={() => setFiltersOpen((open) => !open)}
          >
            {filtersOpen ? m.search_close_filters({}, options) : m.search_filters({}, options)}
          </Button>
          {activeFilters.length ? (
            <ul
              aria-label={m.refinement_selected({}, options)}
              className="flex min-w-0 flex-wrap gap-x-2 gap-y-1 text-sm text-muted-foreground"
            >
              {activeFilters.map((filter, index) => (
                <li key={index} className="break-words">
                  {filter}
                </li>
              ))}
            </ul>
          ) : null}
        </div>
      </div>
      <div ref={filterPanel} id={filterId} hidden={!filtersOpen} className={filtersOpen ? 'grid gap-3' : 'hidden'}>
        {kindControl}
        {spaceControl}
        {questionControl}
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
    if (question.selected && question.selection !== 'ready') {
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
    } else if (questions.snapshot().selected && questions.snapshot().selection !== 'ready') void questions.refresh();
    else void window.load(window.snapshot().input);
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
  const activeFilters: ReactNode[] = [];
  if (kinds.selected) {
    activeFilters.push(
      <span key="kind">
        {m.home_kind_label({}, options)}:{' '}
        <bdi lang={kinds.selected.lang}>{kinds.selected.text || m.home_kind_unnamed({}, options)}</bdi>
        <Button
          variant="ghost"
          className="min-h-11"
          aria-label={m.refinement_remove({ value: kinds.selected.text || m.home_kind_unnamed({}, options) }, options)}
          onClick={() => {
            choices.select(undefined);
            const { cursor: _cursor, kind: _kind, ...selection } = window.snapshot().input;
            loadSelection(selection);
          }}
        >
          ×
        </Button>
      </span>,
    );
  }
  if (spaceSnapshot.selected) {
    activeFilters.push(
      <span key="space">
        {m.home_space_label({}, options)}: {spaceSnapshot.selected.title}
        <Button
          variant="ghost"
          className="min-h-11"
          aria-label={m.refinement_remove({ value: spaceSnapshot.selected.title }, options)}
          onClick={spaces.clear}
        >
          ×
        </Button>
      </span>,
    );
  }
  if (questionSnapshot.selected) {
    activeFilters.push(
      <span key="question">
        {m.home_question_label({}, options)}: {questionSnapshot.selected.label}
        <Button
          variant="ghost"
          className="min-h-11"
          aria-label={m.refinement_remove({ value: questionSnapshot.selected.label }, options)}
          onClick={() => void questions.select(undefined)}
        >
          ×
        </Button>
      </span>,
    );
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
      activeFilters={activeFilters}
      suppressResultMessage={filterOwnsResultMessage}
      spaceControl={
        <HomeFeedSpaceControl selection={spaces} snapshot={spaceSnapshot} locale={locale} origin={origin} />
      }
      questionControl={<HomeFeedQuestionControl choices={questions} snapshot={questionSnapshot} locale={locale} />}
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

import { useEffect, useId, useRef, useState, useSyncExternalStore } from 'react';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { FeedResults, type FeedResultsResult } from '../feed/feed-results';
import { homeFeedItemPresentation } from '../feed/home-feed-item';
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
  type FeedInput,
  type FeedItem,
  type FeedStream,
  type HomeFeedResult,
} from './home-feed-read';

function requestIdentity({ stream, cursor, kind, spaceId, ratingQuestionId }: FeedInput) {
  return JSON.stringify([stream, cursor ?? null, kind ?? null, spaceId ?? null, ratingQuestionId ?? null]);
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
  const page = result.state === 'ready' ? result.page : undefined;
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
  const resultMessages = {
    loading: m.home_feed_loading({}, options),
    partial: m.home_presentation_partial({}, options),
    empty: stream === 'following' ? m.home_feed_following_empty({}, options) : m.home_feed_empty({}, options),
    sparse: m.home_feed_sparse({}, options),
    retry: m.library_follow_retry({}, options),
    restart: m.home_feed_restart({}, options),
    failure: {
      request: m.home_feed_request({}, options),
      auth: m.home_feed_auth({}, options),
      denied: m.home_feed_denied({}, options),
      closed: m.home_feed_closed({}, options),
      cursor: m.home_feed_cursor({}, options),
      deadline: m.home_feed_deadline({}, options),
      unavailable: m.home_feed_unavailable({}, options),
    },
  };
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
      <div id={filterId} hidden={!filtersOpen} className={filtersOpen ? 'grid gap-3' : 'hidden'}>
        {kindControl}
        {spaceControl}
        {questionControl}
      </div>
      <FeedResults
        boundaryRef={boundary}
        regionLabel={m.nav_home({}, options)}
        itemHeadingLevel={2}
        listAs="ol"
        result={results}
        busy={busy}
        messages={resultMessages}
        getItemKey={(item) => item.id}
        itemPresentation={(item) => homeFeedItemPresentation(item, locale)}
        onRetry={onRetry}
        onRestart={onRestart}
        suppressResultMessage={suppressResultMessage}
        nextControl={
          page?.next && onNext ? (
            <Button
              variant="outline"
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
            <a href={`/${locale}/search`} className="inline-block text-sm text-primary underline underline-offset-4">
              {m.search_heading({}, options)}
            </a>
            {stream === 'following' ? (
              <Button variant="outline" disabled={busy} onClick={() => onSelect?.('home')}>
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
}) {
  const window = useState(() => createHomeFeedWindow(initial, read))[0];
  const choices = useState(() => createHomeKindChoices(readKinds))[0];
  // Store callbacks run after construction, when both independent selection stores exist.
  const questions = useState(() =>
    createHomeQuestionChoices(readQuestions, readQuestion, (question, result) => {
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
      choices.retire();
      questions.retire();
      const { cursor: _cursor, spaceId: _space, ...selection } = window.snapshot().input;
      const input = { ...selection, ...(space ? { spaceId: space.spaceId } : {}) };
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
  const loadSelection = (input: FeedInput) => {
    choices.retire();
    spaces.retire();
    questions.retire();
    window.retire(undefined, input);
    if (!loadRefusal(input)) void window.load(input);
  };
  const retry = () => {
    if (!spaces.snapshot().available) void spaces.refresh();
    else if (questions.snapshot().selected && questions.snapshot().selection !== 'ready') void questions.refresh();
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
  useEffect(() => {
    if (signedIn) void window.load({ stream: 'home' });
    return window.clear;
  }, [window, signedIn]);
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
  return (
    <HomeFeed
      result={snapshot.result}
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
        loadSelection(selection);
      }}
      onNext={(cursor) => {
        if (!loadRefusal(snapshot.input)) void window.load({ ...snapshot.input, cursor });
      }}
    />
  );
}

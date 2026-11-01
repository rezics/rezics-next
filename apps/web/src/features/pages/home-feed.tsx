import { useEffect, useState, useSyncExternalStore } from 'react';
import { Cover } from '@rezics/ui/cover';
import { Button } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { continueProgress } from '../../library/continue-source';
import { progressView } from '../../library/progress-label';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { createHomeKindChoices, type HomeKindsReader } from './home-feed-kinds';
import { createHomeSpaceSelection, type HomeSpaceReader } from './home-feed-spaces';
import { HomeFeedSpaceControl } from './home-feed-space-control';
import { HomeFeedKindControl } from './home-feed-kind-control';
import type { ReactNode } from 'react';
import { PageHeading } from '../../shell/page-heading';
import { homeFeedDestination, homeFeedResume, homeFeedTitle } from './home-feed-destination';
import {
  createHomeFeedWindow,
  type FeedInput,
  type FeedItem,
  type FeedStream,
  type HomeFeedResult,
} from './home-feed-read';

function FeedRow({ item, locale }: { item: FeedItem; locale: string }) {
  const options = { locale: locale as Locale };
  const title = homeFeedTitle(item, locale);
  const href = homeFeedDestination(item, locale);
  const resume = homeFeedResume(item, locale);
  const summary = item.summary;
  const progress =
    item.source === 'continue' ? progressView(continueProgress(item.continue.activeProgressSession), locale) : null;
  const reason =
    item.source === 'continue'
      ? m.home_continue_heading({}, options)
      : item.source === 'following'
        ? m.home_feed_following({}, options)
        : m.home_feed_discovery({}, options);
  return (
    <li
      data-feed-id={item.id}
      data-feed-source={item.source}
      className="flex min-w-0 gap-4 border-b border-border py-5 sm:gap-6"
    >
      {'label' in summary ? (
        <div className="w-20 shrink-0 sm:w-24">
          <Cover
            subject={coverSubject(summary.id, title, summary)}
            cover={coverOf(summary)}
            size="fill"
            src={coverSrc}
            decorative
          />
        </div>
      ) : 'avatar' in summary ? (
        <div className="w-16 shrink-0">
          <Cover
            subject={{ id: summary.id, title, types: [] }}
            cover={summary.avatar ? { ...summary.avatar, variants: [...summary.avatar.variants] } : null}
            ratio="1:1"
            size="fill"
            src={coverSrc}
            decorative
          />
        </div>
      ) : null}
      <article className="min-w-0 flex-1 space-y-2">
        <p className="text-xs text-muted-foreground">{reason}</p>
        <h2 className="break-words text-lg leading-snug font-semibold">
          {href ? (
            <a
              href={href}
              className="hover:underline"
              {...('label' in summary && summary.label ? { lang: summary.label.language } : {})}
            >
              {title}
            </a>
          ) : (
            title
          )}
        </h2>
        {'description' in summary && summary.description ? (
          <p className="line-clamp-3 break-words text-sm text-muted-foreground">{summary.description}</p>
        ) : null}
        {progress ? <p className="text-sm">{progress.text}</p> : null}
        {resume ? (
          <a href={resume} className="inline-block text-sm text-primary underline underline-offset-4">
            {m.home_continue_label({ title }, options)}
          </a>
        ) : null}
      </article>
    </li>
  );
}

export function HomeFeed({
  result,
  locale,
  stream = 'home',
  signedIn = false,
  busy = false,
  onSelect,
  kindControl,
  spaceControl,
  onRetry,
  onNext,
  onRestart,
}: {
  result: HomeFeedResult;
  locale: string;
  stream?: FeedStream;
  signedIn?: boolean;
  busy?: boolean;
  onSelect?: (stream: FeedStream) => void;
  kindControl?: ReactNode;
  spaceControl?: ReactNode;
  onRetry?: () => void;
  onNext?: (cursor: string) => void;
  onRestart?: () => void;
}) {
  const options = { locale: locale as Locale };
  const page = result.state === 'ready' ? result.page : undefined;
  const messages = {
    loading: m.home_feed_loading,
    request: m.home_feed_request,
    auth: m.home_feed_auth,
    denied: m.home_feed_denied,
    closed: m.home_feed_closed,
    cursor: m.home_feed_cursor,
    deadline: m.home_feed_deadline,
    unavailable: m.home_feed_unavailable,
  };
  return (
    <main className="mx-auto w-full max-w-3xl space-y-5 text-foreground" aria-busy={busy}>
      <PageHeading>{m.home_heading({}, options)}</PageHeading>
      <nav aria-label={m.home_heading({}, options)} className="flex flex-wrap items-center gap-3">
        <Button
          variant={stream === 'home' ? 'secondary' : 'ghost'}
          aria-pressed={stream === 'home'}
          disabled={busy}
          onClick={() => onSelect?.('home')}
        >
          {m.home_heading({}, options)}
        </Button>
        {signedIn ? (
          <Button
            variant={stream === 'following' ? 'secondary' : 'ghost'}
            aria-pressed={stream === 'following'}
            disabled={busy}
            onClick={() => onSelect?.('following')}
          >
            {m.home_feed_following({}, options)}
          </Button>
        ) : null}
      </nav>
      {kindControl}
      {spaceControl}
      {signedIn ? (
        <p className="text-sm text-muted-foreground">
          {m.home_feed_horizon({}, options)}{' '}
          <a href={`/${locale}/library/following`} className="underline underline-offset-4">
            {m.home_feed_sources({}, options)}
          </a>
          {' · '}
          <a href={`/${locale}/library/continue`} className="underline underline-offset-4">
            {m.home_continue_heading({}, options)}
          </a>
        </p>
      ) : null}
      {busy ? (
        <p role="status" className="text-sm text-muted-foreground">
          {m.home_feed_loading({}, options)}
        </p>
      ) : null}
      {page ? (
        <>
          <ul
            className="flex list-none flex-wrap gap-x-4 gap-y-1 text-xs text-muted-foreground"
            aria-label={m.home_feed_sources({}, options)}
          >
            {(['discovery', 'following', 'continue'] as const).map((source) => {
              const state = page.sources[source];
              if (state === 'not_requested') return null;
              const label =
                source === 'discovery'
                  ? m.home_feed_discovery({}, options)
                  : source === 'following'
                    ? m.home_feed_following({}, options)
                    : m.home_continue_heading({}, options);
              const status =
                state === 'ready'
                  ? m.home_feed_ready({}, options)
                  : state === 'preparing'
                    ? m.home_feed_preparing({}, options)
                    : m.home_feed_unavailable({}, options);
              return (
                <li key={source} data-feed-source-state={`${source}:${state}`}>
                  {label}: {status}
                </li>
              );
            })}
          </ul>
          <ol className="list-none" aria-label={m.home_heading({}, options)}>
            {page.feedItems.map((item) => (
              <FeedRow key={item.id} item={item} locale={locale} />
            ))}
          </ol>
          {!page.feedItems.length &&
          Object.values(page.sources).every((state) => state === 'ready' || state === 'not_requested') ? (
            <p role="status">
              {page.next
                ? m.home_feed_sparse({}, options)
                : stream === 'following'
                  ? m.home_feed_following_empty({}, options)
                  : m.home_feed_empty({}, options)}
            </p>
          ) : null}
          {!page.feedItems.length ? (
            <a href={`/${locale}/search`} className="inline-block text-sm text-primary underline underline-offset-4">
              {m.search_heading({}, options)}
            </a>
          ) : null}
          {Object.values(page.sources).some((state) => state === 'preparing' || state === 'unavailable') && onRetry ? (
            <Button variant="outline" disabled={busy} onClick={onRetry}>
              {m.library_follow_retry({}, options)}
            </Button>
          ) : null}
          {onNext ? (
            <Button
              variant="outline"
              disabled={busy || !page.next}
              onClick={() => {
                if (page.next) onNext(page.next);
              }}
            >
              {m.library_next_page({}, options)}
            </Button>
          ) : null}
          {stream === 'following' && !page.feedItems.length ? (
            <Button variant="outline" disabled={busy} onClick={() => onSelect?.('home')}>
              {m.home_feed_discovery({}, options)}
            </Button>
          ) : null}
        </>
      ) : (
        <div
          role={result.state === 'loading' ? 'status' : 'alert'}
          className="space-y-3 rounded-lg border border-border p-5"
        >
          <p>{messages[result.state as keyof typeof messages]({}, options)}</p>
          {result.state === 'cursor' && onRestart ? (
            <Button variant="outline" disabled={busy} onClick={onRestart}>
              {m.home_feed_restart({}, options)}
            </Button>
          ) : onRetry && result.state !== 'loading' ? (
            <Button variant="outline" disabled={busy} onClick={onRetry}>
              {m.library_follow_retry({}, options)}
            </Button>
          ) : null}
        </div>
      )}
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
  origin,
}: {
  initial: HomeFeedResult;
  locale: string;
  signedIn: boolean;
  read: (input: FeedInput, signal: AbortSignal) => Promise<HomeFeedResult>;
  readKinds: HomeKindsReader;
  readSpace: HomeSpaceReader;
  origin: string;
}) {
  const window = useState(() => createHomeFeedWindow(initial, read))[0];
  const choices = useState(() => createHomeKindChoices(readKinds))[0];
  const spaces = useState(() =>
    createHomeSpaceSelection(readSpace, (space, available) => {
      choices.retire();
      // Retire synchronously, including independent observed carrier changes at an unchanged head.
      window.retire(available ? undefined : { state: 'unavailable', code: 'space_unavailable' });
      if (!available) return;
      const { cursor: _cursor, spaceId: _spaceId, ...selection } = window.snapshot().input;
      void window.load({ ...selection, ...(space ? { spaceId: space.spaceId } : {}) });
    }),
  )[0];
  const spaceSnapshot = useSyncExternalStore(spaces.subscribe, spaces.snapshot, spaces.snapshot);
  useEffect(() => () => spaces.retire(), [spaces]);
  const kinds = useSyncExternalStore(choices.subscribe, choices.snapshot, choices.snapshot);
  useEffect(() => () => choices.retire(), [choices]);
  const snapshot = useSyncExternalStore(window.subscribe, window.snapshot, window.snapshot);
  useEffect(() => {
    if (signedIn) void window.load({ stream: 'home' });
    return window.clear;
  }, [window, signedIn]);
  return (
    <HomeFeed
      result={snapshot.result}
      locale={locale}
      signedIn={signedIn}
      stream={snapshot.input.stream}
      busy={snapshot.busy}
      spaceControl={
        <HomeFeedSpaceControl selection={spaces} snapshot={spaceSnapshot} locale={locale} origin={origin} />
      }
      kindControl={
        <HomeFeedKindControl
          choices={choices}
          snapshot={kinds}
          locale={locale}
          onSelect={(choice) => {
            spaces.retire();
            choices.select(choice);
            const { cursor: _cursor, kind: _kind, ...selection } = snapshot.input;
            const input = { ...selection, ...(choice ? { kind: choice.id } : {}) };
            window.retire(undefined, input);
            if (!spaces.snapshot().available) {
              window.retire({ state: 'unavailable', code: 'space_unavailable' });
              return;
            }
            void window.load(input);
          }}
        />
      }
      onSelect={(stream) => {
        choices.retire();
        spaces.retire();
        const { cursor: _cursor, ...selection } = snapshot.input;
        const input = { ...selection, stream };
        window.retire(undefined, input);
        if (!spaces.snapshot().available) {
          window.retire({ state: 'unavailable', code: 'space_unavailable' });
          return;
        }
        void window.load(input);
      }}
      onRetry={() => {
        if (spaces.snapshot().available) void window.load(snapshot.input);
        else void spaces.refresh();
      }}
      onRestart={() => {
        if (!spaces.snapshot().available) return;
        const { cursor: _cursor, ...selection } = snapshot.input;
        void window.load(selection);
      }}
      onNext={(cursor) => {
        if (spaces.snapshot().available) void window.load({ ...snapshot.input, cursor });
      }}
    />
  );
}

import type { ReactNode, Ref } from 'react';
import { ContentItem, type ContentItemHeadingLevel, type ContentItemProps } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';

export type FeedItemPresentation = Omit<ContentItemProps, 'headingLevel'> & {
  'data-feed-id'?: string;
  'data-feed-source'?: string;
};

export type FeedResultsSourceState = 'ready' | 'preparing' | 'unavailable' | 'not_requested';

/** Availability is supplied by the result owner, even when it has no per-source metadata. */
export type FeedResultsAvailability = {
  state: 'complete' | 'partial' | 'unavailable';
  sources?: Readonly<Record<string, FeedResultsSourceState>>;
};

export type FeedResultsFailureState = 'request' | 'auth' | 'denied' | 'closed' | 'cursor' | 'deadline' | 'unavailable';

export type FeedResultsProblem =
  | { state: 'loading'; code?: string }
  | { state: FeedResultsFailureState; code?: string };

export type FeedResultsResult<T> =
  | {
      state: 'ready';
      items: readonly T[];
      hasNext: boolean;
      availability: FeedResultsAvailability;
    }
  | FeedResultsProblem;

export type FeedResultsMessages = {
  loading: ReactNode;
  partial: ReactNode;
  empty: ReactNode;
  sparse: ReactNode;
  retry: ReactNode;
  restart: ReactNode;
  failure: Readonly<Record<FeedResultsFailureState, ReactNode>>;
};

export type FeedResultsProps<T> = {
  regionLabel: string;
  boundaryRef?: Ref<HTMLElement> | undefined;
  itemHeadingLevel: ContentItemHeadingLevel;
  listAs: 'ol' | 'ul';
  result: FeedResultsResult<T>;
  busy?: boolean | undefined;
  messages: FeedResultsMessages;
  getItemKey: (item: T) => string | number;
  itemPresentation: (item: T) => FeedItemPresentation;
  onRetry?: (() => void) | undefined;
  onRestart?: (() => void) | undefined;
  /** The caller's existing cursor-bound Button, RouterLink or anchor. */
  nextControl?: ReactNode | undefined;
  /** Caller-owned affordances appear only for a ready result with no returned items. */
  emptyActions?: ReactNode | undefined;
  /** The owner sets this only when its own selector explains the current blocked result. */
  suppressResultMessage?: boolean | undefined;
  className?: string | undefined;
  listClassName?: string | undefined;
};

/** One ordered, named result region. Its owner keeps selection, data access and continuation authority. */
export function FeedResults<T>({
  regionLabel,
  boundaryRef,
  itemHeadingLevel,
  listAs,
  result,
  busy = false,
  messages,
  getItemKey,
  itemPresentation,
  onRetry,
  onRestart,
  nextControl,
  emptyActions,
  suppressResultMessage = false,
  className = 'space-y-4',
  listClassName = 'list-none',
}: FeedResultsProps<T>) {
  const ItemList = listAs;
  const availability = result.state === 'ready' ? result.availability : undefined;
  const sourceState = availability?.sources
    ? Object.entries(availability.sources)
        .filter(([, state]) => state !== 'not_requested')
        .map(([source, state]) => `${source}:${state}`)
        .join(' ')
    : undefined;
  const hasPartialSource = Object.values(availability?.sources ?? {}).some(
    (state) => state === 'preparing' || state === 'unavailable',
  );
  const partial = availability !== undefined && (availability.state !== 'complete' || hasPartialSource);
  const noItems = result.state === 'ready' && result.items.length === 0;

  return (
    <section
      ref={boundaryRef}
      tabIndex={boundaryRef ? -1 : undefined}
      aria-label={regionLabel}
      aria-busy={busy}
      className={className}
      data-feed-result-state={result.state}
      data-feed-source-state={sourceState}
    >
      {busy && !suppressResultMessage ? (
        <p role="status" className="text-sm text-muted-foreground">
          {messages.loading}
        </p>
      ) : null}
      {result.state === 'ready' ? (
        <>
          <ItemList aria-label={regionLabel} className={listClassName} data-feed-has-next={result.hasNext}>
            {result.items.map((item) => (
              <ContentItem key={getItemKey(item)} {...itemPresentation(item)} headingLevel={itemHeadingLevel} />
            ))}
          </ItemList>
          {partial ? (
            <p role="status" className="text-sm text-muted-foreground">
              {messages.partial}
            </p>
          ) : null}
          {noItems && !partial ? <p role="status">{result.hasNext ? messages.sparse : messages.empty}</p> : null}
          {noItems && emptyActions ? <div data-feed-slot="empty-actions">{emptyActions}</div> : null}
          <div className="flex flex-wrap items-center gap-2">
            {partial && onRetry ? (
              <Button variant="outline" disabled={busy} onClick={onRetry}>
                {messages.retry}
              </Button>
            ) : null}
            {nextControl}
          </div>
        </>
      ) : suppressResultMessage ? null : (
        <div
          role={result.state === 'loading' ? 'status' : 'alert'}
          className="space-y-3 rounded-lg border border-border p-5"
        >
          <p>{result.state === 'loading' ? messages.loading : messages.failure[result.state]}</p>
          {result.state === 'cursor' && onRestart ? (
            <Button variant="outline" disabled={busy} onClick={onRestart}>
              {messages.restart}
            </Button>
          ) : result.state !== 'loading' && result.state !== 'cursor' && onRetry ? (
            <Button variant="outline" disabled={busy} onClick={onRetry}>
              {messages.retry}
            </Button>
          ) : null}
        </div>
      )}
    </section>
  );
}

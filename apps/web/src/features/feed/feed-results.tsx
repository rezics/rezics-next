import type { ReactNode, Ref } from 'react';
import { ContentItem, type ContentItemHeadingLevel, type ContentItemProps } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import {
  FeedEmptyState,
  feedAvailability,
  type FeedEmptyContext,
  type FeedEmptyExplanation,
  type FeedEmptyKind,
} from './feed-empty-state';

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
  /** Optional explained presentation; existing callers retain their supplied wording. */
  explanations?: Partial<Record<FeedEmptyKind, FeedEmptyExplanation>>;
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
  /** Existing owner gates (for example localized sign-in); never inferred from error codes. */
  failureActions?: Partial<Record<FeedResultsFailureState, ReactNode>> | undefined;
  emptyContext?: FeedEmptyContext | undefined;
  emptyHeadingLevel?: 1 | 2 | 3 | 4 | 5 | 6 | undefined;
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
  failureActions,
  emptyContext,
  emptyHeadingLevel = 2,
  className = 'space-y-4',
  listClassName = 'list-none',
}: FeedResultsProps<T>) {
  const ItemList = listAs;
  const availability = result.state === 'ready' ? feedAvailability(result.availability) : undefined;
  const partial = availability?.partial === true;
  const noItems = result.state === 'ready' && result.items.length === 0;
  const readyKind: FeedEmptyKind =
    result.state !== 'ready'
      ? 'loading'
      : partial
        ? result.availability.state === 'unavailable'
          ? 'unavailable'
          : 'partial'
        : busy
          ? 'loading'
          : result.hasNext
            ? 'sparse'
            : 'empty';
  const retryControl = onRetry ? (
    <Button type="button" className="min-h-11" variant="outline" disabled={busy} onClick={onRetry}>
      {messages.retry}
    </Button>
  ) : null;
  const readyActions = (
    <>
      {partial ? retryControl : null}
      {nextControl}
      {noItems && emptyActions && readyKind !== 'loading' ? (
        <div data-feed-slot="empty-actions" className="flex min-w-0 flex-wrap justify-center gap-2">
          {emptyActions}
        </div>
      ) : null}
    </>
  );
  const problemActions =
    result.state === 'ready' || result.state === 'loading'
      ? undefined
      : (failureActions?.[result.state] ??
        (result.state === 'cursor' ? (
          onRestart ? (
            <Button type="button" className="min-h-11" variant="outline" disabled={busy} onClick={onRestart}>
              {messages.restart}
            </Button>
          ) : null
        ) : result.state === 'auth' || result.state === 'closed' || result.state === 'denied' ? null : (
          retryControl
        )));

  return (
    <section
      ref={boundaryRef}
      tabIndex={boundaryRef ? -1 : undefined}
      aria-label={regionLabel}
      aria-busy={busy || result.state === 'loading'}
      className={className}
      data-feed-result-state={result.state}
      data-feed-source-state={availability?.sources}
    >
      {busy && result.state === 'ready' && !noItems && !partial && !suppressResultMessage ? (
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
          {noItems ? (
            <FeedEmptyState
              kind={readyKind}
              messages={messages}
              actions={readyActions}
              headingLevel={emptyHeadingLevel}
              context={emptyContext}
            />
          ) : (
            <>
              {partial ? (
                <p role="status" className="text-sm text-muted-foreground">
                  {messages.partial}
                </p>
              ) : null}
              <div className="flex flex-wrap items-center gap-2">{readyActions}</div>
            </>
          )}
        </>
      ) : suppressResultMessage ? null : (
        <FeedEmptyState
          kind={result.state}
          messages={messages}
          actions={problemActions}
          headingLevel={emptyHeadingLevel}
        />
      )}
    </section>
  );
}

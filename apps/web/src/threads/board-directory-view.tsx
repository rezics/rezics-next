import { useEffect, useRef, useState, type MouseEvent } from 'react';
import { ContentItem } from '@rezics/ui/content-item';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import {
  boardDirectoryHref,
  sameBoardContribution,
  type BoardContribution,
  type BoardDirectoryPrevious,
  type BoardDirectoryRequest,
  type BoardDirectoryState,
} from './board-directory';
import { reviewThreadHref } from './review-policy';

type Props = {
  request: BoardDirectoryRequest;
  contribution?: BoardContribution;
  result: BoardDirectoryState;
  previous?: BoardDirectoryPrevious;
  onNavigate?: (request: BoardDirectoryRequest) => void;
  onRetry: () => void;
};

const actionClassName =
  'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal px-4 py-2 text-center [overflow-wrap:anywhere]';

/** Shared directory region for the route and its Patterns/Pages stories. Listing never grants creation. */
export function BoardDirectory({ request, contribution, result, previous, onNavigate, onRetry }: Props) {
  const locale = getLocale();
  const requestIdentity = JSON.stringify([
    request.purpose,
    request.cursor ?? null,
    request.limit,
    contribution?.subject ?? null,
    contribution?.subjectTitle ?? null,
  ]);
  const [keyboardRetry, setKeyboardRetry] = useState<string | null>(null);
  const resultRegion = useRef<HTMLElement>(null);
  const retryButton = useRef<HTMLButtonElement>(null);
  useEffect(() => {
    if (!keyboardRetry) return;
    if (keyboardRetry !== requestIdentity) {
      setKeyboardRetry(null);
      return;
    }
    if (result.state !== 'loading') {
      setKeyboardRetry(null);
      (result.state === 'unavailable' ? retryButton.current : resultRegion.current)?.focus();
      return;
    }
    const cancel = () => setKeyboardRetry(null);
    const moved = (event: FocusEvent) => {
      if (event.target !== document.body) cancel();
    };
    document.addEventListener('pointerdown', cancel, true);
    document.addEventListener('focusin', moved, true);
    window.addEventListener('blur', cancel);
    return () => {
      document.removeEventListener('pointerdown', cancel, true);
      document.removeEventListener('focusin', moved, true);
      window.removeEventListener('blur', cancel);
    };
  }, [keyboardRetry, requestIdentity, result.state]);
  const navigate = (destination: BoardDirectoryRequest) => (event: MouseEvent<HTMLAnchorElement>) => {
    if (!onNavigate || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    event.preventDefault();
    onNavigate(destination);
  };
  const purposeLabel = (purpose: BoardDirectoryRequest['purpose']) =>
    purpose === 'reviews' ? m.board_directory_reviews() : m.board_directory_discussion();
  const canGoBack =
    previous?.request.purpose === request.purpose &&
    previous.target === request.cursor &&
    sameBoardContribution(previous.contribution, contribution);
  const next = result.state === 'ready' && result.next !== request.cursor ? result.next : null;
  return (
    <article className="min-w-0 w-full max-w-4xl space-y-6 text-foreground [overflow-wrap:anywhere]">
      <header className="min-w-0 space-y-3">
        <p className="text-sm font-medium text-muted-foreground">{m.board_directory_global()}</p>
        <PageHeading>{m.board_directory_heading()}</PageHeading>
        <p className="max-w-2xl text-muted-foreground">{m.board_directory_description()}</p>
        {contribution ? <p>{m.board_directory_subject({ title: contribution.subjectTitle })}</p> : null}
      </header>
      <nav aria-label={m.board_directory_purpose()} className="flex flex-wrap gap-2">
        {(['discussion', 'reviews'] as const).map((purpose) => {
          const destination = { purpose, limit: request.limit };
          return (
            <a
              key={purpose}
              href={boardDirectoryHref(destination, locale, contribution)}
              onClick={navigate(destination)}
              aria-current={request.purpose === purpose ? 'page' : undefined}
              className={cn(
                buttonVariants({ variant: request.purpose === purpose ? 'secondary' : 'ghost', size: 'lg' }),
                actionClassName,
              )}
            >
              {purposeLabel(purpose)}
            </a>
          );
        })}
      </nav>
      <section
        ref={resultRegion}
        tabIndex={-1}
        aria-label={purposeLabel(request.purpose)}
        aria-busy={result.state === 'loading'}
        className="space-y-4"
      >
        {result.state === 'loading' ? <p role="status">{m.board_directory_loading()}</p> : null}
        {result.state === 'unavailable' ? (
          <div role="status" className="space-y-3">
            <p>{m.board_directory_unavailable()}</p>
            <Button
              ref={retryButton}
              variant="outline"
              size="lg"
              className={actionClassName}
              onClick={(event) => {
                if (event.detail === 0) setKeyboardRetry(requestIdentity);
                onRetry();
              }}
            >
              {m.board_directory_retry()}
            </Button>
            {request.cursor ? (
              <a
                href={boardDirectoryHref({ purpose: request.purpose, limit: request.limit }, locale, contribution)}
                onClick={navigate({ purpose: request.purpose, limit: request.limit })}
                className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), actionClassName)}
              >
                {m.board_directory_restart()}
              </a>
            ) : null}
          </div>
        ) : null}
        {result.state === 'closed' ? (
          <div role="status" className="space-y-2">
            <h2 className="text-xl font-semibold">{m.platform_closed_heading()}</h2>
            <p>{m.platform_closed_message()}</p>
          </div>
        ) : null}
        {result.state === 'denied' ? <p role="status">{m.board_directory_denied()}</p> : null}
        {result.state === 'ready' ? (
          result.boards.length ? (
            <ul className="space-y-1">
              {result.boards.map((board) => {
                const title = board.title ?? m.threads_untitled();
                const href = `/${locale}/boards/${encodeURIComponent(board.id)}`;
                const write =
                  contribution &&
                  board.realmId === null &&
                  board.purpose === request.purpose &&
                  board.visibility === 'published' &&
                  board.availability === 'available';
                const writeLabel =
                  board.purpose === 'reviews' ? m.subject_community_review() : m.subject_community_discuss();
                return (
                  <ContentItem
                    key={board.id}
                    title={title}
                    headingLevel={2}
                    href={href}
                    className="min-h-[52px] [&>div]:sm:block [&_[data-content-item-slot=title]]:line-clamp-none [&_[data-content-item-slot=actions]]:max-w-full"
                    metadata={
                      <MetaLine
                        className="min-w-0 text-sm text-muted-foreground [overflow-wrap:anywhere]"
                        items={[
                          m.board_directory_global(),
                          purposeLabel(board.purpose),
                          board.visibility === 'protected' ? m.board_directory_protected() : m.board_directory_public(),
                        ]}
                      />
                    }
                    actions={
                      <a
                        href={
                          write
                            ? reviewThreadHref(locale, board.id, contribution.subject, contribution.subjectTitle)
                            : href
                        }
                        aria-label={
                          write
                            ? board.purpose === 'reviews'
                              ? m.board_directory_review_named({ title, subject: contribution.subjectTitle })
                              : m.board_directory_discuss_named({ title, subject: contribution.subjectTitle })
                            : m.board_directory_open_named({ title })
                        }
                        className={cn(buttonVariants({ variant: 'outline' }), actionClassName)}
                      >
                        {write ? writeLabel : m.board_directory_open()}
                      </a>
                    }
                  />
                );
              })}
            </ul>
          ) : (
            <p className="text-muted-foreground">
              {result.next === null ? m.board_directory_empty() : m.board_directory_sparse()}
            </p>
          )
        ) : null}
      </section>
      {result.state === 'ready' && (canGoBack || next) ? (
        <nav aria-label={m.board_directory_pages()} className="flex flex-wrap gap-3">
          {canGoBack && previous ? (
            <a
              href={boardDirectoryHref(previous.request, locale, contribution)}
              onClick={navigate(previous.request)}
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), actionClassName)}
            >
              {m.board_directory_previous()}
            </a>
          ) : null}
          {next ? (
            <a
              href={boardDirectoryHref({ ...request, cursor: next }, locale, contribution)}
              onClick={navigate({ ...request, cursor: next })}
              className={cn(buttonVariants({ variant: 'outline', size: 'lg' }), actionClassName)}
            >
              {m.board_directory_next()}
            </a>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}

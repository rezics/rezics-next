import type { MouseEvent } from 'react';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { MetaLine } from '@rezics/ui/meta-line';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
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

/** Shared directory region for the route and its Patterns/Pages stories. Listing never grants creation. */
export function BoardDirectory({ request, contribution, result, previous, onNavigate, onRetry }: Props) {
  const locale = getLocale();
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
    <article className="max-w-4xl space-y-6 text-foreground">
      <header className="space-y-3">
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
              className={buttonVariants({ variant: request.purpose === purpose ? 'secondary' : 'ghost', size: 'lg' })}
            >
              {purposeLabel(purpose)}
            </a>
          );
        })}
      </nav>
      <section aria-label={purposeLabel(request.purpose)} aria-busy={result.state === 'loading'} className="space-y-4">
        {result.state === 'loading' ? <p role="status">{m.board_directory_loading()}</p> : null}
        {result.state === 'unavailable' ? (
          <div role="status" className="space-y-3">
            <p>{m.board_directory_unavailable()}</p>
            <Button variant="outline" size="lg" onClick={onRetry}>
              {m.board_directory_retry()}
            </Button>
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
                  <ListRow key={board.id} className="flex items-center gap-4 py-4">
                    <ListRowLink href={href}>{title}</ListRowLink>
                    <div className="min-w-0 flex-1 space-y-1">
                      <h2 aria-hidden="true" className="text-lg font-semibold tracking-tight text-balance">
                        {title}
                      </h2>
                      <MetaLine
                        className="text-sm text-muted-foreground"
                        items={[
                          m.board_directory_global(),
                          purposeLabel(board.purpose),
                          board.visibility === 'protected' ? m.board_directory_protected() : m.board_directory_public(),
                        ]}
                      />
                    </div>
                    <ListRowControl>
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
                        className={buttonVariants({ variant: 'outline' })}
                      >
                        {write ? writeLabel : m.board_directory_open()}
                      </a>
                    </ListRowControl>
                  </ListRow>
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
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.board_directory_previous()}
            </a>
          ) : null}
          {next ? (
            <a
              href={boardDirectoryHref({ ...request, cursor: next }, locale, contribution)}
              onClick={navigate({ ...request, cursor: next })}
              className={buttonVariants({ variant: 'outline', size: 'lg' })}
            >
              {m.board_directory_next()}
            </a>
          ) : null}
        </nav>
      ) : null}
    </article>
  );
}

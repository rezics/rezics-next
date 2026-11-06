import type { ReadingPageResponse } from '@rezics/client';
import { exactRevisionHref } from '../exact-revision-href';
import type { ThreadPost } from '../thread-page';
import { threadLocation } from '../thread-href';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';

export type ThreadReviewContextValue = NonNullable<ReadingPageResponse['reviewContext']>;

/** Current review target and exact published citation identities from the admitted page. */
export function ThreadReviewContext({
  context,
  thread,
  posts,
  cursor,
  boardReturn,
  locale,
}: {
  context: ThreadReviewContextValue | undefined;
  thread: { id: string; title: string | null };
  posts: readonly ThreadPost[];
  cursor?: string | null;
  boardReturn?: string;
  locale: string;
}) {
  if (!context || context.source.threadId !== thread.id) return null;
  const sourcePost = posts.find((post) => post.id === context.source.postId);
  if (
    !sourcePost ||
    sourcePost.availability !== 'available' ||
    context.source.revisionId === null ||
    sourcePost.threadId !== context.source.threadId ||
    sourcePost.revisionId !== context.source.revisionId
  )
    return null;

  const options = { locale: locale as never };
  const target = context.target;
  const subject =
    target.state === 'available'
      ? {
          id: target.subject.id,
          label: target.subject.label?.value ?? m.subject_value_unlabelled({}, options),
          language: target.subject.label?.language,
        }
      : undefined;

  return (
    <details
      className="min-w-0 rounded-lg border border-border/70 bg-card px-3 py-2 text-sm"
      data-thread-review-context
    >
      <summary className="min-h-11 cursor-pointer py-2 font-medium">{m.thread_review_details_heading()}</summary>
      <div className="min-w-0 space-y-3 pb-2 [overflow-wrap:anywhere]">
        {subject ? (
          <p className="flex min-w-0 flex-wrap gap-x-2" data-review-subject={subject.id}>
            <span>{m.thread_review_details_selected_subject({ title: subject.label }, options)}</span>
            <a href={subjectHref({ id: subject.id, label: subject.label }, locale).href} className="underline">
              <bdi lang={subject.language}>{subject.label}</bdi>
            </a>
          </p>
        ) : (
          <p role="status" data-review-target-state={target.state}>
            {target.state === 'absent'
              ? m.post_history_targets_absent({}, options)
              : target.state === 'withheld'
                ? m.post_history_target_concealed({}, options)
                : m.post_history_targets_failed({}, options)}
          </p>
        )}
        {context.citations.state === 'current' && context.citations.items.length ? (
          <ol className="m-0 list-decimal space-y-2 pl-5" data-review-citations>
            {context.citations.items.map((item) => {
              const post = posts.find((candidate) => candidate.id === item.postId);
              const readablePost = post?.availability === 'available' ? post : undefined;
              const exactPost =
                readablePost && item.sourceRevisionId !== null && readablePost.revisionId === item.sourceRevisionId
                  ? readablePost
                  : undefined;
              const citation = item.citation;
              return (
                <li
                  key={`${item.postId}:${item.sourceRevisionId ?? 'unknown'}`}
                  data-review-citation-post={item.postId}
                  data-review-citation-revision={exactPost?.revisionId}
                >
                  {citation.state === 'available' && exactPost ? (
                    <div className="min-w-0 space-y-1">
                      <a
                        href={exactRevisionHref({ postId: item.postId, revisionId: exactPost.revisionId }, locale)}
                        className="underline"
                      >
                        {m.post_history_citation_identity({}, options)}
                      </a>
                      <p>
                        <span>{m.post_history_citation_identity({}, options)}: </span>
                        <bdi dir="ltr">{citation.questionId}</bdi>
                        {' / '}
                        <span>{m.thread_history_version({ number: citation.voteRevision }, options)}</span>
                      </p>
                      <p data-cited-value={citation.units}>
                        {m.home_feed_review_cited_units(
                          { units: new Intl.NumberFormat(locale).format(citation.units) },
                          options,
                        )}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {m.search_review_historical_question_unavailable({}, options)}
                      </p>
                    </div>
                  ) : (
                    <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                      <span>
                        {citation.state === 'absent'
                          ? m.thread_review_citation_absent({}, options)
                          : citation.state === 'withheld'
                            ? m.post_history_score_concealed({}, options)
                            : m.post_history_context_failed({}, options)}
                      </span>
                      {readablePost ? (
                        <a
                          href={threadLocation(
                            locale,
                            thread,
                            cursor ?? undefined,
                            readablePost.id,
                            undefined,
                            boardReturn,
                          )}
                          className="underline"
                        >
                          {m.thread_posts_heading({}, options)}
                        </a>
                      ) : null}
                    </div>
                  )}
                </li>
              );
            })}
          </ol>
        ) : null}
      </div>
    </details>
  );
}

import type { ReadingPageResponse } from '@rezics/client';
import { slug } from '@rezics/definitions/slug';
import { exactRevisionHref } from '../exact-revision-href';
import type { ThreadPost } from '../thread-page';
import { threadLocation } from '../thread-href';
import { ConversationInspection } from '../conversation-presentation';
import { m } from '../../paraglide/messages.js';

function reviewSubjectHref(id: string, label: string, locale: string): string {
  return `/${encodeURIComponent(locale)}/subjects/${encodeURIComponent(id)}/${slug(label)}`;
}

export type ThreadReviewContextValue = NonNullable<ReadingPageResponse['reviewContext']>;

/** Subject and published value are reading context. Exact citation operands remain inspectable as supplied. */
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
  cursor?: string | null | undefined;
  boardReturn?: string | undefined;
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
    <section
      aria-label={m.thread_review_details_heading({}, options)}
      className="min-w-0 space-y-3 rounded-xl border-s-2 border-primary/40 bg-muted/30 px-4 py-3 text-sm [overflow-wrap:anywhere]"
      data-thread-review-context
    >
      {subject ? (
        <div className="min-w-0" data-review-subject={subject.id}>
          <a
            href={reviewSubjectHref(subject.id, subject.label, locale)}
            className="inline-flex min-h-11 max-w-full items-center font-medium underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring"
          >
            <bdi lang={subject.language}>
              {m.thread_review_details_selected_subject({ title: subject.label }, options)}
            </bdi>
          </a>
        </div>
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
        <ol className="m-0 list-none space-y-3" data-review-citations>
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
                className="min-w-0"
              >
                {citation.state === 'available' && exactPost ? (
                  <div className="min-w-0 space-y-1">
                    <p data-cited-value={citation.units} className="font-medium">
                      {m.home_feed_review_cited_units(
                        { units: new Intl.NumberFormat(locale).format(citation.units) },
                        options,
                      )}
                    </p>
                    <p className="text-xs leading-relaxed text-muted-foreground">
                      {m.search_review_historical_question_unavailable({}, options)}
                    </p>
                    <ConversationInspection label={m.conversation_inspect_citation({}, options)}>
                      <a
                        href={exactRevisionHref({ postId: item.postId, revisionId: exactPost.revisionId }, locale)}
                        className="inline-flex min-h-11 max-w-full items-center underline underline-offset-4"
                      >
                        {m.post_history_citation_identity({}, options)}
                      </a>
                      <p>
                        <span>{m.post_history_citation_identity({}, options)}: </span>
                        <bdi dir="ltr" className="select-all font-mono text-xs">
                          {citation.questionId}
                        </bdi>
                        {' / '}
                        <span>{m.thread_history_version({ number: citation.voteRevision }, options)}</span>
                      </p>
                    </ConversationInspection>
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
                        className="inline-flex min-h-11 items-center underline underline-offset-4"
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
    </section>
  );
}

import type { FeedItem } from '../pages/home-feed-read';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { accountHref } from '../../subject/subject-href';
import { threadLocation } from '../../threads/thread-href';
import { exactRevisionHref } from '../../threads/exact-revision-href';
import { feedCardLinkClassName } from './card-presentation';

/** Recorded units keep their own question and scale, including zero and nonstandard questions. */
export function FeedCardCitation({ item, locale }: { item: FeedItem; locale: string }) {
  const context = 'reviewContext' in item.summary ? item.summary.reviewContext : undefined;
  if (!context) return null;
  const options = { locale: locale as Locale };
  const citation = context.citation;
  if (citation.state !== 'available')
    return (
      <span data-feed-card-citation={citation.state}>
        {citation.state === 'absent'
          ? m.thread_provenance_unscored({}, options)
          : m.subject_community_citation_unavailable({}, options)}
      </span>
    );
  const format = (value: number) => new Intl.NumberFormat(locale).format(value);
  const { question } = citation;
  return (
    <div className="min-w-0 space-y-1" data-feed-card-citation="available">
      <p>
        <span>{m.thread_provenance_rating({}, options)}: </span>
        <bdi>{question.label}</bdi>
        {' · '}
        <span>{m.discussion_provenance_details_rating_units({ units: format(citation.units) }, options)}</span>
      </p>
      <details>
        <summary className="min-h-11 cursor-pointer py-2">
          {m.discussion_provenance_details_heading({}, options)}
        </summary>
        <p>{m.rating_question_revision({ revision: format(question.revision) }, options)}</p>
        <p>
          {m.library_my_ratings_scale({}, options)}: {format(question.scale.min)}–{format(question.scale.max)} ·{' '}
          {format(question.scale.displayStep)}
        </p>
        <p>
          {m.thread_provenance_vote(
            { units: format(citation.units), questionId: question.id, revision: format(citation.voteRevision) },
            options,
          )}
        </p>
      </details>
    </div>
  );
}

/** Only the supplied immediate parent is displayed; its current post and recorded revision are distinct links. */
export function FeedCardParent({ item, locale }: { item: FeedItem; locale: string }) {
  const summary = item.summary;
  const context = 'parentContext' in summary ? summary.parentContext : undefined;
  if (!context || context.kind === 'opening' || item.destination.kind !== 'post') return null;
  if (
    item.key.owner !== 'content' ||
    item.key.kind !== 'post' ||
    item.key.id !== summary.id ||
    item.destination.id !== summary.id ||
    item.destination.postId !== summary.id ||
    !('threadId' in summary) ||
    item.destination.threadId !== summary.threadId
  )
    return null;
  const options = { locale: locale as Locale };
  const { parent } = context;
  if (parent.state === 'withheld')
    return <p data-feed-card-parent="withheld">{m.thread_reply_parent_unavailable({}, options)}</p>;
  const href = threadLocation(
    locale,
    { id: item.destination.threadId, title: item.destination.title },
    undefined,
    parent.id,
  );
  if (parent.state === 'removed')
    return (
      <p data-feed-card-parent="removed">
        <a href={href} className={feedCardLinkClassName}>
          {m.thread_reply_parent_deleted({}, options)}
        </a>
      </p>
    );
  const author = parent.author;
  const name = author?.displayName || (author?.handle ? `@${author.handle}` : m.thread_author_unknown({}, options));
  const identity = <bdi>{name}</bdi>;
  const excerpt = parent.excerpt ? (
    <p
      lang={parent.language ?? undefined}
      className="line-clamp-4 whitespace-pre-line [overflow-wrap:anywhere]"
      data-feed-card-parent-preview
    >
      <bdi>{parent.excerpt}</bdi>
    </p>
  ) : null;
  return (
    <aside className="min-w-0 space-y-1 border-s-2 ps-3" data-feed-card-parent="available">
      <a href={href} className={feedCardLinkClassName}>
        {m.thread_reply_parent_view({}, options)}
      </a>
      <div data-feed-card-parent-author>
        {author?.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(author.handle) ? (
          <a href={accountHref(locale, author.handle)} className={feedCardLinkClassName}>
            {identity}
          </a>
        ) : (
          identity
        )}
      </div>
      {parent.spoiler && excerpt ? (
        <details data-feed-card-parent-spoiler>
          <summary className="min-h-11 cursor-pointer py-2">{m.thread_reveal_spoiler({}, options)}</summary>
          {excerpt}
        </details>
      ) : (
        excerpt
      )}
      <a
        href={exactRevisionHref({ postId: parent.id, revisionId: parent.revisionId }, locale)}
        className={feedCardLinkClassName}
      >
        {m.thread_provenance_heading({}, options)}
      </a>
    </aside>
  );
}

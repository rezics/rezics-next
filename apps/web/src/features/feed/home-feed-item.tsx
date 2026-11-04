import { continueProgress } from '../../library/continue-source';
import { progressView } from '../../library/progress-label';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { fullDateTime } from '../../threads/byline';
import { feedConversationActivity, formatConversationReplyCount } from '../../threads/activity';
import { homeFeedDestination, homeFeedResume, homeFeedTitle } from '../pages/home-feed-destination';
import type { FeedItem } from '../pages/home-feed-read';
import type { FeedItemPresentation } from './feed-results';
import { FeedCardAttribution } from './card-attribution';
import {
  FeedCardContext,
  FeedCardParentContext,
  FeedCardPreview,
  FeedCardVisual,
  feedCardKind,
} from './card-presentation';
import type { FeedActionBarProps } from './action-bar';
import { HomePublicOwnerContext } from './home-public-owner/view';

/** A current-page projection: no hydration, retained identity, source inference or reordering. */
export function homeFeedItemPresentation(
  item: FeedItem,
  locale: string,
  origin?: FeedActionBarProps['origin'],
): FeedItemPresentation {
  const options = { locale: locale as Locale };
  const title = homeFeedTitle(item, locale);
  const href = homeFeedDestination(item, locale);
  const resume = homeFeedResume(item, locale);
  const summary = item.summary;
  const activity =
    item.key.owner === 'content' && 'conversationActivity' in summary && summary.conversationActivity !== undefined
      ? feedConversationActivity(summary)
      : null;
  const kind = feedCardKind(item);
  const parentContext = 'parentContext' in summary ? summary.parentContext : undefined;
  const parent = parentContext?.kind === 'reply' ? parentContext.parent : undefined;
  const parentKey = [
    origin?.key ?? '',
    item.id,
    parent?.state ?? parentContext?.kind ?? '',
    parent && 'id' in parent ? parent.id : '',
    parent?.state === 'available' ? parent.revisionId : '',
  ].join(':');
  const progress =
    item.source === 'continue' ? progressView(continueProgress(item.continue.activeProgressSession), locale) : null;
  return {
    'data-feed-id': item.id,
    'data-feed-source': item.source,
    ...(href === undefined ? {} : { href }),
    title,
    ...('label' in summary && summary.label?.language ? { titleLang: summary.label.language } : {}),
    className: '[overflow-wrap:anywhere] [&_[data-content-item-slot=title]]:break-words',
    visual: FeedCardVisual({ item, title, href, locale }),
    context: <FeedCardContext item={item} kind={kind} locale={locale} />,
    metadata: (
      <>
        <FeedCardAttribution item={item} kind={kind} locale={locale} />
        {activity?.state === 'current' ? (
          <p data-slot="conversation-activity" className="flex flex-wrap gap-x-3 text-sm text-muted-foreground">
            <span
              aria-label={
                activity.count.kind === 'lower-bound'
                  ? m.board_thread_replies_lower_bound(
                      { count: formatConversationReplyCount(activity.count, locale).replace(/\+$/, '') },
                      options,
                    )
                  : undefined
              }
            >
              {m.board_thread_replies({ count: formatConversationReplyCount(activity.count, locale) }, options)}
            </span>
            {activity.lastActivityAt ? (
              <time dateTime={activity.lastActivityAt} title={fullDateTime(activity.lastActivityAt, locale)}>
                {m.board_thread_last_activity({ time: fullDateTime(activity.lastActivityAt, locale) }, options)}
              </time>
            ) : null}
          </p>
        ) : activity?.state === 'withheld' ? (
          <div
            data-slot="conversation-activity"
            role="status"
            className="flex flex-wrap gap-x-3 text-sm text-muted-foreground"
          >
            <span>{m.board_thread_activity_unavailable({}, options)}</span>
            {href ? (
              <a href={href} className="text-primary underline underline-offset-4">
                {m.subject_section_retry({}, options)}
              </a>
            ) : null}
          </div>
        ) : null}
      </>
    ),
    preview: (
      <>
        {kind === 'collection' || kind === 'space' ? (
          <HomePublicOwnerContext item={item} locale={locale} />
        ) : (
          <FeedCardPreview item={item} />
        )}
        <FeedCardParentContext key={parentKey} item={item} locale={locale} {...(origin ? { origin } : {})} />
      </>
    ),
    state: progress?.text,
    actions:
      resume === undefined ? undefined : (
        <a
          href={resume}
          className="inline-flex min-h-11 items-center break-words text-sm text-primary underline underline-offset-4"
        >
          {m.home_continue_label({ title }, options)}
        </a>
      ),
  };
}

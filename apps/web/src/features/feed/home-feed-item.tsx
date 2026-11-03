import { continueProgress } from '../../library/continue-source';
import { progressView } from '../../library/progress-label';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { homeFeedDestination, homeFeedResume, homeFeedTitle } from '../pages/home-feed-destination';
import type { FeedItem } from '../pages/home-feed-read';
import type { FeedItemPresentation } from './feed-results';
import { FeedCardAttribution } from './card-attribution';
import { FeedCardContext, FeedCardPreview, FeedCardVisual, feedCardKind } from './card-presentation';

/** A current-page projection: no hydration, retained identity, source inference or reordering. */
export function homeFeedItemPresentation(item: FeedItem, locale: string): FeedItemPresentation {
  const options = { locale: locale as Locale };
  const title = homeFeedTitle(item, locale);
  const href = homeFeedDestination(item, locale);
  const resume = homeFeedResume(item, locale);
  const summary = item.summary;
  const kind = feedCardKind(item);
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
    metadata: <FeedCardAttribution item={item} kind={kind} locale={locale} />,
    preview: <FeedCardPreview item={item} />,
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

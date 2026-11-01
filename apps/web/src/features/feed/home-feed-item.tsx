import type { ReactNode } from 'react';
import { Cover } from '@rezics/ui/cover';
import { coverSrc } from '../../media/cover-src';
import { coverOf, coverSubject } from '../../media/summary';
import { continueProgress } from '../../library/continue-source';
import { progressView } from '../../library/progress-label';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { homeFeedDestination, homeFeedResume, homeFeedTitle } from '../pages/home-feed-destination';
import type { FeedItem } from '../pages/home-feed-read';
import type { FeedItemPresentation } from './feed-results';

/** Home's installed native FeedItem projection; it performs no reads and keeps each owner-provided field. */
export function homeFeedItemPresentation(item: FeedItem, locale: string): FeedItemPresentation {
  const options = { locale: locale as Locale };
  const title = homeFeedTitle(item, locale);
  const href = homeFeedDestination(item, locale);
  const resume = homeFeedResume(item, locale);
  const summary = item.summary;
  const progress =
    item.source === 'continue' ? progressView(continueProgress(item.continue.activeProgressSession), locale) : null;
  let visual: ReactNode | undefined;
  if ('label' in summary) {
    visual = (
      <div className="w-20 shrink-0 sm:w-24">
        <Cover
          subject={coverSubject(summary.id, title, summary)}
          cover={coverOf(summary)}
          size="fill"
          src={coverSrc}
          decorative
        />
      </div>
    );
  } else if ('avatar' in summary && summary.avatar) {
    visual = (
      <div className="w-16 shrink-0">
        <Cover
          subject={{ id: summary.id, title, types: [] }}
          cover={{ ...summary.avatar, variants: [...summary.avatar.variants] }}
          ratio="1:1"
          size="fill"
          src={coverSrc}
          decorative
        />
      </div>
    );
  }
  const titleLang = 'label' in summary ? summary.label?.language : undefined;
  const preview = 'description' in summary ? summary.description : undefined;
  return {
    'data-feed-id': item.id,
    'data-feed-source': item.source,
    title,
    ...(href === undefined ? {} : { href }),
    ...(titleLang === undefined ? {} : { titleLang }),
    visual,
    preview: preview || undefined,
    state: progress?.text,
    actions:
      resume === undefined ? undefined : (
        <a
          href={resume}
          className="inline-flex min-h-11 items-center text-sm text-primary underline underline-offset-4"
        >
          {m.home_continue_label({ title }, options)}
        </a>
      ),
  };
}

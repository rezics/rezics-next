import { accountHref, subjectHref } from '../../subject/subject-href';
import { threadLocation } from '../../threads/thread-href';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import type { FeedItem } from './home-feed-read';

export function homeFeedTitle(item: FeedItem, locale: string): string {
  if ('label' in item.summary)
    return item.summary.label?.value || m.subject_value_unlabelled({}, { locale: locale as Locale });
  if ('displayName' in item.summary)
    return (
      item.summary.displayName ||
      (item.summary.handle ? `@${item.summary.handle}` : m.discovery_unnamed_account({}, { locale: locale as Locale }))
    );
  return item.summary.title || m.threads_untitled({}, { locale: locale as Locale });
}

/** Canonical local owner addresses, independent of source-provided URL strings. */
export function homeFeedDestination(item: FeedItem, locale: string): string | undefined {
  const destination = item.destination;
  switch (destination.kind) {
    case 'subject':
      return subjectHref({ id: destination.id, label: homeFeedTitle(item, locale) }, locale).href;
    case 'account': {
      const handle = 'handle' in item.summary ? item.summary.handle : null;
      return handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(handle) ? accountHref(locale, handle) : undefined;
    }
    case 'thread':
      return threadLocation(locale, destination);
    case 'post':
      // A fragment alone only selects posts already on the rendered page.
      // Let Content locate this post before reading its bounded page.
      return threadLocation(
        locale,
        { id: destination.threadId, title: destination.title },
        undefined,
        destination.postId,
      );
    case 'collection':
      return `/${encodeURIComponent(locale)}/collections/${encodeURIComponent(destination.id)}`;
    case 'space':
      return destination.address
        ? `/${encodeURIComponent(locale)}/spaces/${encodeURIComponent(destination.address)}`
        : undefined;
  }
}

export function homeFeedResume(item: FeedItem, locale: string): string | undefined {
  if (item.source !== 'continue') return;
  const session = item.continue.activeProgressSession;
  return session
    ? `/${encodeURIComponent(locale)}/library/progress/${encodeURIComponent(session.id)}`
    : `/${encodeURIComponent(locale)}/library/progress?subjectId=${encodeURIComponent(item.continue.subjectId)}`;
}

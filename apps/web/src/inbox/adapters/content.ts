import { contentMediaFailure } from '../../media/content-failure';
import { threadLocation } from '../../threads/thread-reading-context';
import type { InboxContentFailureReader, InboxThreadDestination } from '../ports/content';

export const inboxMediaFailure: InboxContentFailureReader = (error) => {
  const failure = contentMediaFailure(error);
  return failure
    ? {
        status: failure.status,
        problem: failure.problem,
        ...(failure.headers === undefined ? {} : { headers: failure.headers }),
      }
    : undefined;
};

/** Keep Inbox-owned notice identity and delegate only canonical thread URL construction to Content. */
export function inboxThreadDestination(
  locale: string,
  destination: InboxThreadDestination,
): string {
  return threadLocation(
    locale,
    { id: destination.id, ...(destination.title === undefined ? {} : { title: destination.title }) },
    undefined,
    destination.postId,
  );
}

export const inboxThreadHref = inboxThreadDestination;

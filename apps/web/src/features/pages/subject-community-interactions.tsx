import { FeedActionBar, type FeedActionBarProps } from '../feed/action-bar';
import { m } from '../../paraglide/messages.js';
import type { ThreadReactionsProps } from '../../threads/thread-reactions';
import type { CommunityThread } from './subject-community';
import { useSubjectCommunityLifetime } from './subject-community-lifetime';

export function SubjectCommunityInteractions({
  thread,
  subject,
  locale,
  href,
  contextId,
  reader,
  source,
  preparedTransport,
}: {
  thread: CommunityThread;
  subject: { id: string; label: string };
  locale: string;
  href: string;
  contextId: string | null;
  reader: string | null;
  source: string;
  preparedTransport?: ThreadReactionsProps['preparedTransport'];
}) {
  const ready = reader !== null && thread.reactions !== undefined && thread.viewerReaction !== undefined;
  const lifetime = useSubjectCommunityLifetime({
    subjectId: subject.id,
    contextId,
    reader,
    route: href,
    source,
    targetId: thread.id,
    ready,
    locale,
  });
  const reaction: FeedActionBarProps['reaction'] = ready
    ? {
        target: { kind: 'thread', id: thread.id },
        counts: thread.reactions!,
        value: thread.viewerReaction!,
        personalReady: true,
        reactionOrigin: lifetime,
        settleWithRead: true,
        ...(preparedTransport ? { preparedTransport } : {}),
      }
    : undefined;
  return (
    <FeedActionBar
      locale={locale}
      title={thread.title ?? m.threads_untitled({}, { locale: locale as never })}
      href={href}
      signedIn={reader !== null}
      {...(reaction ? { reaction } : {})}
      reactionPresentation="chips"
      reply={{ href: `${href}${href.includes('#') ? '' : '#reply'}` }}
      origin={lifetime}
    />
  );
}

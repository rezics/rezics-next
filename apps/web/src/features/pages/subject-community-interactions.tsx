import { QueryClientContext } from '@tanstack/react-query';
import { useContext, useMemo, useSyncExternalStore } from 'react';
import { m } from '../../paraglide/messages.js';
import { normalizeSessionObservation } from '../../session/browser-state';
import { browserObservation } from '../../session';
import { SignInPrompt } from '../../threads/write-prompts';
import { ThreadReactions, type ThreadReactionsProps } from '../../threads/thread-reactions';
import { ThreadWatch, type ThreadWatchProps } from '../../threads/thread-watch';
import type { CommunityReactionFreshness, CommunityThread } from './subject-community';
import { useSubjectCommunityLifetime } from './subject-community-lifetime';
import { PostActions } from '../../report/content-actions';
import type { VerificationConfig } from '../../report/turnstile';

const actionClass =
  'inline-flex min-h-11 min-w-11 max-w-full items-center rounded-sm px-2 text-sm font-medium whitespace-normal [overflow-wrap:anywhere] text-primary hover:underline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring';
const noSubscribe = () => () => {};
const unknownObservation = { state: 'unknown' } as const;
const readUnknownObservation = () => unknownObservation;

/** Only exact controls admitted by the selected native card are mounted here. */
export function SubjectCommunityInteractions({
  thread,
  subject,
  locale,
  href,
  contextId,
  reader,
  source,
  reactionsAsOf,
  preparedTransport,
  preparedWatch,
  refreshAdvice,
  verification,
}: {
  thread: CommunityThread;
  subject: { id: string; label: string };
  locale: string;
  href: string;
  contextId: string | null;
  reader: string | null;
  source: string;
  reactionsAsOf: CommunityReactionFreshness;
  preparedTransport?: ThreadReactionsProps['preparedTransport'];
  preparedWatch?: ThreadWatchProps['native'];
  refreshAdvice?: ThreadWatchProps['refreshAdvice'];
  verification?: VerificationConfig;
}) {
  const client = useContext(QueryClientContext);
  const observationStore = client ? browserObservation(client) : undefined;
  const observation = useSyncExternalStore(
    observationStore?.subscribe ?? noSubscribe,
    observationStore?.getSnapshot ?? readUnknownObservation,
    observationStore?.getServerSnapshot ?? readUnknownObservation,
  );
  const sessionState = client?.getQueryState(['session']);
  const session = normalizeSessionObservation(client?.getQueryData(['session']));
  const sessionKnown = !client || sessionState?.status === 'success';
  const sessionMatches = Boolean(
    client &&
    sessionKnown &&
    reader !== null &&
    session.state === 'signed-in' &&
    session.subject === reader &&
    observation.state === 'signed-in' &&
    observation.observation.subject === reader,
  );
  const advice = thread.actions;
  const watchAdvice = advice?.watch;
  const currentWatch = watchAdvice?.state === 'current' ? watchAdvice : null;
  const watchAdviceState =
    watchAdvice?.state === 'empty' || watchAdvice?.state === 'denied' || watchAdvice?.state === 'unavailable'
      ? watchAdvice.state
      : undefined;
  const canReact =
    advice?.reaction === 'available' &&
    reader !== null &&
    sessionMatches &&
    thread.reactions !== undefined &&
    thread.viewerReaction !== undefined &&
    reactionsAsOf !== null;
  const canWatch = currentWatch !== null && reader !== null && sessionMatches;
  const canShowWatchAdvice = watchAdviceState !== undefined && reader !== null && sessionMatches;
  const lifetime = useSubjectCommunityLifetime({
    subjectId: subject.id,
    contextId,
    reader,
    route: href,
    source,
    targetId: thread.id,
    ready: canReact || canWatch || canShowWatchAdvice,
    locale,
    credentialEpoch:
      observation.state === 'signed-in' && observation.observation.subject === reader
        ? String(observation.observation.id)
        : null,
  });
  const readAuthority = useMemo(() => Object.freeze({}), [lifetime.key]);
  const options = { locale: locale as never };
  const replyHref = `${href}${href.includes('#') ? '' : '#reply'}`;
  const reactionSignIn = advice?.reaction === 'sign_in_required' && reader === null;
  const watchSignIn = advice?.watch?.state === 'sign_in_required' && reader === null;
  const showReply =
    (advice?.reply === 'available' && reader !== null && sessionMatches) ||
    (advice?.reply === 'sign_in_required' && reader === null);
  const showOverflow = advice?.overflow === true;

  if (!showReply && !canReact && !reactionSignIn && !canWatch && !canShowWatchAdvice && !watchSignIn && !showOverflow)
    return null;
  return (
    <div data-slot="community-actions" className="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
      {showReply && advice?.reply === 'available' ? (
        <a className={actionClass} href={replyHref}>
          {m.feed_action_reply({}, options)}
        </a>
      ) : showReply ? (
        <SignInPrompt returnTo={replyHref} label={m.feed_action_reply({}, options)} compact />
      ) : null}
      {canReact ? (
        <ThreadReactions
          target={{ kind: 'thread', id: thread.id }}
          counts={thread.reactions!}
          value={thread.viewerReaction!}
          signedIn
          returnTo={replyHref}
          personalReady
          reactionOrigin={lifetime}
          readAuthority={readAuthority}
          queueChanges={false}
          settleWithRead
          sourceWatermark={reactionsAsOf!}
          presentation="chips"
          locale={locale}
          {...(preparedTransport ? { preparedTransport } : {})}
        />
      ) : reactionSignIn ? (
        <SignInPrompt returnTo={replyHref} label={m.reaction_react({}, options)} compact />
      ) : null}
      {canWatch ? (
        <ThreadWatch
          threadId={thread.id}
          session="signed-in"
          sessionKnown
          viewerId={reader!}
          sessionStamp={source}
          admitted
          returnTo={replyHref}
          {...(currentWatch ? { initialWatching: currentWatch.watching } : {})}
          readAuthority={readAuthority}
          isCurrent={lifetime.isCurrent}
          {...(refreshAdvice ? { refreshAdvice } : {})}
          {...(preparedWatch ? { native: preparedWatch } : {})}
        />
      ) : canShowWatchAdvice ? (
        <ThreadWatch
          threadId={thread.id}
          session="signed-in"
          sessionKnown
          viewerId={reader!}
          sessionStamp={source}
          admitted
          returnTo={replyHref}
          adviceState={watchAdviceState!}
          readAuthority={readAuthority}
          isCurrent={lifetime.isCurrent}
          {...(refreshAdvice ? { refreshAdvice } : {})}
          {...(preparedWatch ? { native: preparedWatch } : {})}
        />
      ) : watchSignIn ? (
        <SignInPrompt returnTo={replyHref} label={m.thread_watch_anonymous({}, options)} compact />
      ) : null}
      {showOverflow && verification ? (
        <PostActions target={{ kind: 'thread', id: thread.id }} canonicalHref={href} verification={verification} />
      ) : showOverflow ? (
        <a className={actionClass} href={href}>
          {m.report_more({}, options)}
        </a>
      ) : null}
    </div>
  );
}

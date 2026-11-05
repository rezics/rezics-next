import { ArrowBigDownIcon, ArrowBigUpIcon } from 'lucide-react';
import { ThreadReactions, type ThreadReactionsProps } from '../../threads/thread-reactions';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';

export type FeedReaction = Omit<ThreadReactionsProps, 'signedIn' | 'returnTo' | 'presentation' | 'locale'>;

/** Presentation only: every installed vote uses ThreadReactions' existing command and retirement engine. */
export function VoteControl({
  reaction,
  signedIn,
  href,
  locale,
  plain = false,
  presentation,
}: {
  reaction?: FeedReaction | undefined;
  signedIn: boolean;
  href?: string | undefined;
  locale: string;
  plain?: boolean | undefined;
  presentation?: ThreadReactionsProps['presentation'];
}) {
  const options = { locale: locale as Locale };
  if (reaction && href)
    return (
      <ThreadReactions
        {...reaction}
        signedIn={signedIn}
        returnTo={href}
        locale={locale}
        presentation={presentation ?? (plain ? 'vote-plain' : 'vote')}
        settleWithRead={reaction.settleWithRead ?? true}
      />
    );
  const signIn = `/${locale}/auth/sign-in?return_to=${encodeURIComponent(href ?? `/${locale}/`)}`;
  const arrow = (direction: 'upvote' | 'downvote') => {
    const Icon = direction === 'upvote' ? ArrowBigUpIcon : ArrowBigDownIcon;
    const label = direction === 'upvote' ? m.reaction_upvote({}, options) : m.reaction_downvote({}, options);
    const className =
      'inline-flex min-h-11 min-w-11 items-center justify-center rounded-full text-muted-foreground outline-none focus-visible:ring-2 focus-visible:ring-ring sm:min-h-8 sm:min-w-8 pointer-coarse:min-h-11 pointer-coarse:min-w-11';
    return signedIn ? (
      <button type="button" disabled className={className} aria-label={label}>
        <Icon aria-hidden className="size-5 opacity-50" />
      </button>
    ) : (
      <a href={signIn} className={className} aria-label={label}>
        <Icon aria-hidden className="size-5" />
      </a>
    );
  };
  return (
    <div
      role="group"
      aria-label={m.feed_action_votes_unavailable({}, options)}
      data-slot="vote-unavailable"
      title={m.feed_action_votes_unavailable({}, options)}
      className={`inline-flex items-center rounded-full ${plain ? '' : 'bg-muted/70'}`}
    >
      {arrow('upvote')}
      <span className="min-w-8 px-1 text-center text-sm" aria-label={m.feed_action_votes_unavailable({}, options)}>
        —
      </span>
      {arrow('downvote')}
    </div>
  );
}

import { websiteSignInHref } from '../../session/return-target';
import { ArrowBigDownIcon, ArrowBigUpIcon } from 'lucide-react';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
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
  const signIn = websiteSignInHref(href ?? `/${locale}`);
  const arrow = (direction: 'upvote' | 'downvote') => {
    const Icon = direction === 'upvote' ? ArrowBigUpIcon : ArrowBigDownIcon;
    const label = direction === 'upvote' ? m.reaction_upvote({}, options) : m.reaction_downvote({}, options);
    const className = buttonVariants({ variant: 'ghost', size: 'icon-sm' });
    return signedIn ? (
      <Button type="button" variant="ghost" size="icon-sm" disabled aria-label={label}>
        <Icon aria-hidden />
      </Button>
    ) : (
      <a href={signIn} className={className} aria-label={label}>
        <Icon aria-hidden />
      </a>
    );
  };
  return (
    <div
      role="group"
      aria-label={m.feed_action_votes_unavailable({}, options)}
      data-slot="vote-unavailable"
      data-plain={plain ? 'true' : undefined}
      title={m.feed_action_votes_unavailable({}, options)}
      className="inline-flex items-center"
    >
      {arrow('upvote')}
      <span className="min-w-8 px-1 text-center text-sm" aria-label={m.feed_action_votes_unavailable({}, options)}>
        —
      </span>
      {arrow('downvote')}
    </div>
  );
}

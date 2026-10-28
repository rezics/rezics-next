import { Reactions, type ReactionKind } from '@rezics/ui/reactions';
import { useEffect, useState } from 'react';
import { flushSync } from 'react-dom';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { csrfHeaders } from './composer';
import { changeReaction } from './reactions';
import { subjectReactionKinds, type ReactionFailure } from './reaction-request';

function reactionLabels(failed: string | null) {
  return {
    upvote: m.reaction_upvote(),
    downvote: m.reaction_downvote(),
    like: m.reaction_like(),
    love: m.reaction_love(),
    laugh: m.reaction_laugh(),
    insightful: m.reaction_insightful(),
    sad: m.reaction_sad(),
    react: m.reaction_react(),
    reactions: m.reaction_reactions(),
    choose: m.reaction_choose(),
    failed: failed ?? m.reaction_failed(),
  };
}

function refusalText(failure: ReactionFailure): string {
  switch (failure.reason) {
    case 'closed':
      return m.platform_closed_message();
    case 'forbidden':
      return m.reaction_forbidden();
    case 'invalid':
      return m.reaction_invalid();
    case 'rate-limited':
      return m.reaction_rate_limited({ seconds: failure.retryAfter ?? 1 });
    default:
      return m.reaction_unavailable();
  }
}

// The menu stays open for another choice. A click outside it, such as the pressed chip, closes it
// so the panel does not cover the next post's React button.
function installSingleReactionMenu() {
  if (typeof document === 'undefined' || document.documentElement.dataset.reactionMenu === 'ready') return;
  document.documentElement.dataset.reactionMenu = 'ready';
  document.addEventListener('click', (event) => {
    const target = event.target;
    if (!(target instanceof Element) || target.closest('[data-slot="popover-content"], [data-slot="popover-trigger"]'))
      return;
    for (const trigger of document.querySelectorAll(
      '[data-slot="reactions"] [data-slot="popover-trigger"][data-popup-open]',
    )) {
      if (trigger instanceof HTMLElement) trigger.click();
    }
  });
}

export function ThreadReactions({
  target,
  counts,
  value,
  signedIn,
  returnTo,
  onMutation,
  personalReady = true,
}: {
  target: { kind: 'thread' | 'post' | 'subject'; id: string };
  counts: Partial<Record<ReactionKind, number>>;
  value: ReactionKind | null;
  signedIn: boolean;
  returnTo: string;
  onMutation?: () => Promise<void>;
  personalReady?: boolean;
}) {
  const [failed, setFailed] = useState<string | null>(null);
  const [hydrated, setHydrated] = useState(false);
  useEffect(() => {
    setHydrated(true);
    if (signedIn) installSingleReactionMenu();
  }, [signedIn]);

  async function onChange(kind: ReactionKind | null) {
    let result: { ok: true } | ReactionFailure;
    try {
      result = await changeReaction({
        data: { target: target.kind, id: target.id, kind },
        headers: csrfHeaders(),
      });
    } catch {
      const message = m.reaction_unavailable();
      flushSync(() => setFailed(message));
      throw new Error(message);
    }
    if (!result.ok) {
      const message = refusalText(result);
      flushSync(() => setFailed(message));
      throw new Error(message);
    }
    await onMutation?.();
  }

  return (
    <Reactions
      counts={counts}
      disabled={!hydrated || !personalReady}
      {...(target.kind === 'subject' ? { kinds: subjectReactionKinds, collapse: 2 } : {})}
      labels={reactionLabels(failed)}
      locale={getLocale()}
      onChange={onChange}
      value={value}
      {...(signedIn ? {} : { signInHref: `/auth/sign-in?return_to=${encodeURIComponent(returnTo)}` })}
    />
  );
}

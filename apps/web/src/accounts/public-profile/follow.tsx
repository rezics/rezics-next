import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useSession } from '../../session/query';
import { SignInPrompt } from '../../threads/write-prompts';
import { m } from '../../paraglide/messages.js';

const FollowTargetControl = lazy(async () => {
  const producer = await import('../../library/follow-target-control');
  return { default: producer.FollowTargetControl };
});
const subscribe = () => () => {};

/** Relationship state starts after hydration; Commerce keeps the actual control, queries and writes. */
type AccountFollowProps = { targetId: string; accountId: string; returnTo: string };

export function AccountFollow(props: AccountFollowProps) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return hydrated ? <CurrentAccountFollow {...props} /> : null;
}

function CurrentAccountFollow({ targetId, accountId, returnTo }: AccountFollowProps) {
  const session = useSession();
  if (session.state === 'signed-out') return <SignInPrompt compact label={m.library_follow()} returnTo={returnTo} />;
  if (session.state !== 'signed-in' || session.subject === accountId) return null;
  return (
    <Suspense fallback={null}>
      <FollowTargetControl targetId={targetId} />
    </Suspense>
  );
}

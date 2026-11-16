import { lazy, Suspense, useSyncExternalStore } from 'react';
import { useSession } from '../../session/query';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { websiteSignInHref } from '../../session/return-target';
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
  if (session.state === 'signed-out') {
    return (
      <a
        href={websiteSignInHref(returnTo)}
        className={`${buttonVariants({ variant: 'outline', size: 'sm' })} h-auto min-h-6 max-w-full whitespace-normal`}
      >
        {m.library_follow()}
      </a>
    );
  }
  if (session.state !== 'signed-in' || session.subject === accountId) return null;
  return (
    <Suspense fallback={null}>
      <FollowTargetControl targetId={targetId} />
    </Suspense>
  );
}

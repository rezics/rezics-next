import { lazy, Suspense, useSyncExternalStore } from 'react';

const FollowTargetControl = lazy(async () => {
  const producer = await import('../../library/follow-target-control');
  return { default: producer.FollowTargetControl };
});
const subscribe = () => () => {};

/** Relationship state starts after hydration; Commerce keeps the actual control, queries and writes. */
export function AccountFollow({ targetId }: { targetId: string }) {
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return hydrated ? (
    <Suspense fallback={null}>
      <FollowTargetControl targetId={targetId} />
    </Suspense>
  ) : null;
}

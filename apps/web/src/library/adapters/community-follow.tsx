import { FollowTargetControl } from '../follow-target-control';

/** Community follows the carrying Space through Library's existing current-reader command owner. */
export function CommunityFollow({ targetId }: { targetId: string }) {
  return <FollowTargetControl targetId={targetId} />;
}

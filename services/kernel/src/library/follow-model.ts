import type { FollowTargetType } from './contract/index.ts';
export type { FollowTargetType } from './contract/index.ts';
export type FollowState = 'following' | 'unfollowed';
export type FollowReason = 'explicit' | 'library' | 'membership';
export type FollowIntent = 'implied' | 'follow' | 'unfollow';

/** Database projection for one follower-target pair. */
export type FollowRow = {
  route: number;
  accountId: string;
  targetId: string;
  targetType: string;
  state: string;
  reason: string;
  createdAt: string;
  updatedAt: string;
  transactionId: string;
};

/** Private view returned to the follower's library code. */
export type Follow = Omit<FollowRow, 'route' | 'targetType' | 'state' | 'reason'> & {
  targetType: FollowTargetType;
  state: FollowState;
  reason: FollowReason;
};

export type FollowPageCursor = Pick<Follow, 'updatedAt' | 'targetId'>;
export type FollowPage = { after: FollowPageCursor | null; limit: number; targetType?: FollowTargetType };

export type ApplyFollowInput = {
  accountId: string;
  targetId: string;
  targetType: FollowTargetType;
  intent: FollowIntent;
  reason: FollowReason;
  transactionId: string;
  time: string;
};

export const MAX_FOLLOW_PAGE_SIZE = 100;

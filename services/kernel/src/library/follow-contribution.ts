import type { Pool } from 'pg';
import { agentContributionAttribution, type ContributionAttribution } from '../access/public-identity.ts';

type FollowWithContribution<T extends object> = 'target' extends keyof T
  ? T extends { target: infer Target }
    ? Omit<T, 'target'> & { target: Target | Exclude<ContributionAttribution, null> }
    : Omit<T, 'target'> & {
        target?: (T extends { target?: infer Target } ? Target : never) | Exclude<ContributionAttribution, null>;
      }
  : T & { target: Exclude<ContributionAttribution, null> };

/** Agent-subject follows present the bound account as contribution attribution. */
export async function followContributionTarget(
  pool: Pool,
  targetId: string,
  targetType: string,
): Promise<ContributionAttribution | null> {
  if (targetType !== 'subject') return null;
  return agentContributionAttribution(pool, targetId);
}

/** Apply the public agent projection without undoing FULL's current Source gate. */
export function withFollowContribution<T extends object>(
  follow: T,
  contribution: ContributionAttribution | null,
  full: boolean,
): FollowWithContribution<T> {
  if ((full && 'target' in follow && follow.target === null) || contribution === null)
    return follow as FollowWithContribution<T>;
  return { ...follow, target: contribution } as FollowWithContribution<T>;
}

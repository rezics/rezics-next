import type { Pool } from 'pg';
import { agentContributionAttribution, type ContributionAttribution } from '../access/public-identity.ts';

/** Agent-subject follows present the bound account as contribution attribution. */
export async function followContributionTarget(
  pool: Pool,
  targetId: string,
  targetType: string,
): Promise<ContributionAttribution | null> {
  if (targetType !== 'subject') return null;
  return agentContributionAttribution(pool, targetId);
}

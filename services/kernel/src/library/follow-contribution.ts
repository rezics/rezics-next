import type { Pool } from 'pg';
import { contributionAttribution, type ContributionAttribution } from '../access/contribution-attribution.ts';
import { readPublicAccount, readPublicAccountByAgent } from '../access/account-data.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import { accountAgentsForSubjects } from '../semantic/agents.ts';

/** Agent-subject follows present the bound account as contribution attribution. */
export async function followContributionTarget(
  pool: Pool,
  targetId: string,
  targetType: string,
): Promise<ContributionAttribution | null> {
  if (targetType !== 'subject') return null;
  const identities = await readPublicAccountByAgent(pool, targetId);
  if (identities[0]) return contributionAttribution(identities[0]);
  const links = await withConnection(pool, (client) => accountAgentsForSubjects(client, [targetId]));
  const accountId = links.get(targetId)?.account;
  if (!accountId) return null;
  const route = routeOf(accountId);
  if (route === null) return null;
  const account = await withConnection(pool, (client) => readPublicAccount(client, route, accountId));
  return contributionAttribution(account ?? { accountId, state: 'deleted' });
}

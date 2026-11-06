import type { Pool } from 'pg';
import {
  minimizeAgentIdentityRetention,
  type AgentIdentitySourceRole,
  type AgentIdentityRetentionDependencies,
} from './agent-verification-identity-retention.ts';
import { type AgentIdentitySourceKey, type HistoryBarrier } from '../history/contract/index.ts';

/** Adapter for the existing scalar inventory's exact native key order. Discovery is never
 * consumption, and one cleanup invocation accepts at most eight keys from one physical home.
 */
export function minimizeDiscoveredAgentIdentitySources(
  pool: Pool,
  input: Readonly<{
    barrier: HistoryBarrier;
    role: AgentIdentitySourceRole;
    keys: readonly (readonly string[])[];
  }>,
  deps?: AgentIdentityRetentionDependencies,
) {
  const keys: AgentIdentitySourceKey[] = input.keys.map((key) => {
    if (key.length !== 4 || !/^(0|[1-9][0-9]{0,4})$/.test(key[0]!))
      throw new TypeError('Invalid discovered native identity source key');
    const [route, accountId, direction, receiptId] = key;
    if (direction !== 'account-agent.verify' && direction !== 'account-agent.unverify')
      throw new TypeError('Invalid discovered native identity source direction');
    return {
      route: Number(route),
      accountId: accountId!,
      direction,
      receiptId: receiptId!,
    };
  });
  return minimizeAgentIdentityRetention(pool, { barrier: input.barrier, role: input.role, keys }, deps);
}

import type { Pool } from 'pg';
import type { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { authoritativeTimeValue, runCommand, type CommandAuthorization } from '../command/command.ts';
import { withConnection } from '../database/pool.ts';
import { routeOf } from '../route/route.ts';
import accountRead from './bootstrap-governance-account.sql';
import bootstrapRead from './bootstrap-governance-read.sql';
import install from './bootstrap-governance-install.sql';

export const PLATFORM_GOVERNANCE_ROLE = 'platform.governance';
// Bind the existing Global identity without loading Semantic's runtime command dependencies.
export const PLATFORM_RESOURCE = Object.freeze({
  route: 0,
  id: '00000000-0000-8000-8000-000000000000' satisfies typeof GLOBAL_CONTEXT,
} as const);

export class BootstrapGovernanceUnavailableError extends Error {
  constructor() {
    super('Operator governance bootstrap is unavailable');
    this.name = 'BootstrapGovernanceUnavailableError';
  }
}

export type BootstrapGovernanceResult = {
  accountId: string;
  role: typeof PLATFORM_GOVERNANCE_ROLE;
  resource: typeof PLATFORM_RESOURCE;
  replayed: boolean;
};

// Private control flow ends the native read transaction without a receipt,
// partition fence or event. It cannot be supplied as an authorization capability.
class AlreadyBootstrapped extends Error {}

/** Deployment-only authority. No HTTP actor, fabricated principal, or reusable
 * authorization switch exists. Account evidence is prepared on its own anchor
 * at each native attempt's T and released before checking out Global.
 */
export async function bootstrapGovernance(pool: Pool, accountId: string): Promise<BootstrapGovernanceResult> {
  const route = routeOf(accountId);
  if (route === null) throw new BootstrapGovernanceUnavailableError();
  const value: Omit<BootstrapGovernanceResult, 'replayed'> = {
    accountId,
    role: PLATFORM_GOVERNANCE_ROLE,
    resource: PLATFORM_RESOURCE,
  };
  const deadline = Date.now() + 10_000;
  const authorization: CommandAuthorization = {
    action: 'access:grant',
    resource: PLATFORM_RESOURCE,
    denied: () => new BootstrapGovernanceUnavailableError(),
    async prepare(attempt) {
      const at = authoritativeTimeValue(attempt.time);
      const account = await withConnection(pool, (client) =>
        accountRead.run(client, { route, account_id: accountId, at }),
      );
      if (!account?.eligible || Date.now() >= deadline) throw new BootstrapGovernanceUnavailableError();
    },
    async authorize(tx) {
      const current = await bootstrapRead.run(tx, {
        route: PLATFORM_RESOURCE.route,
        resource_id: PLATFORM_RESOURCE.id,
      });
      if (!current?.global) throw new BootstrapGovernanceUnavailableError();
      if (current.account_id !== null) {
        if (current.account_id !== accountId) throw new BootstrapGovernanceUnavailableError();
        throw new AlreadyBootstrapped();
      }
      return 'execute';
    },
  };
  // A concurrent unique-key insert may report 23505 before core's serializable
  // fence detects the conflict. Re-enter the native executor to read the winner;
  // all other failures are closed, and every failed attempt rolls back completely.
  for (let conflict = 0; conflict < 3; conflict++) {
    try {
      await runCommand(pool, { partition: 0, deadline, authorization }, async (tx, { transactionId }) => {
        const rows = await install.run(tx, {
          route: PLATFORM_RESOURCE.route,
          resource_id: PLATFORM_RESOURCE.id,
          account_id: accountId,
          role: PLATFORM_GOVERNANCE_ROLE,
          transaction_id: transactionId,
        });
        if (rows.length !== 1) throw new BootstrapGovernanceUnavailableError();
        return {
          value,
          events: [
            { type: 'com.rezics.access.governance.bootstrapped.v1', subject: PLATFORM_RESOURCE.id, data: value },
          ],
        };
      });
      return { ...value, replayed: false };
    } catch (error) {
      if (error instanceof AlreadyBootstrapped) return { ...value, replayed: true };
      if (typeof error === 'object' && error !== null && 'code' in error && error.code === '23505') continue;
      throw new BootstrapGovernanceUnavailableError();
    }
  }
  throw new BootstrapGovernanceUnavailableError();
}

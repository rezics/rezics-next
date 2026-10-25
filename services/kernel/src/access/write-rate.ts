import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';

export type WriteRateFamily = 'write' | 'upload' | 'report' | 'correspondence' | 'search' | 'provider' | 'address';
export type AccountRateClass = 'anonymous' | 'new-account' | 'member' | 'trusted' | 'service';
export type WriteRateContext = { pool: Pool; actor: Actor; deadline: number };
/** retryAfter is the delay in seconds before retrying a refused spend. */
export type WriteRateDecision = { allowed: true } | { allowed: false; retryAfter: number };

/**
 * Request-stage contract, before any command runs. Subject imports and batchWrite
 * use 'write': a bulk of 100 spends 100 units in ONE atomic call. A refusal spends
 * nothing. Command execution and retries must not spend again per command.
 *
 * The trusted implementation resolves account class from verified account evidence
 * or bounded trusted policy, without representation, team or all-grant walks.
 * A person's token retains that account's class during imports. Only an explicitly
 * registered service account qualifies for service; clientId, scopes and request
 * JSON confer no class. Anonymous identity attribution belongs to the trusted HTTP
 * stage, without dummy accounts or receipt keys.
 *
 * The intended store updates one global UNLOGGED counter key per identity+family
 * with one atomic upsert, regardless of units (at most 100). This contract and its
 * unavailable implementation perform no SQL and prove no enforcement or store cost.
 */
export type WriteRateLimiter = {
  /** units defaults to 1 and must be a positive safe integer no greater than 100. */
  spend(context: WriteRateContext, family: WriteRateFamily, units?: number): Promise<WriteRateDecision>;
};

export class WriteRateUnavailableError extends Error {
  constructor() {
    super('Write rate enforcement is unavailable');
    this.name = 'WriteRateUnavailableError';
  }
}

/**
 * Temporary fail-closed factory. There are no configurable policy overrides.
 * Structural consumer injection is for contract tests only, not enforcement proof.
 * Construction and validation are O(1) in subjects, history, activity and media.
 */
export function createWriteRateLimiter(_config?: Record<string, never>): WriteRateLimiter {
  return {
    async spend(context, family, units = 1) {
      if (
        typeof context !== 'object' ||
        context === null ||
        typeof context.pool !== 'object' ||
        context.pool === null ||
        typeof context.actor !== 'object' ||
        context.actor === null ||
        (context.actor.kind !== 'anonymous' && context.actor.kind !== 'account') ||
        !Number.isFinite(context.deadline)
      )
        throw new TypeError('A write rate context requires a pool, actor and finite deadline');
      switch (family) {
        case 'write':
        case 'upload':
        case 'report':
        case 'correspondence':
        case 'search':
        case 'provider':
        case 'address':
          break;
        default:
          throw new TypeError('Unknown write rate family');
      }
      if (!Number.isSafeInteger(units) || units <= 0 || units > 100)
        throw new RangeError('Write rate units must be a positive safe integer no greater than 100');
      throw new WriteRateUnavailableError();
    },
  };
}

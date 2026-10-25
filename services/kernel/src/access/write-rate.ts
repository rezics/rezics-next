import type { Pool } from 'pg';
import type { Actor } from '../request/access.ts';
import { deadlineClient } from './authenticate.ts';
import { families, rateLimitBudgets } from './write-rate-budgets.ts';
import { spendWriteRateCounter } from './write-rate-counter.ts';
import { rateIdentity } from './write-rate-identity.ts';

export type WriteRateFamily = 'write' | 'upload' | 'report' | 'correspondence' | 'search' | 'provider' | 'address';
export type AccountRateClass = 'anonymous' | 'new-account' | 'member' | 'trusted' | 'service';
export type WriteRateContext = { pool: Pool; actor: Actor; deadline: number };
/** retryAfter is the delay in seconds before retrying a refused spend. */
export type WriteRateDecision = { allowed: true } | { allowed: false; retryAfter: number };

/** Request-stage admission only; success never confers authorization.
 * A bulk reserves all native command units once, before any command runs.
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

export type WriteRateConfig = {
  /** Deployment secret, at least 32 bytes. Never supplied by a request. */
  secret?: string;
  /** Strict partial RATE_LIMIT_V1 overrides encoded as JSON. */
  overrides?: string;
};

/** One native routed point upsert; no classification query, sweep or receipt. */
export function createWriteRateLimiter(config: WriteRateConfig = {}): WriteRateLimiter {
  const secret = config.secret ?? process.env.KERNEL_WRITE_RATE_SECRET;
  if (secret !== undefined && (typeof secret !== 'string' || Buffer.byteLength(secret) < 32))
    throw new TypeError('Write rate secret must contain at least 32 bytes');
  const budgets = rateLimitBudgets(config.overrides ?? process.env.KERNEL_WRITE_RATE_OVERRIDES ?? '{}');
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
      if (!families.includes(family)) throw new TypeError('Unknown write rate family');
      if (!Number.isSafeInteger(units) || units <= 0 || units > 100)
        throw new RangeError('Write rate units must be a positive safe integer no greater than 100');
      try {
        if (!secret) throw new WriteRateUnavailableError();
        const identity = rateIdentity(context, secret);
        return await spendWriteRateCounter(deadlineClient(context.pool, identity.deadline), {
          route: identity.route,
          identityDigest: identity.identityDigest,
          family,
          units,
          budget: budgets[identity.rateClass][family],
        });
      } catch {
        throw new WriteRateUnavailableError();
      }
    },
  };
}

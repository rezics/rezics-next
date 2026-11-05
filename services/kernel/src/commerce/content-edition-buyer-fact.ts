import type { Pool } from 'pg';
import {
  createContentEditionBuyerFact,
  copyContentEditionBenefit,
  contentEditionBenefitBinding,
  type ContentEditionBuyerFactReader,
} from '../access/authenticated-benefit.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { readAccount } from '../access/account-data.ts';
import { requireAccessDeadline, throwAccessUnavailable } from '../access/unavailable.ts';
import type { KernelClock } from '../clock.ts';
import { authoritativeTimeValue } from '../command/command.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { readPartition } from '../partition/partition.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { decodeCapturedContentEdition } from './benefit.ts';
import lookup from './content-edition-buyer-fact.sql';

export type { ContentEditionBuyerFactReader } from '../access/authenticated-benefit.ts';

/** Native current buyer-home reader; no Content callback or retained permission evidence. */
export function createContentEditionBuyerFactReader(config: {
  pool: Pool;
  clock?: KernelClock;
}): ContentEditionBuyerFactReader {
  // The supplied live T is the sole domain time. In particular, the configured
  // kernel clock must never replace it or extend its caller's request budget.
  return async (input) => {
    const { buyerAccountId, time, deadline } = input;
    const at = authoritativeTimeValue(time);
    if (!Number.isFinite(deadline)) throw new TypeError('Invalid buyer fact deadline');
    requireAccessDeadline(deadline);
    const route = routeOf(buyerAccountId);
    if (route === null) throw new TypeError('Invalid buyer account');
    const benefit = copyContentEditionBenefit(input.benefit);
    if (routeOf(benefit.version.revisionId) !== benefit.resource.route)
      throw new TypeError('Invalid Content edition revision route');
    try {
      const entitlement = await withConnection(config.pool, async (client) => {
        const bounded = deadlineClient(client, deadline);
        try {
          await bounded.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
          await bounded.query(`SET LOCAL statement_timeout = '${Math.max(1, Math.floor(deadline - Date.now()))}ms'`);
          const partition = await readPartition(bounded, partitionOf(route));
          if (!partition || partition.writeState !== 'active') throw new ProblemError('partition_unavailable');
          const account = await readAccount(bounded, route, buyerAccountId);
          if (
            !account ||
            account.accountId !== buyerAccountId ||
            account.route !== route ||
            account.state !== 'active' ||
            account.fenced ||
            account.minimumAuthnEpoch < 1n ||
            account.createdAt === null ||
            !Number.isFinite(account.createdAt) ||
            account.createdAt > Date.parse(at)
          )
            throw new ProblemError('dependency_unavailable');
          const rows = await lookup.run(bounded, {
            route,
            account_id: buyerAccountId,
            edition_route: String(benefit.resource.route),
            edition_id: benefit.resource.id,
            revision_id: benefit.version.revisionId,
            sha256: benefit.version.sha256,
          });
          // An ambiguous current match cannot select an arbitrary purchase as authority.
          if (rows.length > 1) throw new ProblemError('dependency_unavailable');
          const row = rows[0];
          if (row) {
            const capture = decodeCapturedContentEdition(row.contentEdition);
            if (
              row.accountId !== buyerAccountId ||
              row.route !== route ||
              routeOf(row.id) !== route ||
              routeOf(row.orderId) !== route ||
              routeOf(row.offerId) === null ||
              !Number.isSafeInteger(row.revision) ||
              row.revision < 1 ||
              row.revokedAt !== null ||
              row.revokeReason !== null ||
              !Number.isFinite(Date.parse(row.grantedAt)) ||
              Date.parse(row.grantedAt) > Date.parse(at) ||
              !capture ||
              capture.targetSubjectId !== row.targetSubjectId ||
              contentEditionBenefitBinding(capture.benefit) !== contentEditionBenefitBinding(benefit) ||
              routeOf(capture.source.threadId) !== benefit.resource.route ||
              routeOf(capture.source.postId) !== benefit.resource.route ||
              routeOf(capture.benefit.version.revisionId) !== benefit.resource.route
            )
              throw new ProblemError('dependency_unavailable');
          }
          authoritativeTimeValue(time);
          requireAccessDeadline(deadline);
          await bounded.query('COMMIT');
          return row ?? null;
        } catch (error) {
          await client.query('ROLLBACK').catch((failure: Error) => discardConnection(client, failure));
          throw error;
        }
      });
      // Issue only after COMMIT and release: no native checkout spans the
      // Accounts issuer, permission evaluation or Content's independent guards.
      authoritativeTimeValue(time);
      requireAccessDeadline(deadline);
      if (!entitlement) return null;
      return createContentEditionBuyerFact({
        benefit,
        buyerAccountId,
        entitlementId: entitlement.id,
        entitlementRevision: entitlement.revision,
        time,
        deadline,
      });
    } catch (error) {
      throwAccessUnavailable(error, deadline);
      if (error instanceof ProblemError) throw error;
      // Missing capture schema/issuer and malformed current dependencies are
      // unavailable, never a successful empty lookup or structural grant.
      throw new ProblemError('dependency_unavailable');
    }
  };
}

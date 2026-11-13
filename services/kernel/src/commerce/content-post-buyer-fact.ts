import type { Pool } from 'pg';
import {
  contentPostBenefitBinding,
  copyContentPostBenefit,
  createContentPostBuyerFact,
  type ContentPostBuyerFactReader,
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
import { decodeCapturedContentPost } from './benefit.ts';
import lookup from './content-post-buyer-fact.sql';

export type { ContentPostBuyerFactReader } from '../access/authenticated-benefit.ts';

/** Native current buyer-home reader for one stable Post; it never asks Content to authorize bytes. */
export function createContentPostBuyerFactReader(config: {
  pool: Pool;
  clock?: KernelClock;
}): ContentPostBuyerFactReader {
  return async (input) => {
    const { buyerAccountId, time, deadline } = input;
    const at = authoritativeTimeValue(time);
    if (!Number.isFinite(deadline)) throw new TypeError('Invalid buyer fact deadline');
    requireAccessDeadline(deadline);
    const route = routeOf(buyerAccountId);
    if (route === null) throw new TypeError('Invalid buyer account');
    const benefit = copyContentPostBenefit(input.benefit);
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
            benefit: JSON.stringify(benefit),
            post_route: String(benefit.resource.route),
            post_id: benefit.resource.id,
          });
          if (rows.length > 1) throw new ProblemError('dependency_unavailable');
          const row = rows[0];
          if (row) {
            const capture = decodeCapturedContentPost(row.contentPost);
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
              contentPostBenefitBinding(capture.benefit) !== contentPostBenefitBinding(benefit)
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
      authoritativeTimeValue(time);
      requireAccessDeadline(deadline);
      if (!entitlement) return null;
      return createContentPostBuyerFact({
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
      throw new ProblemError('dependency_unavailable');
    }
  };
}

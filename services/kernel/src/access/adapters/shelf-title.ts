import { createHash } from 'node:crypto';
import type { QueryResultRow, Pool } from 'pg';
import { mintReadTime } from '../../command/command.ts';
import { withBoundedReadOnlyTransaction } from '../../database/pool.ts';
import { relatedReadDecisionEligibility } from '../../semantic/eligibility.ts';
import { routeOf } from '../../route/route.ts';
import { prepareReadDecisions, type Access, type AccountActor } from '../check.ts';
import { deadlineClient, requireAccessDeadline, within } from '../deadline.ts';
import type { ContentShelfTitleCurrentAccess } from '../../library/shelf-title-inputs-composition.ts';

const AUTHORITY_HOME_COUNT = 4096;
const ACTION = 'subject:read';
const RESOURCE_TYPE = 'semantic.subject';
const unavailable = { status: 'unavailable' as const };

export type ContentShelfTitleAuthorityRow = QueryResultRow & { homeNo: number; generation: string; epoch: string };

/** Hash the fixed native authority clock, independent of any requested Subject IDs. */
export function contentShelfTitleAccessBasis(rows: readonly ContentShelfTitleAuthorityRow[]): string | null {
  if (rows.length !== AUTHORITY_HOME_COUNT) return null;
  const digest = createHash('sha256').update('content-shelf-title-access-v1\0');
  for (let index = 0; index < AUTHORITY_HOME_COUNT; index++) {
    const row = rows[index];
    if (
      !row ||
      row.homeNo !== index ||
      !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(row.generation) ||
      !/^(0|[1-9][0-9]*)$/.test(row.epoch)
    )
      return null;
    digest.update(`${index}:${row.generation}:${row.epoch}\n`);
  }
  return digest.digest('hex');
}

async function readAccessBasis(pool: Pool, deadline: number) {
  return within(deadline, () =>
    withBoundedReadOnlyTransaction(
      pool,
      deadline,
      async (client) => {
        requireAccessDeadline(deadline);
        const { rows } = await deadlineClient(client, deadline).query<ContentShelfTitleAuthorityRow>(
          `SELECT home_no AS "homeNo",generation::text,epoch::text
           FROM core.publication_authority_epoch ORDER BY home_no`,
        );
        const version = contentShelfTitleAccessBasis(rows);
        return version ? { status: 'current' as const, version } : unavailable;
      },
    ),
  );
}

/** Request-scoped current subject:read decisions on one fixed T and whole-source basis. */
export function createNativeContentShelfTitleCurrentAccess(
  pool: Pool,
  resolveAccess: () => Access,
): ContentShelfTitleCurrentAccess {
  return {
    async begin({ owner, viewer, deadline }) {
      if (
        !Number.isFinite(deadline) ||
        routeOf(owner.accountId) !== owner.route ||
        viewer.kind !== 'account' ||
        viewer.accountId !== owner.accountId
      )
        return unavailable;

      return within(deadline, async () => {
        requireAccessDeadline(deadline);
        // Resolve the completed Kernel action catalogue only when a request uses this producer.
        const access = resolveAccess();
        const start = await readAccessBasis(pool, deadline);
        if (start.status !== 'current') return unavailable;
        const time = await withBoundedReadOnlyTransaction(
          pool,
          deadline,
          (client) => mintReadTime(client),
        );

        const prepare = () =>
          prepareReadDecisions(access, {
            actor: viewer,
            actions: new Set([ACTION]),
            typeActions: new Map([[RESOURCE_TYPE, new Set([ACTION])]]),
            time,
            context: { pool, deadline, time },
          });
        const decisions = await within(deadline, prepare);

        return {
          status: 'current' as const,
          version: start.version,
          async decide(subjects) {
            if (
              !subjects.length ||
              subjects.length > 64 ||
              new Set(subjects).size !== subjects.length ||
              subjects.some((id) => routeOf(id) === null)
            )
              return unavailable;
            const ids = [...subjects];
            const observed = await within(deadline, () =>
              withBoundedReadOnlyTransaction(pool, deadline, (client) =>
                decisions.decide(
                  deadlineClient(client, deadline),
                  {
                    action: ACTION,
                    resourceType: RESOURCE_TYPE,
                    ids,
                    eligibility: relatedReadDecisionEligibility(),
                  },
                  time,
                ),
              ),
            );
            if (!observed || typeof observed !== 'object') return unavailable;
            return {
              status: 'current' as const,
              version: start.version,
              decisions: ids.map((subjectId) => ({ subjectId, allowed: observed[subjectId]?.allowed === true })),
            };
          },
          async currentVersion() {
            // Re-prepare at the same T to revalidate the exact authenticated actor proof at the final observation.
            await within(deadline, prepare);
            return readAccessBasis(pool, deadline);
          },
        };
      });
    },
  };
}

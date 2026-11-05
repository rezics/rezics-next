import type { Pool } from 'pg';
import type { PublicIdentity } from './account-data.ts';
import { ProblemError } from '../http/problem.ts';
import { routeOf } from '../route/route.ts';
import { decodeListCursor, encodeListCursor } from '../tokens/list-cursor.ts';
import type { KeyRing } from '../tokens/seal.ts';
import organizationRead from './organization-speakers-organization.sql';
import pageRead from './organization-speakers-page.sql';
import identitiesRead from './organization-speakers-identities.sql';

export type OrganizationSpeakersPage = { speakers: PublicIdentity[]; next: string | null };

/** Public pages advance by scanned actors, so hidden identities cannot force an unbounded refill. */
export async function readOrganizationSpeakers(
  pool: Pool,
  tokens: KeyRing,
  at: Date,
  input: { accountId: string; limit?: number; cursor?: string; viewer?: string | null },
): Promise<OrganizationSpeakersPage> {
  const empty: OrganizationSpeakersPage = { speakers: [], next: null };
  const route = routeOf(input.accountId);
  if (route === null) return empty;
  const organization = await organizationRead.run(pool, { route, account_id: input.accountId });
  if (!organization?.listed) return empty;

  const limit = input.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  const binding = {
    route: 'GET /v1/accounts/:accountId/speakers',
    viewer: input.viewer ?? null,
    query: { accountId: input.accountId, sort: 'assignedActorId:asc', limit },
  };
  let after = '00000000-0000-0000-0000-000000000000';
  if (input.cursor !== undefined) {
    const decoded = await decodeListCursor(tokens, binding, input.cursor, at);
    if (
      !decoded.ok ||
      decoded.epoch !== 1 ||
      decoded.after.length !== 1 ||
      typeof decoded.after[0] !== 'string' ||
      routeOf(decoded.after[0]) === null
    )
      throw new ProblemError('invalid_cursor');
    after = decoded.after[0];
  }
  const rows = await pageRead.run(pool, {
    route,
    principal_id: input.accountId,
    after,
    at: at.toISOString(),
    limit: limit + 1,
  });
  // Recursive CTE inference is nullable; the source assigned_actor_id column is NOT NULL.
  const page = rows.slice(0, limit).map(({ id }) => id!);
  const identities = await identitiesRead.run(pool, {
    routes: page.map((id) => routeOf(id)!),
    account_ids: page,
  });
  return {
    speakers: identities.map((row) => ({
      ...row,
      kind: row.kind === 'organization' ? 'organization' : 'actor',
      state: 'active',
    })),
    next: rows.length > limit ? await encodeListCursor(tokens, binding, { epoch: 1, after: [page.at(-1)!] }, at) : null,
  };
}

import { mintReadTime } from '../command/command.ts';
import { readAvatarSummaries, type AvatarSummary } from '../content/avatar.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { accessCheck, type Access, type AccessContext, type AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { accessClock } from './access-clock.ts';
import { readAccount, type AccountLink, type AccountPublicViews } from './account-data.ts';
import { deadlineClient, within } from './authenticate.ts';
import { requireAccessDeadline } from './unavailable.ts';
import profileRead from './account-edit-profile-read.sql';

export type EditableAccountProfile = {
  id: string;
  kind: 'actor' | 'organization';
  handle: string | null;
  displayName: string | null;
  bio: string | null;
  links: AccountLink[];
  avatar: AvatarSummary | null;
  publicViews: AccountPublicViews;
  speakersListed?: boolean;
};

/** Private source fields, addressed by immutable account ID, under updateAccount's authority.
 * Preparation and a foreign operator check release their connections before the subject snapshot.
 * This is a read: it neither creates a command attempt nor spends a write operation.
 */
export async function readEditableAccountProfile(
  access: Access,
  context: AccessContext & { actor: AccountActor },
  accountId: string,
): Promise<{ profile: EditableAccountProfile }> {
  const { pool, actor, deadline } = context;
  const route = routeOf(accountId);
  if (route === null || actor.kind !== 'account') throw new ProblemError('forbidden');
  return within(deadline, async () => {
    const bounded = deadlineClient(pool, deadline);
    const acting = await readAccount(bounded, routeOf(actor.accountId)!, actor.accountId);
    if (
      !acting || acting.kind !== 'actor' || acting.state !== 'active' || acting.fenced ||
      !Number.isSafeInteger(actor.authnEpoch) || actor.authnEpoch < 1 ||
      acting.minimumAuthnEpoch > BigInt(actor.authnEpoch)
    ) throw new ProblemError('forbidden');
    const subject = await readAccount(bounded, route, accountId);
    if (!subject || subject.state !== 'active' || subject.fenced) throw new ProblemError('forbidden');
    const operatorId = subject.kind === 'actor' ? subject.operatorAccountId : null;
    const authorityId = operatorId ?? accountId;
    const check = await accessCheck(
      access,
      actor,
      operatorId ? 'account:manage' : 'account:update',
      { route: routeOf(authorityId)!, id: authorityId },
      context,
    );
    // The native formula mints its current T on the authority's released connection.
    // Never execute an operator's permission query while holding the subject anchor.
    if (operatorId) {
      const allowed = await withConnection(pool, async (connection) => {
        const client = deadlineClient(connection, deadline);
        const operator = await readAccount(client, routeOf(operatorId)!, operatorId);
        if (!operator || operator.state !== 'active' || operator.fenced) return false;
        const time = await mintReadTime(client, accessClock(access));
        return check(client, time);
      });
      if (!allowed) throw new ProblemError('forbidden');
    }
    return withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        if (!operatorId) {
          const time = await mintReadTime(client, accessClock(access));
          if (!(await check(client, time))) throw new ProblemError('forbidden');
        }
        const row = await profileRead.run(client, { route, account_id: accountId });
        if (!row || row.kind !== subject.kind || row.operatorAccountId !== subject.operatorAccountId)
          throw new ProblemError('forbidden');
        const views = row.publicViews as Record<string, unknown> | null;
        // Missing or malformed storage never opts an account into public presentation.
        const publicViews = {
          posts: views?.posts === true,
          reviews: views?.reviews === true,
          collections: views?.collections === true,
          realms: views?.realms === true,
        };
        const avatar = row.avatar ? ((await readAvatarSummaries(client, [row.avatar])).get(row.avatar) ?? null) : null;
        const profile: EditableAccountProfile = {
          id: row.id,
          kind: row.kind === 'organization' ? 'organization' : 'actor',
          handle: row.handle,
          displayName: row.displayName,
          bio: row.bio,
          links: (row.links as AccountLink[]).map(({ label, url }) => ({ label, url })),
          avatar,
          publicViews,
          ...(row.kind === 'organization' ? { speakersListed: row.speakersListed } : {}),
        };
        requireAccessDeadline(deadline);
        await client.query('COMMIT');
        return { profile };
      } catch (error) {
        try {
          await connection.query('ROLLBACK');
        } catch (rollbackError) {
          discardConnection(connection, rollbackError as Error);
        }
        throw error;
      }
    });
  });
}

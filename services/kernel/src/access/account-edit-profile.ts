import { readAvatarSummaries, type AvatarSummary } from '../content/avatar.ts';
import { discardConnection, withConnection } from '../database/pool.ts';
import { ProblemError } from '../http/problem.ts';
import { prepareReadDecisions, type Access, type AccessContext, type AccountActor } from '../request/access.ts';
import { routeOf } from '../route/route.ts';
import { type AccountLink, type AccountPublicViews } from './account-data.ts';
import { viewerActionReadTime } from './index.ts';
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
    const actions = new Set(['account:read', 'account:update', 'account:manage']);
    const decisions = await prepareReadDecisions(access, {
      actor,
      actions,
      typeActions: new Map([['access.account', actions]]),
      context,
    });
    if (!decisions.prepareAccountAuthority) throw new ProblemError('dependency_unavailable');
    const authority = await decisions.prepareAccountAuthority([accountId]);
    const time = viewerActionReadTime(access, context);
    return withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const answer = await authority.decide(
          client,
          { kind: 'profile', action: 'account:update', ids: [accountId] },
          time,
        );
        if (!answer[accountId]?.allowed) throw new ProblemError('forbidden');
        const row = await profileRead.run(client, { route, account_id: accountId });
        if (!row) throw new ProblemError('forbidden');
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

import type { Pool, PoolClient } from 'pg';
import { mintReadTime, type AuthoritativeTime } from '../command/command.ts';
import { createHash } from 'node:crypto';
import { deadlineClient, within } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { accessCheck, type Actor } from '../request/access.ts';
import { partitionOf, routeOf } from '../route/route.ts';
import { GLOBAL_CONTEXT } from '../semantic/definitions.ts';
import { globalContextAnchor } from '../semantic/context.ts';
import type { ContentReadDependencies } from './reads.ts';
import { readRealmBoard } from './boards.ts';
import type { ModerationDirectoryPage } from './moderation-directory-schemas.ts';

export type ModerationDirectoryItem = Extract<ModerationDirectoryPage, { state: 'ready' }>['items'][number];
export type ModerationDirectoryScope = ModerationDirectoryItem['scope'];
export type ModerationScopeObservation = Readonly<{
  item: ModerationDirectoryItem;
  /** Server-only original identity/security witness; never a public authority. */
  witness: string;
}>;

/** Resource-local read only: prepare foreign evidence before opening a native
 * resource snapshot, and release the checkout before any further foreign work.
 */
async function exact<T>(
  pool: Pool,
  id: string,
  deadline: number,
  read: (client: PoolClient, time: AuthoritativeTime) => Promise<T>,
): Promise<Readonly<{ epoch: number; value: T }> | null> {
  const route = routeOf(id);
  if (route === null) return null;
  return within(deadline, () =>
    withConnection(pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      try {
        await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
        const partition = await readPartition(client, partitionOf(route));
        if (!partition || partition.writeState === 'moved') {
          await client.query('COMMIT');
          return null;
        }
        const time = await mintReadTime(client);
        const value = await read(client, time);
        await client.query('COMMIT');
        return { epoch: partition.epoch, value };
      } catch (error) {
        await connection.query('ROLLBACK');
        throw error;
      }
    }),
  );
}
const digest = (value: unknown) => createHash('sha256').update(JSON.stringify(value)).digest('base64url');

/** Exact existing queue authority and original native parent disclosure. This
 * does not read report, appeal, decision or case rows. Null conceals an unknown,
 * removed or unreadable exact source identically; an HTTP adapter uses 404.
 * Call again at final composition and compare the ORIGINAL witness.
 */
export async function observeNativeModerationScope(
  deps: ContentReadDependencies,
  actor: Actor,
  scope: ModerationDirectoryScope,
  deadline: number,
): Promise<ModerationScopeObservation | null> {
  if (actor.kind !== 'account') return null;
  const id = scope.kind === 'catalogue' ? GLOBAL_CONTEXT : scope.id;
  const route = routeOf(id);
  if (route === null) return null;
  const first = scope.kind === 'board' ? await readRealmBoard(deps, id, { actor, deadline }) : null;
  if (scope.kind === 'board' && (!first?.value || first.value.availability !== 'available')) return null;
  const check = await accessCheck(
    deps.access,
    actor,
    'moderation:read_reports',
    scope.kind === 'catalogue' ? globalContextAnchor.resource : { route, id },
    { pool: deps.pool, deadline },
  );
  const authorized = await exact(
    deps.pool,
    id,
    deadline,
    async (client, time) =>
      (scope.kind !== 'catalogue' || (await globalContextAnchor.validate(client, time))) && (await check(client, time)),
  );
  if (!authorized?.value) return null;
  if (scope.kind === 'catalogue')
    return {
      item: {
        scope: { kind: 'catalogue' },
        label: 'Catalogue',
        parent: null,
        queues: ['reports', 'resolved'],
        viewer: { open: 'permitted' },
      },
      witness: digest(['catalogue', authorized.epoch]),
    };
  // Native disclosure is observed after Access foreign work. Never replace the
  // initial source witness with a newly renamed or reparented source.
  const final = await readRealmBoard(deps, id, { actor, deadline });
  const board = final.value;
  if (
    !board ||
    !first?.value ||
    final.anchor.epoch !== first.anchor.epoch ||
    board.securityRevision !== first.value.securityRevision ||
    board.title !== first.value.title ||
    board.realmId !== first.value.realmId ||
    board.community?.name !== first.value.community?.name ||
    board.visibility !== first.value.visibility ||
    board.availability !== 'available'
  )
    return null;
  if (
    !board.title ||
    board.title.length > 1024 ||
    (board.realmId !== null && (!board.community?.name || board.community.name.length > 1024))
  )
    return null;
  return {
    item: {
      scope: { kind: 'board', id },
      label: board.title,
      parent: board.realmId === null ? null : { id: board.realmId, label: board.community!.name },
      queues: ['reports', 'appeals', 'resolved'],
      viewer: { open: 'permitted' },
    },
    witness: digest([
      authorized.epoch,
      final.anchor.epoch,
      board.id,
      board.realmId,
      board.securityRevision,
      board.title,
      board.visibility,
      board.createdAt,
      board.community?.name,
    ]),
  };
}

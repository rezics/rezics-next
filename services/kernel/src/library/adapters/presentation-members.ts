import { createBuiltinRuntime } from '../builtin-runtime.ts';
import { attachCollectionListFacts } from '../collection-list-facts.ts';
import { deadlineClient } from '../access-port.ts';
import { withConnection } from '../../database/pool.ts';
import { ProblemError } from '../../http/problem-error.ts';
import { accessCheck } from '../../request/access-check.ts';
import type { Actor } from '../../request/access.ts';
import { deadlineFor } from '../../request/deadline.ts';
import { routeOf } from '../../route/route.ts';
import { decodeCursor, encodeCursor } from '../../tokens/cursor.ts';
import { createCollectionReads } from '../collection-reads.ts';
import collectionRead from '../collection-reads-collection.sql';
import memberPage from '../collection-reads-members.sql';
import { isOrdinalKey } from '../ordinal.ts';
import { WORK_STEP_DEADLINE_MS } from '../work-step-deadline.ts';
import type { LibraryPresentationDependencies, NativeLibraryPresentationPorts } from './presentation.ts';

/** FULL members use the same cursor and anchored checks, retaining the readability result's label. */
export async function readNativeFullMembers(
  deps: LibraryPresentationDependencies,
  ports: NativeLibraryPresentationPorts,
  actor: Actor,
  collectionId: string,
  options: { cursor?: string; limit?: number; languages?: readonly string[] },
  deadline: number = deadlineFor(WORK_STEP_DEADLINE_MS),
) {
  const builtins = createBuiltinRuntime(deps);
  if (await builtins.read(actor, collectionId, 'collection:read', deadline))
    return builtins.members(actor, collectionId, { ...options, deadline });
  const parsedRoute = routeOf(collectionId);
  if (parsedRoute === null) throw new ProblemError('not_found');
  const route = parsedRoute;
  const binding = { operation: 'library.collection.members', parameters: { collectionId } };
  const limit = options.limit ?? 20;
  if (!Number.isInteger(limit) || limit < 1 || limit > 100) throw new ProblemError('invalid_request');
  async function readPage() {
    const sink: { seen: boolean; row: Awaited<ReturnType<typeof collectionRead.run>> } = { seen: false, row: null };
    const identity = { route, id: collectionId };
    const check = await accessCheck(
      deps.access,
      actor,
      'collection:read',
      {
        ...identity,
        eligibility: ports.createResourcePublicEligibility({
          resource: identity,
          action: 'collection:read',
          async prepare() {
            return { ready: true };
          },
          async verify({ client }) {
            sink.row = await collectionRead.run(client, identity);
            sink.seen = true;
            return sink.row !== null && sink.row.state === 'active' && sink.row.visibility !== 'private';
          },
        }),
      },
      { pool: deps.pool, deadline },
    );
    return withConnection(deps.pool, async (connection) => {
      const client = deadlineClient(connection, deadline);
      await client.query('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
      try {
        const viewer =
          actor.kind === 'account' && routeOf(actor.accountId) !== null
            ? await ports.accountEligibility.readAccount(client, routeOf(actor.accountId)!, actor.accountId)
            : null;
        const allowed = await check(client);
        if (!sink.seen) sink.row = await collectionRead.run(client, identity);
        const collection = sink.row;
        if (!collection || collection.state !== 'active') throw new ProblemError('not_found');
        // The same exact curator-T fence as BASIC members, before any child read.
        if (collection.visibility !== 'public') {
          const curator =
            collection.curatorAccountId === null
              ? null
              : await ports.accountEligibility.readAccount(client, route, collection.curatorAccountId);
          if (!curator || curator.state === 'deleted') throw new ProblemError('not_found');
        }
        // Match Collection reads: public/unlisted disclosure is independent of the private grant branch.
        if (
          collection.visibility === 'private' &&
          !(
            allowed &&
            actor.kind === 'account' &&
            viewer &&
            viewer.route === routeOf(actor.accountId) &&
            viewer.accountId === actor.accountId &&
            viewer.kind === 'actor' &&
            viewer.state === 'active' &&
            !viewer.fenced &&
            Number.isSafeInteger(actor.authnEpoch) &&
            actor.authnEpoch > 0 &&
            BigInt(actor.authnEpoch) >= viewer.minimumAuthnEpoch &&
            actor.scopes.includes('collection:read')
          )
        )
          throw new ProblemError('not_found');
        if (collection.membershipKind === 'dynamic') {
          await client.query('COMMIT');
          return { dynamic: true } as const;
        }
        let after: { ordinalKey: string; memberId: string } | null = null;
        if (options.cursor !== undefined) {
          const cursor = decodeCursor(deps.tokens, binding, options.cursor);
          if (
            !cursor.ok ||
            cursor.after.length !== 2 ||
            typeof cursor.after[0] !== 'string' ||
            !isOrdinalKey(cursor.after[0]) ||
            typeof cursor.after[1] !== 'string' ||
            routeOf(cursor.after[1]) !== route
          )
            throw new ProblemError('invalid_cursor');
          if (cursor.epoch !== collection.orderEpoch + 1) throw new ProblemError('stale_cursor');
          after = { ordinalKey: cursor.after[0], memberId: cursor.after[1] };
        }
        const rows = await memberPage.run(client, {
          route,
          collection_id: collectionId,
          after_ordinal_key: after?.ordinalKey ?? null,
          after_member_id: after?.memberId ?? null,
          limit: limit + 1,
        });
        await client.query('COMMIT');
        return { rows, epoch: collection.orderEpoch + 1, fence: collection };
      } catch (error) {
        await client.query('ROLLBACK');
        throw error;
      }
    });
  }
  const page = await readPage();
  if ('dynamic' in page)
    return createCollectionReads(deps).readMembers(actor, collectionId, { ...options, view: 'FULL' }, deadline);
  const considered = page.rows.slice(0, limit);
  const members = await attachCollectionListFacts(
    { ...deps, actor, deadline },
    considered.map((row) => {
      if (row.addedAt === null) throw new Error('A live Collection member must retain its added time');
      return { id: row.id, subjectId: row.subjectId, note: row.note, addedAt: new Date(row.addedAt).toISOString() };
    }),
    {
      ...(options.languages === undefined ? {} : { languages: options.languages }),
      async revalidate() {
        // Reauthorize after the released Semantic homes; never publish a page from a changed source.
        const current = await readPage();
        if (JSON.stringify(current) !== JSON.stringify(page)) throw new ProblemError('semantic_not_ready');
      },
    },
  );
  const last = considered.at(-1);
  return {
    members,
    next:
      page.rows.length > limit && last
        ? encodeCursor(deps.tokens, binding, { epoch: page.epoch, after: [last.ordinalKey, last.id] })
        : null,
  };
}

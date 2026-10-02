import { Elysia, t } from 'elysia';
import { readId, readName, readUuid, pageQuery } from '../modules/work/read-contract.ts';
import {
  workRead,
  decodeReadCursor,
  encodeReadCursor,
  WorkReadMoved,
  WorkReadUnavailable,
} from '../modules/work/read-session.ts';
import { followLevel, followSource, relationshipQuery } from '../modules/follows/contract.ts';
import { joinedSpaces } from '../modules/follows/memberships.ts';
import { readResourceSummaries } from '../modules/media/summary.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../modules/media/store.ts';
import { homeError, homeHeaders } from './follows.ts';
import { workReadProblems } from './work-reads.ts';
import type { MainWorkDependencies } from './dependencies.ts';

const querySchema = t.Object(
  { ...pageQuery, ...relationshipQuery, actingSubject: readId },
  { additionalProperties: false },
);
const pageSchema = t.Object({
  items: t.Array(
    t.Object({
      membershipId: readUuid,
      generation: t.String(),
      realm: readId,
      space: t.Nullable(readId),
      member: readId,
      available: t.Boolean(),
      name: t.Nullable(readName),
      following: t.Boolean(),
      level: t.Nullable(followLevel),
      source: t.Nullable(followSource),
      pinPosition: t.Nullable(t.Integer()),
    }),
    { maxItems: 20 },
  ),
  nextCursor: t.Nullable(t.String()),
  complete: t.Boolean(),
});
export const openApiOperations = { '/v1/me/memberships': { get: { bearer: true } } } as const;
export function membershipsRoutes(work: MainWorkDependencies) {
  return new Elysia().get(
    '/v1/me/memberships',
    { query: querySchema, response: { 200: pageSchema, ...workReadProblems } },
    async ({ request, query }) => {
      try {
        if (!work.follows) throw new WorkReadUnavailable('Membership list is unavailable');
        const principal = await work.account.verify(request, ['access:membership-consent']);
        return Response.json(
          await workRead(
            work,
            new Request(request.url),
            { language: query.language },
            async (session) => {
              const order = query.order ?? 'recent',
                limit = query.limit ?? 20,
                pool = work.follows!.pool;
              const first = await joinedSpaces(
                pool,
                principal,
                query.actingSubject,
                null,
                order,
                1,
              );
              const binding = [
                'memberships-v1',
                first.owner,
                query.actingSubject,
                query.q ?? null,
                order,
                query.language ?? null,
              ];
              const cursor = decodeReadCursor(query.cursor, binding, session.position);
              if (cursor && cursor.order !== first.revision)
                throw new WorkReadMoved('Memberships changed');
              const page = await joinedSpaces(
                pool,
                principal,
                query.actingSubject,
                cursor?.after ?? null,
                order,
                limit,
              );
              if (page.revision !== first.revision) throw new WorkReadMoved('Memberships changed');
              const rows = page.rows.slice(0, limit),
                permitted = new Set<string>();
              for (const row of rows)
                if (await work.access.realmReadProof?.(principal, query.actingSubject, row.realm))
                  permitted.add(row.realm);
              const readNames = async () => {
                const result = await readResourceSummaries(
                  work.environment,
                  work.media?.store,
                  {
                    realmReadProof: async (realm) =>
                      permitted.has(realm)
                        ? ((await work.access.realmReadProof?.(
                            principal,
                            query.actingSubject,
                            realm,
                          )) ?? null)
                        : null,
                  },
                  {
                    resources: rows.map((row) => row.realm),
                    context: DEFAULT_MEDIA_CONTEXT,
                    language: query.language ?? null,
                  },
                );
                return new Map(
                  result.summaries.flatMap((summary) =>
                    summary.status === 'available'
                      ? [[summary.reference, summary.name] as const]
                      : [],
                  ),
                );
              };
              const names = rows.length ? await readNames() : new Map();
              for (const realm of permitted)
                if (!(await work.access.realmReadProof?.(principal, query.actingSubject, realm)))
                  throw new WorkReadMoved('Membership disclosure changed');
              const fenced = rows.length ? await readNames() : new Map();
              if (JSON.stringify([...names]) !== JSON.stringify([...fenced]))
                throw new WorkReadMoved('Membership names changed');
              const items = rows.map((row) => {
                const name = names.get(row.realm);
                return {
                  membershipId: row.membership_id,
                  generation: row.generation,
                  realm: row.realm,
                  space: row.space,
                  member: row.member,
                  available: !!name,
                  name: name ?? null,
                  following: row.following,
                  level: row.level,
                  source: row.source,
                  pinPosition: row.pin_position,
                };
              });
              if (
                (await joinedSpaces(pool, principal, query.actingSubject, null, order, 1))
                  .revision !== first.revision
              )
                throw new WorkReadMoved('Memberships changed');
              const last = rows.at(-1);
              const nextCursor =
                page.rows.length > limit && last
                  ? encodeReadCursor(
                      binding,
                      session.position,
                      JSON.stringify({ key: last.order_key, realm: last.realm }),
                      first.revision,
                    )
                  : null;
              const search = query.q?.normalize('NFKC').toLowerCase();
              return {
                items: search
                  ? items.filter((item) =>
                      item.name?.value.normalize('NFKC').toLowerCase().includes(search),
                    )
                  : items,
                nextCursor,
                complete: nextCursor === null,
              };
            },
          ),
          { headers: homeHeaders },
        );
      } catch (error) {
        return homeError(error);
      }
    },
  );
}

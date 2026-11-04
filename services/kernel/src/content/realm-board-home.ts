import { t } from 'elysia';
import { AccessUnavailableError } from '../access/unavailable.ts';
import { deadlineClient } from '../access/authenticate.ts';
import { withConnection } from '../database/pool.ts';
import { readPartition } from '../partition/partition.ts';
import { selectRealmBoardPage, type ContentBoardDependencies } from './boards.ts';
import { observeBoardRecords } from './reads.ts';
import type { BoardRecord, ReadContext } from './model.ts';
import { BoardRecordSchema } from './schemas.ts';
import { observeRealmCommunity, RealmCommunityRecentSchema, type RealmCommunityRecent } from './realm-community.ts';

export const REALM_HOME_BOARD_LIMIT = 20;
export type RealmHomeBoardPage = Readonly<{
  items: readonly (BoardRecord & { recent: RealmCommunityRecent | { state: 'unavailable' } })[];
  next: string | null;
}>;
export type RealmHomeBoardObservation = Readonly<{
  page: RealmHomeBoardPage;
  current: () => Promise<boolean>;
}>;
const closed = { additionalProperties: false } as const;
export const RealmHomeBoardQuerySchema = t.Object(
  { cursor: t.Optional(t.String({ minLength: 1, maxLength: 4096 })) },
  closed,
);
export const RealmHomeBoardPageSchema = t.Unsafe<RealmHomeBoardPage>(
  t.Object(
    {
      items: t.Array(
        t.Object(
          {
            ...BoardRecordSchema.properties,
            recent: t.Union([RealmCommunityRecentSchema, t.Object({ state: t.Literal('unavailable') }, closed)]),
          },
          closed,
        ),
        { maxItems: REALM_HOME_BOARD_LIMIT },
      ),
      next: t.Union([t.String(), t.Null()]),
    },
    closed,
  ),
);

/** The ordinary raw board window and exact-key native disclosure, without a
 * second community presentation or a refill after concealed rows. */
export function createRealmHomeBoardObservationReader(deps: ContentBoardDependencies) {
  return async (
    realmId: string,
    context: ReadContext,
    query: { cursor?: string } = {},
  ): Promise<RealmHomeBoardObservation> => {
    const selected = await selectRealmBoardPage(deps, realmId, context, {
      ...query,
      limit: REALM_HOME_BOARD_LIMIT,
    });
    const observation = await observeBoardRecords(deps, selected.ids, context);
    if (observation.records.some(({ anchor }) => anchor.epoch !== selected.anchor.epoch))
      throw new AccessUnavailableError('contention');
    const admitted = observation.records.flatMap(({ value }) => (value?.realmId === realmId ? [value] : []));
    const community = await observeRealmCommunity(deps, admitted, context);
    return {
      page: {
        items: admitted.map((board) => ({
          ...board,
          recent: community.recent.get(board.id) ?? { state: 'unavailable' as const },
        })),
        next: selected.next,
      },
      async current() {
        if (!(await community.current())) return false;
        if (!(await observation.current())) return false;
        const partition = await withConnection(deps.pool, (connection) =>
          readPartition(deadlineClient(connection, context.deadline), selected.anchor.partition.partitionNo),
        );
        return partition !== null && partition.writeState !== 'moved' && partition.epoch === selected.anchor.epoch;
      },
    };
  };
}

export function realmHomeBoardResponse(page: RealmHomeBoardPage) {
  return {
    items: page.items.map((board) => ({
      ...board,
      recent:
        board.recent.state === 'current'
          ? { ...board.recent, threads: board.recent.threads.map((thread) => ({ ...thread })) }
          : { ...board.recent },
    })),
    next: page.next,
  };
}

import type { Pool } from 'pg';
import { realmSubjectHome, realmSubjectRoute } from './realm-subject-candidates.ts';

export type RealmSubjectScopeKind = 'realm' | 'space' | 'realm-board-set';
export type RealmSubjectScopeChange = Readonly<{
  kind: RealmSubjectScopeKind;
  id: string;
  eventId: string;
  partition: number;
  epoch: number;
  position: string;
}>;

const zero = '0';

function validate(change: RealmSubjectScopeChange): number {
  const route = realmSubjectRoute(change.id);
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/.test(change.eventId) ||
    !Number.isInteger(change.partition) ||
    change.partition < 0 ||
    change.partition > 4095 ||
    !Number.isInteger(change.epoch) ||
    change.epoch < 1 ||
    change.epoch > 2_147_483_647 ||
    !/^[1-9][0-9]*$/.test(change.position) ||
    BigInt(change.position) > 9_223_372_036_854_775_807n
  )
    throw new TypeError('Invalid Realm Subject scope invalidation');
  return route;
}

/** Structural ancestor generations. These wake observations; disclosure still checks every reader and source. */
export function createRealmSubjectScope(pool: Pool) {
  async function generation(route: number, id: string, kinds: readonly RealmSubjectScopeKind[], deadline: number) {
    const rows = await realmSubjectHome(pool, route, deadline, false, async (client) =>
      client.query<{ scope_kind: RealmSubjectScopeKind; generation: string }>(
        `SELECT scope_kind,generation::text FROM content.realm_subject_scope_state
         WHERE route=$1 AND scope_id=$2 AND scope_kind=ANY($3::text[])`,
        [route, id, [...kinds]],
      ),
    );
    const values = Object.fromEntries(rows.rows.map((row) => [row.scope_kind, row.generation]));
    return kinds.map((kind) => values[kind] ?? zero);
  }

  async function observe(realm: string, deadline: number): Promise<string | null> {
    const route = realmSubjectRoute(realm);
    const parent = await realmSubjectHome(pool, route, deadline, false, async (client) =>
      client.query<{
        space_id: string;
        state: string;
        visibility: string;
        context_id: string;
        board_scheme_id: string | null;
        head_revision_id: string;
        lifecycle_version: string;
      }>(
        `SELECT space_id,state,visibility,context_id,board_scheme_id,head_revision_id,lifecycle_version::text
         FROM community.realm WHERE route=$1 AND realm_id=$2`,
        [route, realm],
      ),
    );
    const row = parent.rows[0];
    if (!row || row.state !== 'active') return null;
    const spaceRoute = realmSubjectRoute(row.space_id);
    const space = await realmSubjectHome(pool, spaceRoute, deadline, false, async (client) =>
      client.query<{ state: string; head_revision_id: string; lifecycle_version: string }>(
        `SELECT state,head_revision_id,lifecycle_version::text FROM community.space
         WHERE route=$1 AND space_id=$2`,
        [spaceRoute, row.space_id],
      ),
    );
    const host = space.rows[0];
    if (!host || host.state !== 'active') return null;
    const [realmGeneration, spaceGeneration] = await Promise.all([
      generation(route, realm, ['realm', 'realm-board-set'], deadline),
      generation(spaceRoute, row.space_id, ['space'], deadline),
    ]);
    return JSON.stringify([
      realm,
      row.state,
      row.visibility,
      row.context_id,
      row.board_scheme_id,
      row.head_revision_id,
      row.lifecycle_version,
      realmGeneration,
      row.space_id,
      host.state,
      host.head_revision_id,
      host.lifecycle_version,
      spaceGeneration,
    ]);
  }

  return {
    async invalidate(change: RealmSubjectScopeChange, deadline: number): Promise<boolean> {
      const route = validate(change);
      return realmSubjectHome(pool, route, deadline, true, async (client) => {
        const inserted = await client.query(
          `INSERT INTO content.realm_subject_scope_event
           (route,scope_kind,scope_id,source_partition,source_epoch,source_position,event_id)
           VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING RETURNING 1`,
          [
            route,
            change.kind,
            change.id,
            change.partition,
            change.epoch,
            change.position,
            change.eventId,
          ],
        );
        if (inserted.rowCount !== 1) return false;
        await client.query(
          `INSERT INTO content.realm_subject_scope_state(route,scope_kind,scope_id,generation)
           VALUES($1,$2,$3,1)
           ON CONFLICT(route,scope_kind,scope_id) DO UPDATE
           SET generation=content.realm_subject_scope_state.generation+1`,
          [route, change.kind, change.id],
        );
        return true;
      });
    },
    observe,
    async current(realm: string, expected: string, deadline: number): Promise<'current' | 'changed' | 'unavailable'> {
      const actual = await observe(realm, deadline);
      if (actual === null) return 'unavailable';
      return actual === expected ? 'current' : 'changed';
    },
  };
}

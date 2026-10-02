import { randomUUID } from 'node:crypto';
import type { Pool, PoolClient } from 'pg';
import type { FusekiClient } from '../../infrastructure/fuseki.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { baselineMemberProof } from '../access/baseline.ts';
import { followSpace, registerFollowSpace } from './targets.ts';
import { automaticFollow, type FollowRow } from './store.ts';

const graphs = new WeakMap<Pool, Pick<FusekiClient, 'query'>>();
export function configureFollowGraph(pool: Pool, graph: Pick<FusekiClient, 'query'>) {
  graphs.set(pool, graph);
}
export async function prepareRealmFollow(client: PoolClient, pool: Pool, realm: string) {
  const graph = graphs.get(pool);
  if (!graph) return;
  const { publicTargetRead } = await import('../target/resolve.ts');
  const space = await publicTargetRead(graph, (session) => followSpace(session, realm));
  if (space) await registerFollowSpace(client, space);
}
export const RELATIONSHIP_RECOVERY_COST = {
  legacyRows: 16,
  membershipRows: 16,
  libraryRows: 32,
} as const;
/** Existing Realm/Zone follows converge to one Space slot. The newest explicit
 * choice wins a collision. Deleting the old slot and writing the new one share
 * the inventory lock, so retries and budget counts cannot split them. */
export async function recoverSpaceFollows(pool: Pool, graph: Pick<FusekiClient, 'query'>) {
  configureFollowGraph(pool, graph);
  const cursor = (
    await pool.query<{
      space_after_principal: string | null;
      space_after_target: string;
      member_after: string | null;
    }>(
      'SELECT space_after_principal,space_after_target,member_after FROM access.relationship_recovery_cursor WHERE id',
    )
  ).rows[0]!;
  const rows = (
    await pool.query<FollowRow & { principal_id: string; acting_subject: string }>(
      `
    SELECT * FROM access.follow WHERE kind IN ('realm','zone')
      AND ($2::uuid IS NULL OR (principal_id,target)>($2::uuid,$3::text)) ORDER BY principal_id,target LIMIT $1`,
      [
        RELATIONSHIP_RECOVERY_COST.legacyRows,
        cursor.space_after_principal,
        cursor.space_after_target,
      ],
    )
  ).rows;
  for (const row of rows)
    await controlTransaction(pool, async (client) => {
      await client.query(
        'SELECT revision FROM access.follow_inventory WHERE principal_id=$1 FOR UPDATE',
        [row.principal_id],
      );
      await prepareRealmFollow(client, pool, row.target);
      const alias = (
        await client.query<{ space: string }>(
          'SELECT space FROM access.follow_space_alias WHERE alias=$1',
          [row.target],
        )
      ).rows[0];
      if (!alias) return;
      const latest = (
        await client.query<FollowRow & { acting_subject: string }>(
          'SELECT * FROM access.follow WHERE principal_id=$1 AND target=$2',
          [row.principal_id, row.target],
        )
      ).rows[0];
      if (!latest || latest.revision !== row.revision) return;
      const prior = (
        await client.query<FollowRow>(
          'SELECT * FROM access.follow WHERE principal_id=$1 AND target=$2',
          [row.principal_id, alias.space],
        )
      ).rows[0];
      await client.query('DELETE FROM access.follow WHERE principal_id=$1 AND target=$2', [
        row.principal_id,
        row.target,
      ]);
      if (
        prior &&
        ((prior.source === 'explicit' && latest.source !== 'explicit') ||
          prior.changed_at >= latest.changed_at)
      )
        return;
      await client.query(
        `INSERT INTO access.follow(principal_id,target,kind,acting_subject,following,revision,level,source,pin_position,changed_at)
      VALUES($1,$2,'space',$3,$4,$5,$6,$7,$8,$9) ON CONFLICT(principal_id,target) DO UPDATE SET
      following=EXCLUDED.following,revision=EXCLUDED.revision,level=EXCLUDED.level,source=EXCLUDED.source,
      pin_position=EXCLUDED.pin_position,changed_at=EXCLUDED.changed_at`,
        [
          row.principal_id,
          alias.space,
          latest.acting_subject,
          latest.following,
          randomUUID(),
          latest.level,
          latest.source,
          latest.pin_position,
          latest.changed_at,
        ],
      );
    });
  // A join before this release (or before mapping recovery) has no follow yet.
  const last = rows.at(-1);
  await pool.query(
    'UPDATE access.relationship_recovery_cursor SET space_after_principal=$1,space_after_target=$2 WHERE id',
    [last?.principal_id ?? null, last?.target ?? ''],
  );
  const members = (
    await pool.query<{ owner: string; actor: string; realm: string; id: string; private: boolean }>(
      `WITH candidates AS (SELECT m.id,a.principal_id AS owner,a.agent_id AS actor,m.owner_subject AS realm,false AS private
    FROM access.membership m JOIN access.agent_provision a ON a.agent_id=m.member_subject
    JOIN access.principal p ON p.id=a.principal_id AND p.active
    WHERE m.kind='realm' AND m.state='joined' AND a.agent_kind='person' AND a.state='active'
    UNION ALL SELECT m.id,m.principal_id,a.agent_id,m.owner_subject,true FROM access.private_membership m
      JOIN access.principal p ON p.id=m.principal_id AND p.active
      JOIN LATERAL (SELECT agent_id FROM access.agent_provision WHERE principal_id=m.principal_id
        AND agent_kind='person' AND state='active' ORDER BY agent_id LIMIT 1) a ON true
      WHERE m.kind='realm' AND m.state='joined') SELECT * FROM candidates m
    WHERE ($2::uuid IS NULL OR m.id>$2::uuid)
    AND NOT EXISTS(SELECT 1 FROM access.follow f JOIN access.follow_space_alias s ON s.space=f.target
      WHERE f.principal_id=m.owner AND s.alias=m.realm)
    ORDER BY m.id LIMIT $1`,
      [RELATIONSHIP_RECOVERY_COST.membershipRows, cursor.member_after],
    )
  ).rows;
  for (const member of members)
    await controlTransaction(pool, async (client) => {
      await client.query("SELECT id FROM access.scope_gate WHERE id='work:create:root' FOR UPDATE");
      if (!(await baselineMemberProof(client, member.owner, member.actor))) return;
      await prepareRealmFollow(client, pool, member.realm);
      if (
        !(
          await client.query(
            member.private
              ? "SELECT 1 FROM access.private_membership WHERE owner_subject=$1 AND principal_id=$2 AND kind='realm' AND state='joined'"
              : "SELECT 1 FROM access.membership WHERE owner_subject=$1 AND member_subject=$2 AND kind='realm' AND state='joined'",
            [member.realm, member.private ? member.owner : member.actor],
          )
        ).rowCount
      )
        return;
      const mapped = (
        await client.query<{ space: string }>(
          'SELECT space FROM access.follow_space_alias WHERE alias=$1',
          [member.realm],
        )
      ).rows[0];
      if (mapped)
        await automaticFollow(
          client,
          member.owner,
          member.actor,
          mapped.space,
          'space',
          'join',
          true,
        );
    });
  await pool.query('UPDATE access.relationship_recovery_cursor SET member_after=$1 WHERE id', [
    members.at(-1)?.id ?? null,
  ]);
  return rows.length + members.length;
}

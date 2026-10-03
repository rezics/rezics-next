import type { Pool } from 'pg';
import { baselineMemberProof } from '../access/baseline.ts';
import { controlTransaction } from '../access/topology-control.ts';
import { automaticFollow } from '../follows/store.ts';
import { RELATIONSHIP_RECOVERY_COST } from '../follows/recovery.ts';
import { configureLibraryFollow } from './status.ts';

/** Reconciliation reads the durable current Content slot after taking its
 * Access projection lock. Versions make a lost ACK or a delayed callback safe.
 * Several person Agents share one follow: any of their active shelves keeps it. */
export async function projectLibraryFollow(
  content: Pool,
  access: Pool,
  agent: string,
  work: string,
) {
  return controlTransaction(access, async (client) => {
    const person = (
      await client.query<{ principal_id: string }>(
        `SELECT principal_id FROM access.agent_provision
      WHERE agent_id=$1 AND agent_kind='person' AND state='active'`,
        [agent],
      )
    ).rows[0];
    if (!person || !(await baselineMemberProof(client, person.principal_id, agent))) return;
    await client.query('SELECT pg_advisory_xact_lock(hashtextextended($1,0))', [
      `library-follow:${agent}:${work}`,
    ]);
    const current = (
      await content.query<{ version: string; title_key: string | null }>(
        'SELECT version::text,title_key FROM reader.library_status WHERE agent=$1 AND work=$2',
        [agent, work],
      )
    ).rows[0];
    if (!current) return;
    const old = (
      await client.query<{ version: string }>(
        'SELECT version::text FROM access.library_follow_position WHERE agent=$1 AND work=$2',
        [agent, work],
      )
    ).rows[0];
    if (old && BigInt(old.version) >= BigInt(current.version)) return;
    const agents = (
      await client.query<{ agent_id: string }>(
        `SELECT agent_id FROM access.agent_provision
      WHERE principal_id=$1 AND agent_kind='person' AND state='active' ORDER BY agent_id LIMIT 17`,
        [person.principal_id],
      )
    ).rows;
    if (agents.length > 16) throw new Error('Library relationship actor bound exceeded');
    const active = !!(
      await content.query(
        `SELECT 1 FROM reader.library_status WHERE agent=ANY($1::text[])
      AND work=$2 AND status IN ('reading','want-to-read') LIMIT 1`,
        [agents.map((row) => row.agent_id), work],
      )
    ).rowCount;
    if (!await automaticFollow(client, person.principal_id, agent, work, 'work', 'library', active,current.title_key)) return;
    await client.query(
      `INSERT INTO access.library_follow_position(agent,work,version) VALUES($1,$2,$3)
      ON CONFLICT(agent,work) DO UPDATE SET version=EXCLUDED.version`,
      [agent, work, current.version],
    );
  });
}
export function configureLibraryFollows(content: Pool, access: Pool) {
  configureLibraryFollow(content, (agent, work) =>
    projectLibraryFollow(content, access, agent, work),
  );
}
/** Thirty-two primary-key candidates per tick. A persisted cycling cursor
 * recovers every status path, including imports, sessions and lost responses. */
export async function recoverLibraryFollows(content: Pool, access: Pool) {
  const cursor = (
    await access.query<{ library_agent: string; library_work: string }>(
      'SELECT library_agent,library_work FROM access.relationship_recovery_cursor WHERE id',
    )
  ).rows[0]!;
  const rows = (
    await content.query<{ agent: string; work: string }>(
      `SELECT agent,work FROM reader.library_status
    WHERE (agent,work)>($1::text,$2::text) ORDER BY agent,work LIMIT $3`,
      [cursor.library_agent, cursor.library_work, RELATIONSHIP_RECOVERY_COST.libraryRows],
    )
  ).rows;
  for (const row of rows) {
    try { await projectLibraryFollow(content, access, row.agent, row.work); }
    catch (error) { console.warn('Library follow recovery row deferred', error); }
    await access.query('UPDATE access.relationship_recovery_cursor SET library_agent=$1,library_work=$2 WHERE id',
      [row.agent,row.work]);
  }
  if (!rows.length) await access.query("UPDATE access.relationship_recovery_cursor SET library_agent='',library_work='' WHERE id");
  return rows.length;
}

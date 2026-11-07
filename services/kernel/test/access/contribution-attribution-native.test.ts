import { afterAll, expect, test } from 'bun:test';
import { Pool } from 'pg';
import {
  agentContributionAttribution,
  readContributionAttributions,
  type ContributionAttribution,
} from '../../src/access/public-identity.ts';
import { accountAgentId } from '../../src/semantic/agents.ts';
import { newId, routeOf } from '../../src/route/route.ts';

const pool = new Pool({ connectionString: process.env.DATABASE_URL, max: 1 });
afterAll(() => pool.end());

test('bounded owner reads keep live, deleted, pending and missing identities distinct through retained agent resolution', async () => {
  const client = await pool.connect();
  await client.query('BEGIN');
  try {
    const rows: { id: string; kind: 'actor' | 'organization'; state: 'active' | 'pending' | 'deleted' }[] = [];
    for (const kind of ['actor', 'organization'] as const) {
      for (const state of ['active', 'pending', 'deleted'] as const) {
        const id = newId(0x6a21);
        rows.push({ id, kind, state });
        await client.query(
          `INSERT INTO access.account(route,account_id,kind,state,display_name,transaction_id)
           VALUES($1,$2,$3,$4,'Current name',$2)`,
          [routeOf(id), id, kind, state],
        );
        const agent = accountAgentId(id);
        await client.query(
          `INSERT INTO semantic.account_agent_subject(route,account_route,subject_id,account_id,agent_id)
           VALUES($1,$1,$2,$3,$2)`,
          [routeOf(id), agent, id],
        );
      }
    }
    const missing = newId(0x6a21);
    const orphan = accountAgentId(missing);
    await client.query(
      `INSERT INTO semantic.account_agent_subject(route,account_route,subject_id,account_id,agent_id)
       VALUES($1,$1,$2,$3,$2)`,
      [routeOf(missing), orphan, missing],
    );
    const current = await readContributionAttributions(client, [...rows.map(({ id }) => id), missing, rows[0]!.id]);
    expect(current.size).toBe(7);
    for (const { id, kind, state } of rows) {
      const expected: ContributionAttribution =
        state === 'pending'
          ? null
          : state === 'deleted'
            ? { displayName: kind === 'organization' ? 'Deleted organization' : 'Deleted account' }
            : { id, kind, displayName: 'Current name' };
      expect(current.get(id)).toEqual(expected);
      expect(await agentContributionAttribution(client, accountAgentId(id))).toEqual(expected);
    }
    expect(current.get(missing)).toBeNull();
    expect(await agentContributionAttribution(client, orphan)).toBeNull();
    expect(await agentContributionAttribution(client, newId(0x6a21))).toBeNull();
    expect(await readContributionAttributions(client, [])).toEqual(new Map());
    // A page left from an old verification cannot assign its account to a new live binding.
    const staleSubject = newId(0x6a21);
    await client.query(
      `INSERT INTO access.agent_page(route,subject_id,account_id,verification_receipt_id)
       VALUES($1,$2,$3,$4)`,
      [routeOf(staleSubject), staleSubject, rows[0]!.id, newId(0x6a21)],
    );
    expect(await agentContributionAttribution(client, staleSubject)).toBeNull();
  } finally {
    await client.query('ROLLBACK');
    client.release();
  }
});

test('an unavailable owner reader preserves its actual failure, never a deleted-account result', async () => {
  const failure = new Error('owner lookup unavailable');
  const unavailable = {
    query() {
      throw failure;
    },
  };
  await expect(readContributionAttributions(unavailable, [newId(0x6a21)])).rejects.toBe(failure);
  await expect(agentContributionAttribution(unavailable, newId(0x6a21))).rejects.toBe(failure);
});

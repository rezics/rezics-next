import type { Pool } from 'pg';

/** Losing this caller's authority still leaves the Agent independently controlled. */
export async function replacementController(pool: Pool, agent: string): Promise<void> {
  await pool.query(`WITH replacement AS (
    INSERT INTO access.principal (id,account_issuer,account_subject)
    VALUES (gen_random_uuid(),'fixture://replacement',gen_random_uuid()::text) RETURNING id)
    INSERT INTO access.representation (id,principal_id,subject_id,action,valid_until)
    SELECT gen_random_uuid(),id,$1,'agent.control','infinity' FROM replacement`, [agent]);
}

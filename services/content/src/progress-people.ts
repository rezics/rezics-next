import { Pool, type PoolClient } from 'pg';

/** Access owns the private principal-to-Person link. Resolve it only while the
 * owner migration holds admission closed; never copy it into a public event. */
export async function prepareProgressPeople(client: PoolClient, accessUrl?: string): Promise<void> {
  await client.query(`CREATE TEMP TABLE progress_person_binding (
    principal_issuer text NOT NULL, principal_subject text NOT NULL, agent text NOT NULL,
    PRIMARY KEY (principal_issuer, principal_subject)) ON COMMIT DROP`);
  let after: { principal_issuer: string; principal_subject: string } | undefined;
  let access: Pool | undefined;
  try {
    for (;;) {
      const page = await client.query<{ principal_issuer: string; principal_subject: string }>(`
        SELECT principal_issuer, principal_subject FROM (
          SELECT principal_issuer, principal_subject FROM structure.progress
          UNION SELECT principal_issuer, principal_subject FROM structure.progress_command
        ) identities WHERE ($1::text IS NULL OR (principal_issuer, principal_subject) > ($1,$2))
        ORDER BY principal_issuer, principal_subject LIMIT 256`,
      [after?.principal_issuer ?? null, after?.principal_subject ?? null]);
      if (!page.rows.length) return;
      if (!accessUrl) throw new Error('Legacy occurrence progress requires the Access database to resolve its Person');
      access ??= new Pool({ connectionString: accessUrl, max: 1, connectionTimeoutMillis: 5_000 });
      const people = await access.query<{ issuer: string; subject: string; agents: string[] }>(`
        SELECT identities.issuer, identities.subject, array_remove(array_agg(DISTINCT a.agent_id), NULL) AS agents
        FROM unnest($1::text[], $2::text[]) identities(issuer, subject)
        LEFT JOIN access.principal p ON p.account_issuer = identities.issuer AND p.account_subject = identities.subject
        LEFT JOIN access.representation r ON r.principal_id = p.id AND r.action = 'agent.control'
        LEFT JOIN access.agent_provision a ON a.agent_kind = 'person'
          AND (a.principal_id = p.id OR a.agent_id = r.subject_id)
        GROUP BY identities.issuer, identities.subject`,
      [page.rows.map(row => row.principal_issuer), page.rows.map(row => row.principal_subject)]);
      if (people.rows.length !== page.rows.length || people.rows.some(row => row.agents.length !== 1)) {
        throw new Error('Legacy occurrence progress has a missing or ambiguous Person binding; resolve it before migration');
      }
      await client.query(`INSERT INTO pg_temp.progress_person_binding
        SELECT * FROM unnest($1::text[], $2::text[], $3::text[])`,
      [people.rows.map(row => row.issuer), people.rows.map(row => row.subject), people.rows.map(row => row.agents[0]!)]);
      after = page.rows.at(-1)!;
    }
  } finally { await access?.end(); }
}

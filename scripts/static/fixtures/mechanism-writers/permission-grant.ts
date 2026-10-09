export async function grant(client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  actor: string, scope: string, action: string): Promise<void> {
  await client.query(`INSERT INTO access.permission_grant
    (id, issuer_subject, recipient_subject, scope_id, action, valid_until)
    VALUES ($1,$2,$2,$3,$4,now() + interval '8 hours')`, [actor, scope, action]);
}

export async function recordObligation(client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  id: string): Promise<void> {
  await client.query(`INSERT INTO rights.obligation (assessment_id, ordinal, kind, instrument, applies_to, notice)
    VALUES ($1, 1, 'share_alike', 'https://creativecommons.org/licenses/by-sa/4.0/', 'all', null)`, [id]);
}

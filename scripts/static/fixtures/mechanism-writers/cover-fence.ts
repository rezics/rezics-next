export async function fenceCover(client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  work: string, source: string): Promise<void> {
  await client.query(`CREATE TABLE IF NOT EXISTS cover_fence (work_id text, source_url text, cover_fenced boolean)`, []);
  await client.query(`INSERT INTO cover_fence (work_id, source_url, cover_fenced) VALUES ($1, $2, true)`, [work, source]);
}

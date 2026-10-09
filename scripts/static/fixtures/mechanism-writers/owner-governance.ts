export async function advanceFence(client: { query: (sql: string, values: unknown[]) => Promise<unknown> },
  id: string, state: string): Promise<void> {
  await client.query(`UPDATE access.governance_enforcement SET state = $2, fence_epoch = fence_epoch + 1
    WHERE id = $1`, [id, state]);
}

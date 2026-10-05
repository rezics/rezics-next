import type { Pool } from 'pg';

/** One retention poll: five signals with indexed head/range probes, each deleting at most
 * 256 settled rows. The head and every unsettled row remain fence evidence. */
export const ORDERED_READ_RETENTION_COST = {
  signals: 5,
  rowsPerSignal: 256,
  statements: 2,
} as const;

export async function pruneOrderedReadChanges(access: Pool, content: Pool): Promise<void> {
  await access.query(`SELECT access.prune_site_moderation_changes(),
    access.prune_realm_count_changes(),access.prune_realm_growth_changes()`);
  await content.query('SELECT reading_position.prune_changes(),source.prune_author_name_changes()');
}

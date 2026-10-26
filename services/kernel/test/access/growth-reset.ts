import pg, { type Pool } from 'pg';

// These migrations install persistent rows, including the Global Context and
// partition counters. A series must preserve them even through incoming FKs.
const migrationSeededTables = new Set([
  'core.partition',
  'semantic.context',
  'semantic.partition_subjects',
  'semantic.acceptance_current',
  'content.reaction_total',
]);

/** Reset owned relations and their incoming foreign-key closure atomically. */
export async function resetGrowthTables(admin: Pool, ownedTables: readonly string[]): Promise<void> {
  if (ownedTables.length === 0) return;
  const closure = await admin.query<{ schema: string; table: string }>(
    `WITH RECURSIVE tables(oid) AS (
       SELECT unnest($1::regclass[])::oid
       UNION
       SELECT constraint_row.conrelid
       FROM pg_constraint constraint_row
       JOIN tables ON tables.oid = constraint_row.confrelid
       WHERE constraint_row.contype = 'f'
     )
     SELECT namespace.nspname AS schema, relation.relname AS table
     FROM tables
     JOIN pg_class relation ON relation.oid = tables.oid
     JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
     ORDER BY namespace.nspname, relation.relname`,
    [ownedTables],
  );
  for (const row of closure.rows) {
    const name = `${row.schema}.${row.table}`;
    if (migrationSeededTables.has(name)) throw new Error(`Growth reset would truncate migration-seeded table ${name}`);
  }
  const names = closure.rows.map((row) => `${pg.escapeIdentifier(row.schema)}.${pg.escapeIdentifier(row.table)}`);
  await admin.query(`TRUNCATE TABLE ${names.join(', ')}`);
}

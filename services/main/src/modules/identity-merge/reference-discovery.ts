import type { Pool } from 'pg';

/** SQL person-state class guard. Authority and graph facts are outside the
 * launch reconciliation scope; receipts and exact attempts have explicit exclusions. */
export async function discoverOwnerIdentityReferences(pool: Pool): Promise<string[]> {
  const rows = (await pool.query<{ namespace: string; relation: string; attribute: string }>(`
    SELECT n.nspname AS namespace,c.relname AS relation,a.attname AS attribute
    FROM pg_class c JOIN pg_namespace n ON n.oid = c.relnamespace
    JOIN pg_attribute a ON a.attrelid = c.oid AND a.attnum > 0 AND NOT a.attisdropped
    JOIN pg_type t ON t.oid = a.atttypid
    WHERE c.relkind IN ('r','p') AND n.nspname NOT LIKE 'pg_%' AND n.nspname <> 'information_schema'
      AND t.typname IN ('text','varchar','json','jsonb','_text','_varchar')
      AND a.attname IN ('work','target','resource','source_work','target_work','structure')
      AND EXISTS (SELECT 1 FROM pg_attribute person WHERE person.attrelid=c.oid AND NOT person.attisdropped
        AND person.attname IN ('principal_id','principal_subject','agent'))
    ORDER BY n.nspname COLLATE "C",c.relname COLLATE "C",a.attname COLLATE "C"`)).rows;
  return rows.map(row => `table:${row.namespace}.${row.relation}.${row.attribute}`);
}

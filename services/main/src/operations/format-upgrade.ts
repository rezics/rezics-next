import { Pool } from 'pg';
import { engageAccessRecoveryFence } from '../modules/access/admission.ts';
import { safetyAlertDeliveryViewSql } from '../modules/safety-alerts/audit-view.ts';

export interface FormatUpgradeEnvironment {
  accessUrl: string;
}

/**
 * Explicit offline format switch for a stopped writer set. Cost: one Access
 * fence update, one offline graph writer stop, then one PostgreSQL table rewrite and unique
 * index rebuild, O(principal rows + index size). No corpus scan or retry loop.
 * A failure after fencing must be recovered from a matched stopped recovery set.
 */
export async function rewritePrincipalSubjectFormat(env: FormatUpgradeEnvironment,
  onFenced: () => Promise<void>, failurePoint?: 'after-rewrite-commit'): Promise<void> {
  const pool = new Pool({ connectionString: env.accessUrl, max: 1 });
  try {
    const format = await pool.query<{ version: number; state: string; subject_type: string }>(
      `SELECT f.version, f.state, c.data_type AS subject_type
       FROM access.storage_format f CROSS JOIN information_schema.columns c
       WHERE f.id = true AND c.table_schema = 'access' AND c.table_name = 'principal'
         AND c.column_name = 'account_subject'`);
    if (format.rows.length !== 1 || format.rows[0]?.version !== 1
      || format.rows[0]?.state !== 'ready' || format.rows[0]?.subject_type !== 'text') {
      throw new Error('No qualified text storage format to upgrade');
    }
    await engageAccessRecoveryFence(pool);
    await onFenced();
    const pending = await pool.query(`UPDATE access.storage_format
      SET state = 'upgrade-pending', target_version = 2
      WHERE id = true AND version = 1 AND state = 'ready'`);
    if (pending.rowCount !== 1) throw new Error('Access format changed while fencing');
    const client = await pool.connect();
    try {
      await client.query('BEGIN');
      await client.query("SET LOCAL lock_timeout = '5s'");
      await client.query("SET LOCAL statement_timeout = '120s'");
      await client.query(safetyAlertDeliveryViewSql('detached'));
      await client.query(`ALTER TABLE access.principal
        DROP CONSTRAINT principal_account_subject_check`);
      await client.query(`ALTER TABLE access.principal
        ALTER COLUMN account_subject TYPE bytea USING convert_to(account_subject, 'UTF8')`);
      await client.query(`ALTER TABLE access.principal
        ADD CONSTRAINT principal_account_subject_bytes_check CHECK (octet_length(account_subject) > 0)`);
      await client.query(safetyAlertDeliveryViewSql('bytea'));
      const advanced = await client.query(`UPDATE access.storage_format SET version = 2 WHERE id = true
        AND version = 1 AND state = 'upgrade-pending' AND target_version = 2`);
      if (advanced.rowCount !== 1) throw new Error('Access format changed during rewrite');
      await client.query('COMMIT');
    } catch (error) {
      await client.query('ROLLBACK');
      throw error;
    } finally { client.release(); }
    if (failurePoint === 'after-rewrite-commit') {
      throw new Error('Injected failure after incompatible format commit');
    }
  } finally { await pool.end(); }
}

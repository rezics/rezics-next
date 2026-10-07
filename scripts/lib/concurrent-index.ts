import type { PoolClient } from 'pg';

export interface SqlMigration {
  sql: string;
  concurrentIndex?: string;
  rehearsalSql: string;
}

/** Online builds must be standalone: multiple statements in one query form an
 * implicit transaction, which PostgreSQL rejects for CREATE INDEX CONCURRENTLY. */
export function sqlMigration(sql: string, name: string): SqlMigration {
  const concurrentIndex = /^-- migrate: concurrent-index ([a-z_][a-z0-9_]*\.[a-z_][a-z0-9_]*)\s*$/m.exec(sql)?.[1];
  if (!concurrentIndex) {
    if (/^-- migrate: concurrent-index\b/m.test(sql)) throw new Error(`Invalid concurrent-index marker in ${name}`);
    return { sql, rehearsalSql: sql };
  }
  if ([...sql.matchAll(/^-- migrate: concurrent-index\b/gm)].length !== 1) {
    throw new Error(`Concurrent-index migration ${name} must hold exactly one marker`);
  }
  // Keep offsets while masking comments and quoted values/identifiers, so the
  // rehearsal changes only the keyword, never a predicate or a comment.
  const statement = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
    token => (token.startsWith('--') || token.startsWith('/*') ? ' ' : '?') + ' '.repeat(token.length - 1));
  const create = /^\s*CREATE\s+(?:UNIQUE\s+)?INDEX\s+(CONCURRENTLY)\b[^;]*;?\s*$/i.exec(statement);
  if (!create) throw new Error(`Concurrent-index migration ${name} must hold exactly one CREATE INDEX CONCURRENTLY statement`);
  const uncommented = sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\/|'(?:''|[^'])*'|"(?:""|[^"])*"/g,
    token => token.startsWith('--') || token.startsWith('/*') ? ' '.repeat(token.length) : token);
  const identifier = '(?:"(?:""|[^"])*"|[a-z_][a-z0-9_$]*)';
  const target = new RegExp(`^\\s*CREATE\\s+(?:UNIQUE\\s+)?INDEX\\s+CONCURRENTLY\\s+(?:IF\\s+NOT\\s+EXISTS\\s+)?(${identifier})\\s+ON\\s+(?:ONLY\\s+)?(?:(${identifier})\\s*\\.\\s*)?${identifier}`, 'i').exec(uncommented);
  const normalize = (value: string) => value.startsWith('"') ? value.slice(1, -1).replaceAll('""', '"') : value.toLowerCase();
  const [schema, index] = concurrentIndex.split('.');
  // Recovery must inspect the index being built, never skip the build because
  // an unrelated index named by a mistaken marker happens to be valid.
  if (!target || normalize(target[1]!) !== index || (target[2] && normalize(target[2]) !== schema)) {
    throw new Error(`Concurrent-index migration ${name} marker does not match its CREATE INDEX target`);
  }
  const keyword = create[0].toUpperCase().indexOf('CONCURRENTLY');
  return { sql, concurrentIndex, rehearsalSql: sql.slice(0, keyword) + sql.slice(keyword + 'CONCURRENTLY'.length) };
}

/** Run online builds outside a transaction, retaining the owner's existing
 * session locks. A cancelled build leaves an invalid catalog entry; a lost receipt
 * after a successful build leaves a valid one. Both retries are recoverable. */
export async function applySqlMigration(client: Pick<PoolClient, 'query'>, migration: SqlMigration): Promise<void> {
  if (migration.concurrentIndex) {
    const index = (await client.query<{ indisvalid: boolean }>(
      'SELECT indisvalid FROM pg_index WHERE indexrelid = to_regclass($1)', [migration.concurrentIndex])).rows[0];
    if (index?.indisvalid) return;
    if (index) await client.query(`DROP INDEX CONCURRENTLY ${migration.concurrentIndex}`);
  }
  await client.query(migration.sql);
}

import { expect, test } from 'bun:test';
import { dirname, relative, resolve } from 'node:path';
import { pathToFileURL } from 'node:url';
import pg from 'pg';
import { checkStatement, exemption, type Binding } from '../../support/partition-binding.ts';

const source = new URL('../../../src/semantic/', import.meta.url).pathname;
const literal = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs;
const statement =
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|VALUES|TABLE|COPY|CALL|DO|TRUNCATE|LOCK|EXPLAIN|CREATE|ALTER|DROP|GRANT|REVOKE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LISTEN|NOTIFY)\s+\S/i;
const transactionControl = /^(?:BEGIN ISOLATION LEVEL |SET LOCAL )/;
const sqlImport = /^import\s+\w+\s+from\s+'([^']+\.sql)'/gm;

type Query = { sql?: string; raw?: string; params?: string[] };

/** Every string literal in one semantic source file that reads as SQL, except transaction control, as `file:line text`. */
export async function inlineStatements(file: string): Promise<string[]> {
  const text = await Bun.file(`${source}${file}`).text();
  const found: string[] = [];
  for (const match of text.matchAll(literal)) {
    const sql = match[2]!;
    if (!statement.test(sql) || transactionControl.test(sql)) continue;
    const line = text.slice(0, match.index).split('\n').length;
    found.push(`${file}:${line} ${sql.split('\n')[0]!.trim()}`);
  }
  return found;
}

/** The partition binding of every `.sql` file one semantic source file imports, by path under `src/semantic`. */
export async function statementBindings(
  client: Pick<pg.Pool, 'query'>,
  file: string,
): Promise<{ file: string; binding: Binding | { exempt: string } }[]> {
  const text = await Bun.file(`${source}${file}`).text();
  const results: { file: string; binding: Binding | { exempt: string } }[] = [];
  for (const match of text.matchAll(sqlImport)) {
    const path = resolve(dirname(`${source}${file}`), match[1]!);
    const query = ((await import(pathToFileURL(path).href)) as { default?: Query }).default;
    if (!query) throw new Error(`${path} did not load as a reylo query`);
    const raw = query.raw ?? query.sql ?? '';
    const reason = exemption(raw);
    const binding = reason
      ? { exempt: reason }
      : await checkStatement(client, { sql: query.sql ?? raw, params: query.params ?? [] });
    results.push({ file: relative(source, path), binding });
  }
  return results.sort((a, b) => (a.file < b.file ? -1 : a.file > b.file ? 1 : 0));
}

/**
 * Registers the two placement tests for one group of semantic source files: no SQL text in TypeScript but
 * transaction control, and every statement the files import bound to one partition, with no exemption.
 */
export function guardStatements(name: string, files: readonly string[]): void {
  test(`semantic ${name} sends no SQL text but transaction control`, async () => {
    expect((await Promise.all(files.map(inlineStatements))).flat()).toEqual([]);
  });

  test(`every statement semantic ${name} imports is bound to one partition`, async () => {
    const databaseUrl = process.env.DATABASE_URL;
    if (!databaseUrl) throw new Error('DATABASE_URL must name the migrated test database');
    const pool = new pg.Pool({ connectionString: databaseUrl, max: 1 });
    try {
      const unbound: { file: string; binding: Binding | { exempt: string } }[] = [];
      for (const file of files)
        for (const result of await statementBindings(pool, file))
          if (!('bound' in result.binding && result.binding.bound)) unbound.push(result);
      expect(unbound).toEqual([]);
    } finally {
      await pool.end();
    }
  });
}

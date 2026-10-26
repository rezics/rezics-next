import { expect, test } from 'bun:test';
import { Glob } from 'bun';

const source = new URL('../../src/content/', import.meta.url).pathname;
const literal = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs;
const statement =
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|VALUES|TABLE|COPY|CALL|DO|TRUNCATE|LOCK|EXPLAIN|CREATE|ALTER|DROP|GRANT|REVOKE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LISTEN|NOTIFY)\s+\S/i;
const transactionControl = /^(?:BEGIN ISOLATION LEVEL |SET LOCAL )/;

test('content source sends no SQL text but transaction control; every statement is a typed .sql file', async () => {
  const found: string[] = [];
  for await (const file of new Glob('**/*.ts').scan(source)) {
    const text = await Bun.file(`${source}${file}`).text();
    for (const match of text.matchAll(literal)) {
      const sql = match[2]!;
      if (!statement.test(sql) || transactionControl.test(sql)) continue;
      const line = text.slice(0, match.index).split('\n').length;
      found.push(`${file}:${line} ${sql.split('\n')[0]!.trim()}`);
    }
  }
  expect(found.sort()).toEqual([]);
});

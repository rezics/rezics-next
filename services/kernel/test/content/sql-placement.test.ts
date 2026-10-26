import { expect, test } from 'bun:test';
import { Glob } from 'bun';

const source = new URL('../../src/', import.meta.url).pathname;
const literal = /(['"`])((?:\\.|(?!\1)[^\\])*)\1/gs;
const statement =
  /^\s*(?:SELECT|INSERT|UPDATE|DELETE|MERGE|WITH|VALUES|TABLE|COPY|CALL|DO|TRUNCATE|LOCK|EXPLAIN|CREATE|ALTER|DROP|GRANT|REVOKE|BEGIN|START|COMMIT|ROLLBACK|SAVEPOINT|RELEASE|SET|RESET|LISTEN|NOTIFY)\s+\S/i;
const transactionControl = /^(?:BEGIN ISOLATION LEVEL |SET LOCAL )/;

test('content source and http/kernel.ts send no SQL text but transaction control', async () => {
  const files = [...(await Array.fromAsync(new Glob('content/**/*.ts').scan(source))), 'http/kernel.ts'];
  const found: string[] = [];
  for (const file of files) {
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

import { expect, test } from 'bun:test';
import { defineQuery } from 'reylo';
import { resolve } from 'node:path';
import { SQL_COMMENT_BYTE_BOUND, statementBytes } from '../src/sql/statement-bytes.ts';

test('SQL work bounds include the comment Reylo adds only at dispatch', async () => {
  for (const source of ["src/é'--query.sql", 'src/plain.sql']) {
    const query = defineQuery<{}, { answer: number }, 'one'>({
      dialect: 'postgres', sql: 'SELECT 7 AS answer; -- trailing comment', params: [],
      cardinality: 'one', source, sqlcommenter: true,
    });
    let sent = '';
    const client = { async query(text: string) {
      sent = text;
      return { rows: [{ answer: 7 }], fields: [] };
    } };
    expect(await query.run(client, {})).toEqual({ answer: 7 });
    expect(query.sql).not.toContain('/*file=');
    expect(sent).toContain('/*file=');
    expect(statementBytes(query)).toBeGreaterThanOrEqual(Buffer.byteLength(sent));
    expect(statementBytes(query.sql)).toBeGreaterThanOrEqual(Buffer.byteLength(sent));
  }
  const root = resolve(import.meta.dir, '..');
  for (const file of new Bun.Glob('src/**/*.sql').scanSync({ cwd: root })) {
    // Analysis projects live below .temp; include their relative-path prefix.
    const source = `../../../../../../${file}`;
    expect(Buffer.byteLength(` /*file='${encodeURIComponent(source)}'*/`)).toBeLessThan(SQL_COMMENT_BYTE_BOUND);
  }
});

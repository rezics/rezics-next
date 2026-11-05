import { Client } from 'pg';
import { jsonParameter } from '../../src/database/json.ts';
import { expect, test } from 'bun:test';
import { defineQuery, type Json } from 'reylo';
import { resolve } from 'node:path';
import { SQL_COMMENT_BYTE_BOUND, statementBytes } from '../../src/database/statement-bytes.ts';
import fence from '../../src/command/fence.sql';
import noEffectFence from '../../src/command/no-effect-fence.sql';

test('SQL work bounds include the comment Reylo adds only at dispatch', async () => {
  for (const source of ["src/é'--query.sql", 'src/plain.sql']) {
    const query = defineQuery<{}, { answer: number }, 'one', 'postgres'>({
      dialect: 'postgres',
      sql: 'SELECT 7 AS answer; -- trailing comment',
      params: [],
      cardinality: 'one',
      source,
      sqlcommenter: true,
    });
    let sent = '';
    const client = {
      async query(text: string) {
        sent = text;
        return { rows: [{ answer: 7 }], fields: [] };
      },
    };
    expect(await query.run(client, {})).toEqual({ answer: 7 });
    expect(query.sql).not.toContain('/*file=');
    expect(sent).toContain('/*file=');
    expect(statementBytes(query)).toBeGreaterThanOrEqual(Buffer.byteLength(sent));
    expect(statementBytes(query.sql)).toBeGreaterThanOrEqual(Buffer.byteLength(sent));
  }
  const root = resolve(import.meta.dir, '../..');
  for (const file of new Bun.Glob('src/**/*.sql').scanSync({ cwd: root })) {
    // Analysis projects live below .temp; include their relative-path prefix.
    const source = `../../../../../../${file}`;
    expect(Buffer.byteLength(` /*file='${encodeURIComponent(source)}'*/`)).toBeLessThan(SQL_COMMENT_BYTE_BOUND);
  }
});

test('the server SQL import graph loads against the migrated check database', async () => {
  const { startServer } = await import('../../src/server.ts');
  expect(typeof startServer).toBe('function');
}, 300_000);

// The runtime driver, SQL mapper and native engine must agree on JSON and parameter subscripts.
test('JSON wire values and parameter subscripts survive a PostgreSQL round trip', async () => {
  const transport = defineQuery<{ body: Json; index: number }, { body: Json; tag: string | null }, 'one', 'postgres'>({
    dialect: 'postgres',
    sql: "SELECT :body::jsonb AS body, (ARRAY['first', 'second'])[(:index::int)] AS tag;",
    params: ['body', 'index'],
    cardinality: 'one',
  });
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    const input = Object.freeze({ refs: Object.freeze([{ label: "é'", omitted: undefined }]), missing: null });
    const row = await transport.run(client, { body: jsonParameter(input), index: 2 });
    expect(row).toEqual({ body: { refs: [{ label: "é'" }], missing: null }, tag: 'second' });
  } finally {
    await client.end();
  }
});

test('absent command metadata writes neither a receipt nor an editorial basis', async () => {
  const client = new Client({ connectionString: process.env.DATABASE_URL });
  await client.connect();
  try {
    await client.query('BEGIN');
    const metadata = () =>
      client.query(`SELECT
      (SELECT count(*) FROM core.receipt WHERE partition_no = 4095) AS receipts,
      (SELECT count(*) FROM editorial.write_basis WHERE partition_no = 4095) AS bases`);
    const before = await metadata();
    const input = { partition_no: 4095, transaction_id: Bun.randomUUIDv7(), receipt: null };
    expect(await fence.run(client, { ...input, events: [], basis: null })).toHaveLength(1);
    expect(await noEffectFence.run(client, input)).toHaveLength(1);
    expect((await metadata()).rows).toEqual(before.rows);
  } finally {
    await client.query('ROLLBACK');
    await client.end();
  }
});

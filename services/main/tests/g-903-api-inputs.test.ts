import { expect, test } from 'bun:test';
import { resolve } from 'node:path';
import type { SqlRequestFlow } from './g-903-sql-flow.ts';

async function flows(root: string, paths: string[], files?: Record<string, string>): Promise<SqlRequestFlow[]> {
  const child = Bun.spawn(['node', '--experimental-strip-types', resolve(import.meta.dir, 'g-903-sql-flow.ts')], {
    stdin: 'pipe', stdout: 'pipe', stderr: 'pipe',
  });
  await child.stdin.write(JSON.stringify({ root, paths, files }));
  await child.stdin.end();
  const [output, error, status] = await Promise.all([
    new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
  ]);
  if (status !== 0) throw new Error(`SQL flow compiler failed: ${error}`);
  return JSON.parse(output);
}

test('G-903 integration requests never depend on owner SELECT results', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const paths = [...new Bun.Glob('tests/qa/integration/**/*.ts').scanSync({ cwd: root })]
    .map(path => resolve(root, path));
  // New fixtures have no exemption. Owner-state assertions and setup-only reads
  // remain permitted because they never flow into a client request.
  expect(await flows(root, paths)).toEqual([]);
}, 120_000);

test('G-903 guard traces aliases, helper returns and request URLs while allowing inspection', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const fileName = resolve(root, '.temp/g-903-guard/fixture.ts');
  const result = await flows(root, [fileName], { [fileName]: `
    const pool: any = {}; const app: any = {};
    const request = async (path: string, body: object) => app.handle(new Request(path, { body: JSON.stringify(body) }));
    const scope = async () => (await pool.query('SELECT authority_epoch FROM access.scope_gate')).rows[0].authority_epoch;
    const alias = await scope();
    request('/v1/access/changes', { expectedAuthorityEpoch: alias });
    const id = (await pool.query('SELECT id FROM content.reply')).rows[0].id;
    fetch('/v1/replies/' + id);
    const inspect = await pool.query('SELECT state FROM access.admission');
    console.log(inspect.rows);
    await pool.query('INSERT INTO access.principal VALUES ($1)', [id]);
    const statement = 'WITH current AS (SELECT id FROM access.representation) SELECT id FROM current';
    const { rows } = await pool.query(statement);
    const payload = { representationId: rows[0].id };
    request('/v1/access/changes', payload);
    const record = () => ({ generation: (pool.query('SELECT generation FROM access.representation')).rows[0].generation });
    const returned = record();
    request('/v1/access/changes', { expectedGeneration: returned.generation });
    new Request('/v1/changes', { body: JSON.stringify(payload) });
    const encoded = (await pool.query('SELECT raw_bytes FROM "source".observation')).rows[0].raw_bytes;
    fetch('/v1/changes/' + JSON.parse(Buffer.from(encoded).toString('utf8')).location);
  ` });
  expect(result.map(flow => flow.request)).toEqual([6, 8, 15, 18, 19, 21].map(line => `${fileName}:${line}`));
});

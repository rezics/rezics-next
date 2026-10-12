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
  if (Bun.env.SQL_REQUEST_FLOW_PROFILE === '1') console.info(error.trim());
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
    app.get('/cards', () => alias);
    app.get('/handler-request', () => fetch('/v1/replies/' + id));
    app.get('/v1/replies/' + id);
  ` });
  expect(result.map(flow => flow.request)).toEqual([3, 3, 3, 8, 19, 21, 23].map(line => `${fileName}:${line}`));
});

test('SQL request flow guard resolves request clients while allowing router and storage declarations', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const fileName = resolve(root, '.temp/g-903-guard/resolved-clients.ts');
  const result = await flows(root, [fileName], { [fileName]: `
    import { get } from 'node:http';
    import { Elysia } from 'elysia';
    const pool: any = {};
    const id = (await pool.query('SELECT id FROM content.reply')).rows[0].id;
    get('http://main.local/v1/replies/' + id, response => response.resume());
    get('http://main.local/v1/replies/' + id);
    const router = new Elysia();
    router.get('/cards/' + id, () => id);
    router.get('/handler-request', () => fetch('/v1/replies/' + id));
    const collection = new Map<string, string>();
    collection.get(id);
    const client = { get: (path: string, callback: () => void) => {} };
    client.get('/v1/replies/' + id, () => {});
    const owner = { read: (path: string) => {} };
    owner.read('/v1/replies/' + id);
    const storage: any = {};
    storage.get('/v1/replies/' + id, () => {});
    const { DiscoveryRefreshInputs } = await import('../../services/main/src/modules/discovery/source.ts');
    const retained = new DiscoveryRefreshInputs(pool, 'fixture');
    retained.read({ dataEpoch: 'fixture', sequence: id }, id);
  ` });
  expect(result.map(flow => flow.request)).toEqual([6, 7, 10].map(line => `${fileName}:${line}`));
});

test('SQL request flow guard request sink and return origin case table', async () => {
  const root = resolve(import.meta.dir, '../../..');
  const select = `(await pool.query('SELECT id FROM content.reply')).rows[0].id`;
  // Each module isolates its symbols; one compiler run checks the entire table.
  // Expected lines identify both endpoints, so a storage call cannot stand in
  // for the eventual request and API results cannot acquire SELECT origins.
  const cases: { id: string; source: string; flow: string; expected: string[] }[] = [
    {
      id: 'inline-select-fetch',
      source: `const id = ${select};`,
      flow: `fetch('/v1/replies/' + id);`,
      expected: [`fetch('/v1/replies/' + id);`],
    },
    {
      id: 'helper-select-result',
      source: `const store = { read: async () => ${select} };`,
      flow: `const id = await store.read();\nfetch('/v1/replies/' + id);`,
      expected: [`fetch('/v1/replies/' + id);`],
    },
    {
      id: 'helper-api-result',
      source: `const store = { read: async () => (await (await fetch('/v1/replies')).json()).id };`,
      flow: `const id = await store.read();\nfetch('/v1/replies/' + id);`,
      expected: [],
    },
    {
      id: 'node-http-response-callback',
      source: `const id = ${select};`,
      flow: `import { get } from 'node:http';\nget('http://main.local/v1/replies/' + id, response => response.resume());`,
      expected: [`get('http://main.local/v1/replies/' + id, response => response.resume());`],
    },
    {
      id: 'aliased-node-http-client',
      source: `const id = ${select};`,
      flow: `import { get as read } from 'node:http';\nread('http://main.local/v1/replies/' + id, response => response.resume());`,
      expected: [`read('http://main.local/v1/replies/' + id, response => response.resume());`],
    },
    {
      id: 'router-inline-callback',
      source: `const id = ${select};`,
      flow: `import { Elysia } from 'elysia';\nnew Elysia().get('/v1/replies/' + id, () => id);`,
      expected: [],
    },
    ...['get', 'post', 'put', 'patch'].map(method => ({
      id: `storage-${method}-result`,
      source: `const id = ${select};`,
      flow: `const store = { ${method}: (key: string) => key };\nconst returned = store.${method}(id);\nfetch('/v1/replies/' + returned);`,
      expected: [`fetch('/v1/replies/' + returned);`],
    })),
    {
      id: 'storage-class-method-result',
      source: `const id = ${select};`,
      flow: `class Store { get(key: string) { return key; } }\nconst returned = new Store().get(id);\nfetch('/v1/replies/' + returned);`,
      expected: [`fetch('/v1/replies/' + returned);`],
    },
    {
      id: 'test-client-body',
      source: `const id = ${select};`,
      flow: `import { Elysia } from 'elysia';\nconst app = new Elysia();\nconst client = { request: (body: object) => app.handle(new Request('http://main.local/v1/replies', { method: 'POST', body: JSON.stringify(body) })) };\nclient.request({ id });`,
      expected: [
        `const client = { request: (body: object) => app.handle(new Request('http://main.local/v1/replies', { method: 'POST', body: JSON.stringify(body) })) };`,
      ],
    },
    {
      id: 'requesting-helper-select-result',
      source: `const client = { request: async () => { await fetch('/v1/health'); return ${select}; } };`,
      flow: `const id = await client.request();\nfetch('/v1/replies/' + id);`,
      expected: [`fetch('/v1/replies/' + id);`],
    },
    {
      id: 'test-client-object-body',
      source: `const id = ${select};`,
      flow: `const client = (body: object) => fetch('/v1/replies', { method: 'POST', body: JSON.stringify(body) });\nconst payload = { id };\nclient(payload);`,
      expected: [`const client = (body: object) => fetch('/v1/replies', { method: 'POST', body: JSON.stringify(body) });`],
    },
    {
      id: 'imported-test-client-body',
      source: `const id = ${select};`,
      flow: `import { client } from './client.ts';\nclient.post({ id });`,
      expected: [`client.post({ id });`],
    },
    {
      id: 'test-client-inspection-sibling',
      source: `const retainedId = ${select};`,
      flow: `const member = { token: 'fixture', retainedId };\nconst client = (person: typeof member) => fetch('/v1/replies', { headers: person ? { authorization: person.token } : {} });\nclient(member);`,
      expected: [],
    },
    {
      id: 'nested-helper-results',
      source: `const store = { read: async () => ${select} };`,
      flow: `const first = async () => await store.read();\nconst second = async () => await first();\nfetch('/v1/replies/' + await second());`,
      expected: [`fetch('/v1/replies/' + await second());`],
    },
    {
      id: 'requesting-helper-argument-result',
      source: `const id = ${select};`,
      flow: `const client = { request: async (id: string) => { await fetch('/v1/health'); return id; } };\nconst returned = await client.request(id);\nfetch('/v1/replies/' + returned);`,
      expected: [`fetch('/v1/replies/' + returned);`],
    },
    {
      id: 'helper-call-origin-isolation',
      source: `const id = ${select};`,
      flow: `const store = { get: (id: string) => id };\nstore.get(id);\nconst apiId = (await (await fetch('/v1/replies')).json()).id;\nfetch('/v1/replies/' + store.get(apiId));`,
      expected: [],
    },
    {
      id: 'helper-select-predicate-result',
      source: `const id = ${select};`,
      flow: `const choose = (id: string) => id ? '/v1/replies/one' : '/v1/replies/two';\nfetch(choose(id));`,
      expected: [`fetch(choose(id));`],
    },
    {
      id: 'recursive-helper-fields-converge',
      source: `const id = ${select};`,
      flow: `const nested = (row: any): string => row.next ? nested(row.next) : row.id;\nfetch('/v1/replies/' + nested({ next: { id } }));`,
      expected: [`fetch('/v1/replies/' + nested({ next: { id } }));`],
    },
    {
      id: 'destructured-select-result',
      source: `const read = async () => ({ id: ${select} });`,
      flow: `const { id } = await read();\nfetch('/v1/replies/' + id);`,
      expected: [`fetch('/v1/replies/' + id);`],
    },
    {
      id: 'spread-select-result',
      source: `const read = async () => ({ id: ${select} });`,
      flow: `const result = await read();\nfetch('/v1/replies', { method: 'POST', body: JSON.stringify({ ...result }) });`,
      expected: [`fetch('/v1/replies', { method: 'POST', body: JSON.stringify({ ...result }) });`],
    },
    {
      id: 'destructured-spread-shorthand-result',
      source: `const id = ${select};`,
      flow: `const read = async () => ({ id });\nconst result = await read();\nconst { id: returned } = { ...result };\nfetch('/v1/replies/' + returned);`,
      expected: [`fetch('/v1/replies/' + returned);`],
    },
    {
      id: 'destructured-spread-api-result',
      source: `const read = async () => ({ id: (await (await fetch('/v1/replies')).json()).id });`,
      flow: `const result = await read();\nconst { id } = result;\nfetch('/v1/replies/' + id, { body: JSON.stringify({ ...result }) });`,
      expected: [],
    },
    {
      id: 'destructured-api-sibling',
      source: `const read = async () => ({ retained: ${select}, id: (await (await fetch('/v1/replies')).json()).id });`,
      flow: `const { id } = await read();\nfetch('/v1/replies/' + id);`,
      expected: [],
    },
    {
      id: 'resolved-supertest-client',
      source: `const id = ${select};`,
      flow: `import request from 'supertest';\nrequest('http://main.local').post('/v1/replies/' + id);`,
      expected: [`request('http://main.local').post('/v1/replies/' + id);`],
    },
  ];
  const files: Record<string, string> = {};
  files[resolve(root, '.temp/g-903-guard/client.ts')] = `export const client = {
    post: (body: object) => fetch('/v1/replies', { method: 'POST', body: JSON.stringify(body) })
  };`;
  const clientTypes = resolve(root, 'node_modules/@types/supertest/index.d.ts');
  // This repository does not install supertest; resolve its declaration just as
  // an installed client's types would, without adding a runtime dependency.
  files[clientTypes] = `export interface SuperTest { post(path: string): unknown }\nexport default function request(url: string): SuperTest;`;
  const paths = cases.map(row => {
    const fileName = resolve(root, `.temp/g-903-guard/${row.id}.ts`);
    files[fileName] = `export {};\nconst pool: any = {};\n${row.source}\n${row.flow}\n`;
    return fileName;
  });
  const result = await flows(root, paths, files);
  for (const [index, row] of cases.entries()) {
    const fileName = paths[index]!;
    const lines = files[fileName]!.split('\n');
    const source = `${fileName}:${lines.findIndex(line => line.includes('SELECT id FROM content.reply')) + 1}`;
    expect(result.filter(flow => flow.request.startsWith(`${fileName}:`))).toEqual(row.expected.map(line => ({
      source, request: `${fileName}:${lines.indexOf(line) + 1}`,
    })));
  }
}, 120_000);

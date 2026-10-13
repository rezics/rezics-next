import { expect, test } from 'bun:test';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandInventory, unreviewedCommands, type CommandInventory, type CommandOpenApi } from './web-accepted-commands.ts';

const root = join(import.meta.dir, '../..');
const api: CommandOpenApi = { paths: { '/v1/works/{work}': { put: { responses: { '200': {}, '202': {} } } } } };
function fixture(files: Record<string, string>, check: (directory: string) => void) {
  const directory = mkdtempSync(join(root, '.temp/accepted-commands-'));
  try {
    for (const [name, source] of Object.entries(files)) writeFileSync(join(directory, name), source);
    check(directory);
  } finally { rmSync(directory, { recursive: true, force: true }); }
}

test('production adapters introduce no completion of admitted commands beyond exact existing debt', () => {
  const declarations = JSON.parse(readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8')) as CommandOpenApi;
  const debt = JSON.parse(readFileSync(join(import.meta.dir, 'web-accepted-commands.json'), 'utf8')) as CommandInventory[];
  expect(debt.every(item => !!item.reason)).toBe(true);
  expect(unreviewedCommands(commandInventory(root, declarations), debt)).toEqual([]);
});

test('comments and new forwarding or pending consumers pass without review or baseline updates', () => {
  fixture({
    'adapter.tsx': 'const record = main.v1.works({ work });\nexport const save = () => record.put(body);\n',
    'new.ts': 'export const save = () => main.v1.works({ work })["put"](body);\n',
    'pending.ts': `export async function save() {
      const { status, data } = await main.v1.works({ work }).put(body);
      if (status === 202) return { ok: false, failure: 'pending' };
      return { ok: true, data };
    }`,
  }, directory => {
    const before = commandInventory(root, api, directory);
    expect(before[0]!.operations).toEqual(['PUT /v1/works/{work} [202]']);
    expect(unreviewedCommands(before, [])).toEqual([]);
    writeFileSync(join(directory, 'adapter.tsx'), '// Describe the unchanged request.\nconst record = main.v1.works({ work });\nexport const save = () => record.put(body);\n');
    expect(commandInventory(root, api, directory)).toEqual(before);
    const synchronous: CommandOpenApi = { paths: { '/v1/works/{work}': { put: { responses: { '200': {} } } } } };
    expect(commandInventory(root, synchronous, directory)).toEqual([]);
  });
});

test.each([
  `await record.put(body);`,
  `const answer = await record.put(body); return { status: answer.status, kind: 'saved' };`,
  `const answer = await record.put(body); return { receipt: answer.data.operationId };`,
  `await record.put(body); return { ok: true, pending: true, completed: true };`,
  `await record.put(body); return { completed: true };`,
  `const answer = await record.put(body); return { ok: true, data: answer.data };`,
  `const answer = await record.put(body); if (answer.data) return { outcome: 'created', id: answer.data.id };`,
  `const answer = await record.put(body); const pending = answer.status === 202; return { kind: 'saved' };`,
  `const answer = await record.put(body); if (answer.status === 202) return { completed: true }; return { ok: false };`,
  `const answer = await record.put(body); return { completed: true }; if (answer.status === 202) return { failure: 'pending' };`,
])('admission cannot reach a completion return: %s', body => {
  fixture({ 'new.ts': `const record = main.v1.works({ work }); export const save = async () => { ${body} };` }, directory => {
    const actual = commandInventory(root, api, directory);
    expect(unreviewedCommands(actual, [])).toHaveLength(1);
    expect(actual[0]!.completions).toEqual(['PUT /v1/works/{work} [202]']);
  });
});

test('forwarding aliases and imported settling helpers cannot hide completion', () => {
  fixture({
    'bad.ts': `const record = main.v1.works({ work }); const put = () => record.put(body);
      export async function save() { await put(); return { completed: true }; }`,
    'helper.ts': `export async function settle(call) { const answer = await call(); return { ok: true, data: answer.data }; }`,
    'wrapped.ts': `import { settle as send } from './helper.ts';
      export const save = () => send(() => main.v1.works({ work }).put(body));`,
  }, directory => {
    expect(unreviewedCommands(commandInventory(root, api, directory), [])).toHaveLength(2);
    writeFileSync(join(directory, 'helper.ts'), `export async function settle(call) {
      const answer = await call(); if (answer.status === 202) return { ok: false, failure: 'pending' };
      return { ok: true, data: answer.data }; }`);
    expect(unreviewedCommands(commandInventory(root, api, directory), [])).toHaveLength(1);
  });
});

test('a pending word, comment, or a safe sibling does not exempt another command', () => {
  fixture({ 'adapter.ts': `export async function safe() {
    const answer = await main.v1.works({ work }).put(body);
    if (answer.status === 202) return { ok: false, failure: 'pending' };
    return { ok: true, data: answer.data };
  }
  // pending admission must never mean completed
  export async function bad() { await main.v1.works({ work }).put(body); return { completed: true }; }` }, directory => {
    const actual = commandInventory(root, api, directory);
    expect(actual[0]!.operations).toHaveLength(2);
    expect(actual[0]!.completions).toHaveLength(1);
    const debt = actual.map(item => ({ ...item, completions: [...item.completions] }));
    writeFileSync(join(directory, 'extra.ts'), 'export async function bad() { await main.v1.works({ work }).put(body); return { completed: true }; }');
    expect(unreviewedCommands(commandInventory(root, api, directory), debt)).toHaveLength(1);
  });
});

test('unresolved aliases remain listed by exact path and operation', () => {
  fixture({ 'unknown.ts': 'export const save = () => hidden.post(body);' }, directory => {
    expect(commandInventory(root, api, directory)[0]!.operations).toEqual(['UNRESOLVED POST hidden.post']);
  });
});

test('promise continuations and grouped writes preserve pending outcomes', () => {
  fixture({
    'bad.ts': `export const save = () => main.v1.works({ work }).put(body).then(() => ({ completed: true }));`,
    'good.ts': `export const save = () => main.v1.works({ work }).put(body).then(answer =>
      answer.status === 202 ? { ok: false, failure: 'pending' } : { ok: true, data: answer.data });`,
    'group.ts': `export async function save() {
      const [answer] = await Promise.all([main.v1.works({ work }).put(body)]);
      switch (answer.status) { case 202: return { ok: false, failure: 'pending' }; default: return { ok: true }; }
    }`,
  }, directory => {
    const actual = commandInventory(root, api, directory);
    expect(unreviewedCommands(actual, []).map(item => item.path.split('/').at(-1))).toEqual(['bad.ts']);
    writeFileSync(join(directory, 'group.ts'), `export async function save() {
      const [answer] = await Promise.all([main.v1.works({ work }).put(body)]);
      switch (answer.status) { case 202: return { completed: true }; default: return { ok: false }; }
    }`);
    expect(unreviewedCommands(commandInventory(root, api, directory), [])).toHaveLength(2);
  });
});

test('existing debt cannot admit an extra bad consumer in the same adapter', () => {
  const source = `export async function existing() { await main.v1.works({ work }).put(body); return { completed: true }; }`;
  fixture({ 'adapter.ts': source }, directory => {
    const debt = commandInventory(root, api, directory);
    writeFileSync(join(directory, 'adapter.ts'), `${source}\nexport async function added() {
      await main.v1.works({ work }).put(body); return { completed: true }; }`);
    expect(unreviewedCommands(commandInventory(root, api, directory), debt)[0]!.completions).toHaveLength(1);
  });
});

test('reused local route aliases do not hide new admission consumers', () => {
  fixture({ 'adapter.ts': `export async function safe() {
      const record = main.v1.works({ work }); const answer = await record.put(body);
      if (answer.status === 202) return { ok: false, failure: 'pending' }; return { ok: true };
    }
    export async function bad() {
      const record = main.v1.works({ work }); await record.put(body); return { completed: true };
    }` }, directory => {
    const actual = commandInventory(root, api, directory);
    expect(actual[0]!.operations).toEqual(['PUT /v1/works/{work} [202]', 'PUT /v1/works/{work} [202]']);
    expect(actual[0]!.completions).toEqual(['PUT /v1/works/{work} [202]']);
  });
});

test('method aliases preserve forwarding and cannot hide completion', () => {
  fixture({ 'adapter.ts': `const record = main.v1.works({ work }); const write = record['put']; const alias = write;
    export const forward = () => alias(body);
    export async function bad() { await alias(body); return { completed: true }; }` }, directory => {
    const actual = commandInventory(root, api, directory);
    expect(actual[0]!.operations).toEqual(['PUT /v1/works/{work} [202]', 'PUT /v1/works/{work} [202]']);
    expect(actual[0]!.completions).toEqual(['PUT /v1/works/{work} [202]']);
  });
});

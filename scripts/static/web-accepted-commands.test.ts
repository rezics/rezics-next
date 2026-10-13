import { expect, test } from 'bun:test';
import { mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { commandInventory, unreviewedCommands, type CommandInventory, type CommandOpenApi } from './web-accepted-commands.ts';

const root = join(import.meta.dir, '../..');
test('production command adapters introduce no unreviewed admission/completion behavior', () => {
  const api = JSON.parse(readFileSync(join(root, 'generated/openapi/main/public.json'), 'utf8')) as CommandOpenApi;
  const reviewed = JSON.parse(readFileSync(join(import.meta.dir, 'web-accepted-commands.json'), 'utf8')) as CommandInventory[];
  expect(reviewed.every(item => !!item.review)).toBe(true);
  expect(unreviewedCommands(commandInventory(root, api), reviewed)).toEqual([]);
});

test('202 declarations, new consumers, aliases and edited completion behavior require review', () => {
  const directory = mkdtempSync(join(root, '.temp/accepted-commands-'));
  const api: CommandOpenApi = { paths: { '/v1/works/{work}': { put: { responses: { '200': {}, '202': {} } } } } };
  const file = join(directory, 'adapter.tsx');
  mkdirSync(directory, { recursive: true });
  try {
    writeFileSync(file, "const record = main.v1.works({ work });\nexport const save = () => record.put(body);\n");
    const reviewed = commandInventory(root, api, directory);
    expect(reviewed[0]!.operations).toEqual(['PUT /v1/works/{work} [202]']);
    expect(unreviewedCommands(reviewed, reviewed)).toEqual([]);
    writeFileSync(file, "// Describe the unchanged request.\nconst record = main.v1.works({ work });\nexport const save = () => record.put(body);\n");
    expect(unreviewedCommands(commandInventory(root, api, directory), reviewed)).toEqual([]);
    const synchronous: CommandOpenApi = { paths: { '/v1/works/{work}': { put: { responses: { '200': {} } } } } };
    expect(commandInventory(root, synchronous, directory)).toEqual([]);
    expect(unreviewedCommands(reviewed, commandInventory(root, synchronous, directory))).toHaveLength(1);
    writeFileSync(file, "const record = main.v1.works({ work });\nexport const save = async () => { await record.put(body); return { completed: true }; };\n");
    expect(unreviewedCommands(commandInventory(root, api, directory), reviewed)).toHaveLength(1);
    writeFileSync(join(directory, 'new.ts'), "export const save = () => main.v1.works({ work })['put'](body);\n");
    expect(unreviewedCommands(commandInventory(root, api, directory), reviewed)).toHaveLength(2);
    writeFileSync(join(directory, 'unknown.ts'), 'export const save = () => hidden.post(body);\n');
    expect(commandInventory(root, api, directory).some(item => item.operations[0]?.startsWith('UNRESOLVED'))).toBe(true);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

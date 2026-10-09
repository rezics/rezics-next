import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoveryProblems,
  scriptDiscoveries,
  scriptProjectPattern,
  unusedScriptFiles,
} from '../../../scripts/static/script-entries.ts';

const repo = join(import.meta.dir, '../../..');

test('a disconnected script helper is reported and a launched script and a scanned file are not', () => {
  const root = mkdtempSync(join(repo, '.temp/script-entries-'));
  try {
    mkdirSync(join(root, 'scripts/scanned'), { recursive: true });
    mkdirSync(join(root, 'scripts/research'), { recursive: true });
    writeFileSync(
      join(root, 'Taskfile.yml'),
      "version: '3'\ntasks:\n  run:\n    cmds:\n      - bun scripts/ran.ts\n",
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({ scripts: { tool: 'bun scripts/pkg-tool.ts' } }),
    );
    writeFileSync(
      join(root, 'scripts/ran.ts'),
      "// bun scripts/disconnected.ts\nimport { used } from './ran-helper.ts';\nimport './spawner.ts';\nexport const ran = used;\n",
    );
    writeFileSync(join(root, 'scripts/ran-helper.ts'), 'export const used = 1;\n');
    writeFileSync(
      join(root, 'scripts/spawner.ts'),
      "export function run() {\n  Bun.spawn(['bun', 'scripts/spawned.ts']);\n}\n",
    );
    writeFileSync(join(root, 'scripts/spawned.ts'), 'export const spawned = 1;\n');
    writeFileSync(join(root, 'scripts/pkg-tool.ts'), 'export const tool = 1;\n');
    writeFileSync(join(root, 'scripts/disconnected.ts'), 'export const orphan = 1;\n');
    writeFileSync(join(root, 'scripts/scanned/entry.ts'), 'export const scanned = 1;\n');
    writeFileSync(
      join(root, 'scripts/scan-entries.ts'),
      "import { readdirSync } from 'node:fs';\nexport const load = () => readdirSync('scripts/scanned');\n",
    );
    writeFileSync(join(root, 'scripts/research/orphan.ts'), 'export const hidden = 1;\n');
    const discoveries = [
      { pattern: 'scripts/scanned/*.ts', discoveredBy: 'scripts/scan-entries.ts' },
    ];
    expect(discoveryProblems(root, discoveries)).toEqual([]);
    const unused = unusedScriptFiles(root, { discoveries });
    expect(unused).toContain('scripts/disconnected.ts');
    expect(unused).not.toContain('scripts/ran.ts');
    expect(unused).not.toContain('scripts/ran-helper.ts');
    expect(unused).not.toContain('scripts/spawner.ts');
    expect(unused).not.toContain('scripts/spawned.ts');
    expect(unused).not.toContain('scripts/pkg-tool.ts');
    expect(unused).not.toContain('scripts/scanned/entry.ts');
    expect(unused).not.toContain('scripts/research/orphan.ts');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('each script discovery is declared once and names a directory scan', () => {
  expect(discoveryProblems(repo)).toEqual([]);
  expect(new Set(scriptDiscoveries.map((item) => item.pattern)).size).toBe(
    scriptDiscoveries.length,
  );
  expect(readFileSync(join(repo, 'knip.jsonc'), 'utf8').includes(scriptProjectPattern)).toBe(false);
});

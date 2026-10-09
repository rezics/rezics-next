import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import {
  discoveryProblems,
  scriptDiscoveries,
  scriptEntryFiles,
  scriptProjectPattern,
} from '../../../scripts/static/script-entries.ts';

const repo = join(import.meta.dir, '../../..');

test('Knip reports a disconnected script helper and not a launched or scanned file', () => {
  const root = mkdtempSync(join(repo, '.temp/script-entries-'));
  try {
    mkdirSync(join(root, 'scripts/scanned'), { recursive: true });
    writeFileSync(
      join(root, 'Taskfile.yml'),
      "version: '3'\ntasks:\n  run:\n    cmds:\n      - bun scripts/ran.ts\n",
    );
    writeFileSync(
      join(root, 'package.json'),
      JSON.stringify({
        name: 'script-entries-fixture',
        private: true,
        scripts: { tool: 'bun scripts/pkg-tool.ts' },
      }),
    );
    writeFileSync(
      join(root, 'scripts/ran.ts'),
      "import { used } from './ran-helper.ts';\nimport './spawner.ts';\nexport const ran = used;\n",
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
    const discoveries = [
      { pattern: 'scripts/scanned/*.ts', discoveredBy: 'scripts/scan-entries.ts' },
    ];
    expect(discoveryProblems(root, discoveries)).toEqual([]);
    const entries = scriptEntryFiles(root, discoveries);
    expect(entries).toContain('scripts/ran.ts');
    expect(entries).toContain('scripts/scanned/entry.ts');
    expect(entries).not.toContain('scripts/disconnected.ts');
    writeFileSync(
      join(root, 'knip.json'),
      JSON.stringify({ entry: entries, project: [scriptProjectPattern] }),
    );
    const result = Bun.spawnSync({
      cmd: [
        join(repo, 'node_modules/.bin/knip'),
        '--no-progress',
        '--no-gitignore',
        '--include',
        'files',
        '--reporter',
        'json',
      ],
      cwd: root,
      stdout: 'pipe',
      stderr: 'pipe',
    });
    expect(result.exitCode, `${result.stdout}${result.stderr}`).toBe(1);
    const report = JSON.parse(result.stdout.toString()) as {
      issues: { file: string; files?: unknown[] }[];
    };
    const unused = report.issues.filter((issue) => issue.files?.length).map((issue) => issue.file);
    expect(unused).toContain('scripts/disconnected.ts');
    expect(unused).not.toContain('scripts/ran.ts');
    expect(unused).not.toContain('scripts/ran-helper.ts');
    expect(unused).not.toContain('scripts/spawned.ts');
    expect(unused).not.toContain('scripts/pkg-tool.ts');
    expect(unused).not.toContain('scripts/scanned/entry.ts');
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

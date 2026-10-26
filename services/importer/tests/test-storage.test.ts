import { expect, test } from 'bun:test';
import { readdir, readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

const root = resolve(import.meta.dir, '../../..');

async function sourceFiles(directory: string): Promise<string[]> {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map(async (entry) => {
      const path = resolve(directory, entry.name);
      if (entry.isDirectory()) return sourceFiles(path);
      return entry.isFile() && entry.name.endsWith('.ts') ? [path] : [];
    }),
  );
  return nested.flat();
}

test('imports test state lives in the system temporary directory', async () => {
  const specsDirectory = resolve(root, 'specs');
  const specs = (await readdir(specsDirectory))
    .filter((name) => /^imports-.*\.test\.ts$/.test(name))
    .map((name) => resolve(specsDirectory, name));
  const importerTests = await sourceFiles(resolve(root, 'services/importer/tests'));
  const files = [...specs, ...importerTests];
  const violations: string[] = [];
  const call = /\bmkdtemp(?:Sync)?\s*\(\s*(?:resolve\s*\(\s*)?(['"`])([^'"`]+)\1/g;

  for (const file of files) {
    const source = await readFile(file, 'utf8');
    for (const match of source.matchAll(call)) {
      const prefix = match[2]!.replaceAll('\\', '/');
      if (prefix === '.temp' || prefix.startsWith('.temp/')) {
        const line = source.slice(0, match.index).split('\n').length;
        violations.push(`${file.slice(root.length + 1)}:${line}`);
      }
    }
  }

  expect(
    violations,
    `Imports test directories must use the system temporary directory:\n${violations.join('\n')}`,
  ).toEqual([]);
});

import { expect, test } from 'bun:test';
import { readdirSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

const source = join(import.meta.dir, '../src');

function sourceFiles(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) => {
    const path = join(directory, entry.name);
    if (entry.isDirectory()) return sourceFiles(path);
    return /\.tsx?$/.test(entry.name) ? [path] : [];
  });
}

test('web source never derives a displayed name from a type identifier local name', () => {
  const localName = /\b(?:type|typeId|typeKey|typeCurie|typeIdentifier)\s*(?:\?\.|\.)\s*split\s*\(\s*['"]:\s*['"]\s*\)/g;
  const hits = sourceFiles(source).flatMap((path) => {
    const contents = readFileSync(path, 'utf8');
    return [...contents.matchAll(localName)].map((match) => `${path}: ${match[0]}`);
  });

  expect(hits).toEqual([]);
});

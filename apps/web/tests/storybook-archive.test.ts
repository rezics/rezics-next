import { afterEach, expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { restoreStorybookArchive, writeStorybookArchive } from '../scripts/storybook-archive.ts';

const roots: string[] = [];
const commit = 'a'.repeat(40);
afterEach(() => {
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
});
function fixture() {
  const temporary = resolve(import.meta.dir, '../../../.temp');
  mkdirSync(temporary, { recursive: true });
  const root = mkdtempSync(resolve(temporary, 'storybook-archive-test-'));
  roots.push(root);
  const output = resolve(root, 'source');
  mkdirSync(output);
  for (const [path, body] of Object.entries({
    'build.json': JSON.stringify({ commit }),
    'index.json': '{}',
    'index.html': '<html></html>',
  }))
    writeFileSync(resolve(output, path), body);
  return { root, output, archive: resolve(root, 'validated.archive'), target: resolve(root, 'target') };
}
function changeManifest(archive: string, change: (manifest: any) => void) {
  const bytes = readFileSync(archive);
  const start = Buffer.from('REZICS-STORYBOOK/1\n').length;
  const length = bytes.readUInt32BE(start);
  const manifest = JSON.parse(bytes.subarray(start + 4, start + 4 + length).toString());
  change(manifest);
  const updated = Buffer.from(JSON.stringify(manifest));
  const size = Buffer.alloc(4);
  size.writeUInt32BE(updated.length);
  writeFileSync(archive, Buffer.concat([bytes.subarray(0, start), size, updated, bytes.subarray(start + 4 + length)]));
}

test('returns more than 64 built assets as one verified publication and replaces stale output', () => {
  const { output, archive, target } = fixture();
  mkdirSync(resolve(output, 'assets'));
  for (let index = 0; index < 100; index++) writeFileSync(resolve(output, `assets/${index}.js`), `asset ${index}`);
  writeStorybookArchive(output, archive, commit);
  mkdirSync(target);
  writeFileSync(resolve(target, 'stale'), 'previous');
  restoreStorybookArchive(archive, target, commit);
  expect(readFileSync(resolve(target, 'assets/99.js'), 'utf8')).toBe('asset 99');
  expect(() => readFileSync(resolve(target, 'stale'))).toThrow();
  expect(JSON.parse(readFileSync(resolve(target, 'build.json'), 'utf8')).commit).toBe(commit);
});

test.each(['revision', 'digest', 'traversal', 'duplicate', 'collision', 'truncated'])(
  'invalid returned %s preserves the existing deployment directory',
  (fault) => {
    const { output, archive, target } = fixture();
    writeStorybookArchive(output, archive, commit);
    mkdirSync(target);
    writeFileSync(resolve(target, 'previous'), 'keep');
    if (fault === 'truncated') writeFileSync(archive, readFileSync(archive).subarray(0, -1));
    else
      changeManifest(archive, (manifest) => {
        if (fault === 'revision') manifest.commit = 'b'.repeat(40);
        if (fault === 'digest') manifest.members[0].sha256 = '0'.repeat(64);
        if (fault === 'traversal') manifest.members[0].path = '../escape';
        if (fault === 'duplicate') manifest.members[1].path = manifest.members[0].path;
        if (fault === 'collision') manifest.members[1].path = `${manifest.members[0].path}/child`;
      });
    expect(() => restoreStorybookArchive(archive, target, commit)).toThrow();
    expect(readFileSync(resolve(target, 'previous'), 'utf8')).toBe('keep');
  },
);

test('does not package a symlink as a publication asset', () => {
  const { output, archive } = fixture();
  symlinkSync(resolve(output, 'build.json'), resolve(output, 'linked.json'));
  expect(() => writeStorybookArchive(output, archive, commit)).toThrow();
});

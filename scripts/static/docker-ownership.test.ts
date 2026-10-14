import { spawnSync } from 'node:child_process';
import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import {
  scanDockerOwnership, scanDockerSpawnFiles, staleDockerSpawnDebt, uncoveredDockerSpawns,
  type DockerSpawn,
} from './docker-ownership.ts';

const root = resolve(import.meta.dir, '../..');
const debt = JSON.parse(readFileSync(new URL('./docker-ownership-debt.json', import.meta.url), 'utf8')) as DockerSpawn[];

test('docker spawns outside the owner-preserving builders stay on the exact debt list', () => {
  const found = scanDockerOwnership(root);
  expect(uncoveredDockerSpawns(found, debt)).toEqual([]);
  expect(staleDockerSpawnDebt(found, debt)).toEqual([]);
});

test('a local docker helper whose spawn passes a builder owns its callers', () => {
  const found = scanDockerSpawnFiles(root, ['scripts/static/fixtures/docker-ownership/owned-helper.ts']);
  expect(found).toEqual([]);
});

test('a local docker helper that does not spawn is still a docker call', () => {
  const found = scanDockerSpawnFiles(root, ['scripts/static/fixtures/docker-ownership/argv-helper.ts']);
  expect(found.map(item => item.call)).toEqual(["docker(['javac', 'Oracle.java'])"]);
});

test('a fixture that spawns docker compose with a bare environment is caught', () => {
  const found = scanDockerSpawnFiles(root, ['scripts/static/fixtures/docker-ownership/bare-compose.ts']);
  expect(found.map(item => item.call)).toEqual([
    "spawnSync('docker', ['compose', 'up', '-d'], { cwd, env: process.env })",
  ]);
  expect(uncoveredDockerSpawns(found, debt)).toEqual(found);
});

// An identity escape still names Docker after tokenization. Candidate filtering
// may avoid unrelated source, but it must keep every program spelling the parser accepts.
test('Docker program identity escapes remain covered by the inventory', () => {
  const temporaryBase = join(root, '.temp');
  mkdirSync(temporaryBase, { recursive: true });
  const directory = mkdtempSync(join(temporaryBase, 'docker-ownership-'));
  expect(spawnSync('git', ['init', '-q', directory]).status).toBe(0);
  try {
    writeFileSync(join(directory, 'escaped.ts'), String.raw`spawnSync('do\cker', ['version'], { env: process.env });`);
    writeFileSync(join(directory, 'unrelated.ts'), `const source = 'ordinary code';`);
    const found = scanDockerSpawnFiles(directory, ['escaped.ts', 'unrelated.ts']);
    expect(found).toHaveLength(1);
    expect(found[0]?.file).toBe('escaped.ts');
    expect(found[0]?.call).toContain(String.raw`'do\cker'`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

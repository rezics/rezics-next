import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
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

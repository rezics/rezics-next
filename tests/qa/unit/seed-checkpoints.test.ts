import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { readRetainedSeed, SEED_BUILD_COMMAND } from '../support/seed-checkpoints.ts';

test('routine seed restore rejects absent, partial and invalid preparation with the explicit build command', () => {
  mkdirSync('.temp/seed-checkpoint-read', { recursive: true });
  const directory = mkdtempSync('.temp/seed-checkpoint-read/check-');
  const path = join(directory, 'retained.json');
  try {
    expect(() => readRetainedSeed(path)).toThrow(`absent. Build them explicitly: ${SEED_BUILD_COMMAND}`);
    writeFileSync(path, JSON.stringify({ format: 'seed-checkpoints-v2', cuts: [] }));
    expect(() => readRetainedSeed(path)).toThrow(`incomplete. Build them explicitly: ${SEED_BUILD_COMMAND}`);
    writeFileSync(path, '{');
    expect(() => readRetainedSeed(path)).toThrow(`invalid. Build them explicitly: ${SEED_BUILD_COMMAND}`);
  } finally { rmSync(directory, { recursive: true, force: true }); }
});

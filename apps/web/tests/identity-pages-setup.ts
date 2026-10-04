import { spawnSync } from 'node:child_process';

/** Seed public API records once before the isolated browser journeys need their published Concept. */
export default function setup() {
  const seed = spawnSync('bun', ['apps/web/tests/identity-pages-seed.ts'], {
    cwd: process.cwd(),
    env: process.env,
    encoding: 'utf8',
    timeout: 300_000,
  });
  if (seed.status !== 0 || seed.error)
    throw new Error(`Identity setup failed: ${seed.stderr || seed.error?.message}`);
}

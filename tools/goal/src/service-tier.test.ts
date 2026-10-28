import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { loadSettings } from './config.ts';
import defaults from '../defaults.json';
import { launchCommand } from './launch.ts';
import { fixturePool, harness } from './test-support.ts';

test('the Codex tier comes from settings: a profile kept from a Fast attempt launches on the configured tier', () => {
  const pool = fixturePool();
  // Built from the package defaults so the test needs no Git checkout (promotion runs it in a plain copy).
  const codex = { ...(defaults.codex as object), serviceTier: 'default' } as NonNullable<Parameters<typeof launchCommand>[0]['codex']>;
  const [, args] = launchCommand({
    profile: { cli: 'codex', model: 'gpt-6.1-sol', effort: 'high', poolClass: 'codex', serviceTier: 'fast' },
    pool: { ...pool, cli: 'codex', command: 'codex' },
    worktree: '/fixture',
    prompt: 'contract',
    logPath: '/fixture/log',
    codex,
  });
  expect(args).toContain('service_tier="default"');
  expect(args).not.toContain('service_tier="fast"');
});

test('a burn ceiling below one percent an hour is a valid pool policy; zero and negative are not', () => {
  const h = harness();
  try {
    const initial = loadSettings({ cwd: h.root, env: {} });
    const local = JSON.parse(readFileSync(initial.localFile, 'utf8'));
    local.pools[0].policy = { ...local.pools[0].policy, maxBurnPerHour: 0.55 };
    writeFileSync(initial.localFile, JSON.stringify(local));
    expect(loadSettings({ cwd: h.root, env: {} }).pools[0]!.policy?.maxBurnPerHour).toBe(0.55);
    for (const invalid of [0, -1]) {
      local.pools[0].policy.maxBurnPerHour = invalid;
      writeFileSync(initial.localFile, JSON.stringify(local));
      expect(() => loadSettings({ cwd: h.root, env: {} })).toThrow('invalid maxBurnPerHour');
    }
  } finally {
    h.dispose();
  }
});

import { createHash } from 'node:crypto';
import { mkdirSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { claudeAdapter, parseClaudeUsage, readClaudeUsage } from './claude.ts';
import type { Pool } from '../types.ts';

let poolNumber = 0;
function makePool(): Pool {
  const name = `claude-observation-${process.pid}-${poolNumber++}`;
  return {
    name,
    cli: 'claude',
    classes: ['claude'],
    command: '/bin/claude',
    configDirectory: `/missing/${name}`,
    allowanceKey: name,
    policy: { weight: 1, reservePercent: 15, allowUnknown: false, maxAgeMs: 21600000 },
  };
}

function cachePath(pool: Pool): string {
  return join(
    tmpdir(),
    `goal-claude-usage-${createHash('sha256').update(pool.configDirectory).digest('hex').slice(0, 16)}.json`,
  );
}

test('malformed Claude usage responses become truthful unknown readings', () => {
  const pool = makePool();
  const reading = parseClaudeUsage('{"five_hour":', pool, Date.parse('2026-11-03T00:00:00Z'));
  expect(reading).toMatchObject({
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    observedAt: null,
    windows: [],
    error: 'Claude OAuth usage response was invalid',
  });
});

test('damaged, future and foreign-identity cache entries are not fresh observations', () => {
  const pool = makePool();
  const now = Date.parse('2026-11-03T00:00:00Z');
  const cache = cachePath(pool);
  const goodShape = {
    pool: pool.name,
    allowanceKey: pool.allowanceKey,
    at: new Date(now).toISOString(),
    observedAt: new Date(now - 1_000).toISOString(),
    windows: [{ usedPercent: 20, resetsAt: null, minutes: 300 }],
    exhausted: false,
    error: null,
  };
  try {
    for (const data of [
      '{damaged cache',
      JSON.stringify({ ...goodShape, observedAt: new Date(now + 1_000).toISOString() }),
      JSON.stringify({ ...goodShape, allowanceKey: 'another-allowance' }),
    ]) {
      writeFileSync(cache, data);
      expect(readClaudeUsage(pool, now)).toMatchObject({ observedAt: null, windows: [], error: expect.any(String) });
    }
  } finally {
    rmSync(cache, { force: true });
  }
});

test('afterExit keeps a usable in-memory reading when reset data and cache persistence fail', () => {
  const pool = makePool();
  const cache = cachePath(pool);
  const now = Date.parse('2026-11-03T00:00:00Z');
  const log = JSON.stringify({
    type: 'rate_limit_event',
    rate_limit_info: { unifiedWindows: { five_hour: { utilization: 0.25, resetsAt: 1e100 } } },
  });
  mkdirSync(cache);
  try {
    expect(() => claudeAdapter.afterExit(pool, log)).not.toThrow();
    expect(readClaudeUsage(pool, now + 180_000)).toMatchObject({
      pool: pool.name,
      allowanceKey: pool.allowanceKey,
      observedAt: new Date(now).toISOString(),
      windows: [{ usedPercent: 25, resetsAt: null, minutes: 300 }],
      error: null,
    });
  } finally {
    rmSync(cache, { recursive: true, force: true });
    rmSync(`${cache}.${process.pid}`, { force: true });
  }
});

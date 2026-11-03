import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import defaults from '../defaults.json';
import { checkSettings, readControlPolicy } from './config.ts';
import { capacityAvailable } from './launch.ts';
import { harness } from './test-support.ts';

test('local policy overrides individual leaves and validates configurable notifier bounds', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.policy = { backlog: { lowWater: 3 }, validation: { hourlyReportMaxTimeoutMs: 200001 } };
    local.integration = { hourlyReportTimeoutMs: 200001 };
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const settings = checkSettings({ cwd: h.root, env: {} });
    expect(settings.policy).toEqual({
      ...defaults.policy,
      backlog: { ...defaults.policy.backlog, lowWater: 3 },
      validation: { ...defaults.policy.validation, hourlyReportMaxTimeoutMs: 200001 },
    });
    local.integration.hourlyReportTimeoutMs++;
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    expect(() => checkSettings({ cwd: h.root, env: {} })).toThrow('at most 200001');
    for (const invalid of [{ capacity: { maxWorkers: 0 } }, { backlog: { lowWater: 1.5 } }, { typo: 1 }])
      expect(() => readControlPolicy(invalid)).toThrow('policy.');
  } finally {
    h.dispose();
  }
});

test('host admission uses configured defaults and retains the capacity file override and opt-in', () => {
  const h = harness();
  try {
    const policy = readControlPolicy({ capacity: { maxWorkers: 1, minAvailableMiB: 0 } }).capacity;
    const store = { runningAttemptsCount: () => 1 } as typeof h.store;
    expect(capacityAvailable(store, h.settings.stateDirectory, policy)).toBe(true);
    const file = join(h.settings.stateDirectory, 'capacity.json');
    writeFileSync(file, '{}');
    expect(capacityAvailable(store, h.settings.stateDirectory, policy)).toBe(false);
    writeFileSync(file, JSON.stringify({ maxWorkers: 2 }));
    expect(capacityAvailable(store, h.settings.stateDirectory, policy)).toBe(true);
  } finally {
    h.dispose();
  }
});

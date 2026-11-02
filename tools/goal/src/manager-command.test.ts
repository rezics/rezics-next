import { expect, test } from 'bun:test';
import { readFileSync, writeFileSync } from 'node:fs';
import { createRuntime, loadSettings } from './config.ts';
import { harness } from './test-support.ts';

test('manager command names the main checkout and local config only, leaving roots to local config', () => {
  const h = harness();
  try {
    const local = JSON.parse(readFileSync(h.settings.localFile, 'utf8'));
    local.stateDirectory = '.temp/custom-state';
    local.worktreeRoot = '.temp/custom-worktrees';
    writeFileSync(h.settings.localFile, JSON.stringify(local));
    const settings = loadSettings({ cwd: h.root, env: {} });
    const runtime = createRuntime({ settings });
    try {
      const command = runtime.managerServices.command;
      const goalVariables = command.slice(1).filter((part) => part.startsWith('GOAL_'));
      expect(goalVariables).toEqual([`GOAL_MAIN_CHECKOUT=${h.root}`, `GOAL_LOCAL_CONFIG=${h.settings.localFile}`]);
    } finally {
      runtime.close();
    }
  } finally {
    h.dispose();
  }
});

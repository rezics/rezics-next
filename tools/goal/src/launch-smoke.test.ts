import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { expect, test } from 'bun:test';
import { runLaunchSmoke } from '../scripts/launch-smoke.ts';

test('smoke drives start, waiting, wake result and success with a fake agent', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-smoke-agent-'));
  const agent = join(dir, 'agent');
  writeFileSync(agent, '#!/bin/sh\ncase "$1" in\nstart) echo "waiting worker-check-abc123";;\nwake) test "$REZICS_SMOKE_CHECK_ID" = worker-check-abc123 && echo "result passed";;\nsuccess) echo success;;\nesac\n');
  chmodSync(agent, 0o755);
  try {
    await expect(runLaunchSmoke(agent)).resolves.toBeUndefined();
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test('smoke names the failed step', async () => {
  const dir = mkdtempSync(join(tmpdir(), 'goal-smoke-agent-'));
  const agent = join(dir, 'agent');
  writeFileSync(agent, '#!/bin/sh\nif [ "$1" = start ]; then exit 5; fi\n');
  chmodSync(agent, 0o755);
  try {
    await expect(runLaunchSmoke(agent)).rejects.toThrow('start:');
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

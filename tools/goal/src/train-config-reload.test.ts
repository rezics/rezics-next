import { expect, test } from 'bun:test';
import { readdirSync, readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { createRuntime } from './config.ts';
import { runIntegration } from './integration-cli.ts';
import { integrationHarness } from './test-support.ts';

const setPrelandingTypecheck = (file: string, enabled: boolean) => {
  const settings = JSON.parse(readFileSync(file, 'utf8'));
  settings.integration = { ...settings.integration, batchSize: 1, devPrelandingTypecheck: enabled };
  writeFileSync(file, JSON.stringify(settings));
};

test('a running train reloads local settings between landings and logs each revision', async () => {
  const h = integrationHarness();
  let runtime: ReturnType<typeof createRuntime> | undefined;
  let changed = false;
  try {
    h.ensureDev();
    setPrelandingTypecheck(h.settings.localFile, true);
    h.settings.integration.devPrelandingTypecheck = true;
    const first = h.dispatch('docs/first.md');
    const second = h.dispatch('docs/second.md');
    await h.start(first);
    await h.start(second);
    runtime = createRuntime({
      settings: h.settings,
      runGate: async () => {
        if (!changed) {
          setPrelandingTypecheck(h.settings.localFile, false);
          changed = true;
        }
        return { passed: true, output: '', timedOut: false };
      },
    });

    await expect(runIntegration(['train'], runtime)).resolves.toBe(0);

    const logs = readdirSync(h.settings.stateDirectory)
      .filter((name) => /^landing-\d+\.log$/.test(name))
      .sort((a, b) => Number(a.match(/\d+/)?.[0]) - Number(b.match(/\d+/)?.[0]))
      .map((name) => readFileSync(join(h.settings.stateDirectory, name), 'utf8'));
    expect(logs).toHaveLength(2);
    expect(logs[0]).toContain('(required root typecheck');
    expect(logs[0]).not.toContain('Prelanding typecheck skipped');
    expect(logs[1]).toContain('Prelanding typecheck skipped');
    const revisions = logs.map((log) => /Configuration revision: (sha256:[a-f\d]{64})/.exec(log)?.[1]);
    expect(revisions.every(Boolean)).toBe(true);
    expect(revisions[0]).not.toBe(revisions[1]);
  } finally {
    runtime?.close();
    h.dispose();
  }
}, 60_000);

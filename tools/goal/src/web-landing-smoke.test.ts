import { expect, test } from 'bun:test';
import defaults from '../defaults.json';
import { readIntegrationChecks } from './config.ts';
import { integrationChecksForFiles } from './merge-train.ts';

const checks = readIntegrationChecks(defaults.integrationChecks);
const smokeCommand = ['bun', 'test', 'apps/web/tests/library-page-smoke.test.ts'];
const existingCommands = [
  ['bun', 'install'],
  ['bun', 'scripts/typecheck.ts'],
  ['bun', 'scripts/workspace-imports.ts'],
  [
    'sh',
    '-c',
    "bun run --cwd apps/web generate && bun apps/web/scripts/isolated.ts bun test apps/web/tests/page-stories.test.ts -t 'each recorded response type-checks'",
  ],
];

test('the Personal Library rendered smoke is selected for each Web workspace and no non-Web workspace', () => {
  const smoke = checks.find((check) => JSON.stringify(check.command) === JSON.stringify(smokeCommand));
  expect(smoke?.paths).toEqual(['apps/web/**', 'packages/ui/**', 'packages/document/**']);
  expect(checks.map((check) => check.command)).toEqual([
    ...existingCommands.slice(0, 3),
    smokeCommand,
    existingCommands[3],
  ]);

  for (const changedPath of [
    'apps/web/src/library/entries-page.tsx',
    'packages/ui/src/button.tsx',
    'packages/document/src/document.ts',
  ]) {
    const selected = integrationChecksForFiles([changedPath], checks);
    expect(selected).toContainEqual(smoke);
    expect(selected.map((check) => check.command)).toContainEqual(['bun', 'install']);
    expect(selected.map((check) => check.command)).toContainEqual(['bun', 'scripts/typecheck.ts']);
    expect(selected.map((check) => check.command)).toContainEqual(['bun', 'scripts/workspace-imports.ts']);
  }

  expect(integrationChecksForFiles(['services/auth/src/session.ts'], checks)).not.toContainEqual(smoke);
  expect(
    integrationChecksForFiles(['packages/client/src/kernel/library.ts'], checks).map((check) => check.command),
  ).toContainEqual(existingCommands[3]);
});

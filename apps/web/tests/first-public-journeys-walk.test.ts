import { expect, test } from 'bun:test';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import { FIRST_PUBLIC_JOURNEY_PATHS } from '../scripts/first-public-journeys-paths.ts';
import { capabilitiesTableMarkdown } from '../scripts/first-public-journeys-table.ts';

test('the first-public journey walk names each of the 17 Goal paths once', () => {
  expect(FIRST_PUBLIC_JOURNEY_PATHS).toHaveLength(17);
  expect(FIRST_PUBLIC_JOURNEY_PATHS.map((path) => path.id)).toEqual(
    Array.from({ length: 17 }, (_, index) => `P${String(index + 1).padStart(2, '0')}`),
  );
  expect(new Set(FIRST_PUBLIC_JOURNEY_PATHS.map((path) => path.job)).size).toBe(17);
});

test('the walk retains Settings, Inbox and Library owners and does not import Auth contract', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/first-public-journeys-walk.ts'), 'utf8');
  expect(source).toContain("from './first-public-journeys-paths.ts'");
  expect(source).toContain("from './first-public-journeys-table.ts'");
  expect(source).not.toMatch(/from ['"]@rezics\/auth-contract['"]/);
  expect(new Set(FIRST_PUBLIC_JOURNEY_PATHS.map((path) => path.owner))).toEqual(
    new Set(['Settings', 'Accounts', 'Inbox', 'Library']),
  );
});

test('the walk table writer names every path once with the observed result', () => {
  const markdown = capabilitiesTableMarkdown('abc123def0', 'fd920c9cdb', [
    {
      id: 'P01',
      status: 'FAIL-unreached',
      persona: 'setup',
      elapsedMs: 530,
      firstWrong: 'WORKFLOW_RETIREMENT_DISPATCH missing',
    },
  ]);
  expect(markdown).toContain('| P01 |');
  expect(markdown).toContain('| FAIL-unreached |');
  expect(markdown).toContain('0/17');
  expect(markdown).toContain('WORKFLOW_RETIREMENT_DISPATCH missing');
  for (const path of FIRST_PUBLIC_JOURNEY_PATHS) expect(markdown).toContain(`| ${path.id} |`);
});

test('candidate source results cannot pass current-dev rows', () => {
  const candidate = capabilitiesTableMarkdown(
    'candidate-commit',
    'integrated-commit',
    [{ id: 'P01', status: 'PASS', persona: 'signed-in', elapsedMs: 400 }],
    { devRevision: 'integrated-commit' },
  );
  expect(candidate).toContain('Hourly: **0/17**');
  expect(candidate).toContain('| FAIL |');
  expect(candidate).toContain('candidate source candidate- cannot pass current-dev rows');

  const integrated = capabilitiesTableMarkdown(
    'integrated-commit',
    'integrated-commit',
    [{ id: 'P01', status: 'PASS', persona: 'signed-in', elapsedMs: 400 }],
    { devRevision: 'integrated-commit' },
  );
  expect(integrated).toContain('Hourly: **1/17**');
  expect(integrated).toContain('| PASS |');
});

test('the walk continues mixed anonymous paths when seed writes no result.json', () => {
  const source = readFileSync(resolve(import.meta.dir, '../scripts/first-public-journeys-walk.ts'), 'utf8');
  const seed = source.indexOf("child(['bun', 'scripts/datasets/cross-media-seed.ts'");
  const frontends = source.indexOf('frontends = await startSeededFrontends()');
  expect(seed).toBeGreaterThan(0);
  expect(frontends).toBeGreaterThan(seed);
  expect(source.slice(seed, frontends)).not.toMatch(/failRest\(/);
  expect(source.slice(seed, frontends)).toContain("handle: 'developer'");
  expect(source).toContain("`${stack.web}/auth/sign-in?return_to=${encodeURIComponent('/en/settings')}`");
  expect(source).not.toContain('/en/auth/sign-in?return_to');
  expect(source).toContain('`${stack.kernel}/v1/definitions/active`');
  expect(source).not.toContain('`${stack.kernel}/v1/definitions`)');
  expect(source).toContain('`${stack.kernel}/health`');
  expect(source).toContain("query: { accountId: ctx.seed.accountId, limit: '5' }");
  const markdown = capabilitiesTableMarkdown(
    'abc123def0',
    'fd920c9cdb',
    [{ id: 'P02', status: 'FAIL-unreached', persona: 'anonymous', elapsedMs: 1200, firstWrong: 'save unreached' }],
    {
      seedCause: 'seed exited 1: Import transport request failed',
      seedElapsedMs: 4_200,
      hydration: { ok: false, detail: 'html[data-hydrated] timeout', elapsedMs: 60_000 },
    },
  );
  expect(markdown).toContain('Import transport request failed');
  expect(markdown).toContain('4.200 s');
  expect(markdown).toContain('Mixed anonymous paths still ran');
  expect(markdown).toContain('Public /en hydration: failed');
});

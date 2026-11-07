import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { affectedTestFilesBySource } from './affected-tests.ts';

const GOAL_TEST = /^tools\/goal\/src\/.*\.(?:test|spec)\.[cm]?[jt]sx?$/i;
const GOAL_CODE = /^tools\/goal\/.*\.(?:[cm]?[jt]sx?|json)$/i;
const DOCUMENTATION = /(?:^|\/)(?:README|CHANGELOG|CONTRIBUTING)(?:\.[^/]*)?$/i;
const GENERATED_INTERFACE = /(?:^|\/)generated(?:[-_.][^/]*)?(?:\/|$)|\.d\.[cm]?ts$/i;
const ROOT_TOOLCHAIN = /^(?:package\.json|bun\.lock(?:b)?|bunfig\.toml|tsconfig(?:\.[^/]*)?\.json)$/i;
const GOAL_TOOLCHAIN = /^tools\/goal\/(?:package\.json|bun\.lock(?:b)?|bunfig\.toml|tsconfig(?:\.[^/]*)?\.json)$/i;
const CONFIGURATION_FILE =
  /^(?:defaults\.json|local\.json|[^/]*(?:config|settings)[^/]*\.(?:[cm]?[jt]sx?|json|toml))$/i;
const SHARED_FIXTURE = /^(?:fixtures?|__fixtures__|test-support|test-environment)(?:[.-]|$)/i;
const LIFECYCLE_WORDS = [
  /(?:^|[-_.])(?:launch-smoke|lifecycle|agent-adapters)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:worker(?:-job)?|manager(?:-session)?|process|dispatch)(?:[-_.]|$)/i,
  /(?:^|[-_.])(?:cli|host|train)(?:[-_.]|$)/i,
];

export type ControlPlaneCheckPlan = {
  base: string;
  candidate: string;
  changedPaths: string[];
  tests: string[];
  scope: 'none' | 'affected' | 'all';
  reasons: string[];
};

export type ControlPlaneCheckPlanInput = {
  base: string;
  candidate: string;
  changedPaths: readonly string[];
  trackedFiles: readonly string[];
  readFile: (path: string) => string | undefined;
};

function broadReason(path: string): string | undefined {
  const segments = path.split('/');
  if (
    ROOT_TOOLCHAIN.test(path) ||
    GOAL_TOOLCHAIN.test(path) ||
    path.startsWith('scripts/') ||
    path.startsWith('tools/goal/scripts/')
  )
    return `shared toolchain change at ${path}`;
  if (segments.some((segment) => SHARED_FIXTURE.test(segment)))
    return `shared fixture or harness change at ${path}`;
  if (segments.some((segment) => segment === 'config' || CONFIGURATION_FILE.test(segment)))
    return `configuration change at ${path}`;
  if (segments.some((segment) => LIFECYCLE_WORDS.some((word) => word.test(segment))))
    return `lifecycle change at ${path}`;
  return undefined;
}

function isDocumentation(path: string): boolean {
  return DOCUMENTATION.test(path) || path.startsWith('docs/') || path.endsWith('.md');
}

function isGeneratedInterface(path: string): boolean {
  return GENERATED_INTERFACE.test(path);
}

/** Select Goal tests from changed candidate owners and their transitive consumers. */
export function selectControlPlaneCheckPlan(input: ControlPlaneCheckPlanInput): ControlPlaneCheckPlan {
  const changedPaths = [...new Set(input.changedPaths)].sort();
  const tracked = new Set(input.trackedFiles);
  const testFiles = [...tracked].filter((path) => GOAL_TEST.test(path)).sort();
  const impact = affectedTestFilesBySource(changedPaths, input.trackedFiles, input.readFile);
  const selected = new Set<string>();
  const broaden = new Set<string>();
  const changedTests = new Set<string>();
  const affectedOwners = new Set<string>();
  const generatedOwners = new Set<string>();

  for (const path of changedPaths) {
    if (GOAL_TEST.test(path)) {
      if (tracked.has(path)) {
        selected.add(path);
        changedTests.add(path);
      } else {
        broaden.add(`removed test cannot be selected at ${path}`);
      }
      continue;
    }

    const sharedReason = broadReason(path);
    if (sharedReason) {
      broaden.add(sharedReason);
      continue;
    }

    if (isDocumentation(path)) continue;

    if (GOAL_CODE.test(path)) {
      const consumers = impact.get(path) ?? [];
      if (consumers.length) {
        consumers.forEach((test) => selected.add(test));
        affectedOwners.add(path);
        if (isGeneratedInterface(path)) generatedOwners.add(path);
      } else {
        broaden.add(`unresolved dependency impact at ${path}`);
      }
      continue;
    }

    // Root tooling and other executable inputs can affect the proof without importing a Goal source module.
    if (/\.(?:[cm]?[jt]sx?|json|toml|ya?ml)$/i.test(path) || path.startsWith('tools/goal/'))
      broaden.add(`unresolved dependency impact at ${path}`);
  }

  let scope: ControlPlaneCheckPlan['scope'];
  let tests: string[];
  const reasons: string[] = [];
  if (broaden.size) {
    scope = 'all';
    tests = testFiles;
    for (const reason of [...broaden].sort()) reasons.push(`All Goal tests required: ${reason}`);
  } else if (selected.size) {
    scope = 'affected';
    tests = [...selected].sort();
    if (changedTests.size)
      reasons.push(`Changed Goal tests retained: ${[...changedTests].sort().join(', ')}`);
    if (affectedOwners.size)
      reasons.push(
        `Changed owners and candidate source impact selected tests for ${[...affectedOwners].sort().join(', ')}: ${
          [...selected].sort().join(', ')
        }`,
      );
    if (generatedOwners.size)
      reasons.push(
        `Generated interface consumers followed from the candidate graph: ${[...generatedOwners].sort().join(', ')}`,
      );
  } else {
    scope = 'none';
    tests = [];
    reasons.push('No Goal test owner changed; typecheck, compatibility and lifecycle proof remain required.');
  }

  return { base: input.base, candidate: input.candidate, changedPaths, tests, scope, reasons };
}

function gitText(cwd: string, args: string[]): string {
  const result = spawnSync('git', args, { cwd, encoding: 'utf8', maxBuffer: 64 * 1024 * 1024 });
  if (result.status !== 0)
    throw new Error(result.stderr?.trim() || result.error?.message || `git ${args[0]} failed`);
  return result.stdout;
}

/** Derive an immutable release plan from the captured base and exact candidate commit. */
export function planControlPlaneChecks(cwd: string, base: string, candidate: string): ControlPlaneCheckPlan {
  const head = gitText(cwd, ['rev-parse', 'HEAD']).trim();
  if (head !== candidate)
    throw new Error(`Control-plane check candidate mismatch: expected ${candidate}, found ${head}`);
  const changedPaths = gitText(cwd, ['diff', '--name-only', '--no-renames', '-z', base, candidate, '--'])
    .split('\0')
    .filter(Boolean);
  const trackedFiles = gitText(cwd, ['ls-tree', '-r', '-z', '--name-only', candidate, '--', 'tools/goal'])
    .split('\0')
    .filter(Boolean);
  return selectControlPlaneCheckPlan({
    base,
    candidate,
    changedPaths,
    trackedFiles,
    readFile(path) {
      const file = join(cwd, path);
      if (!existsSync(file)) throw new Error(`Candidate file is missing while planning control-plane checks: ${path}`);
      return readFileSync(file, 'utf8');
    },
  });
}

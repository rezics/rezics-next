import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tier } from './core.ts';
import { declaredCases } from './cases/index.ts';
import type { Case } from './cases/types.ts';
import { integrationGateFiles } from './integration-gate-files.ts';

export type { Case } from './cases/types.ts';
export interface TestResult {
  name: string;
  file: string;
  tier: Tier;
  failed: boolean;
  skipped: boolean;
  durationMs?: number;
  seed?: number;
}

export const UNEXECUTED_FILE_TEST = 'QA file did not complete';
export const unitHarnessFiles = ['tests/qa/g-955-harness.test.ts'];

export function caseInventory(_root?: string): Case[] {
  const found = new Set<string>();
  for (const item of declaredCases) {
    if (found.has(item.id)) throw new Error(`Duplicate acceptance ID ${item.id}`);
    found.add(item.id);
  }
  if (!found.size) throw new Error('No acceptance cases declared');
  return declaredCases.map(({ id, page }) => ({ id, page }));
}

function decode(value: string): string {
  return value.replace(/&(#x[0-9a-f]+|#\d+|amp|lt|gt|quot|apos);/gi, (_, entity: string) => {
    if (entity.startsWith('#x')) return String.fromCodePoint(parseInt(entity.slice(2), 16));
    if (entity.startsWith('#')) return String.fromCodePoint(parseInt(entity.slice(1), 10));
    return ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" } as Record<string, string>)[entity] ?? `&${entity};`;
  });
}

function attribute(attrs: string, key: string): string | undefined {
  const value = attrs.match(new RegExp(`(?:^|\\s)${key}="([^"]*)"`))?.[1];
  return value === undefined ? undefined : decode(value);
}

export function parseJUnit(xml: string, tier: Tier): TestResult[] {
  const result: TestResult[] = [];
  for (const match of xml.matchAll(/<testcase\b([^>]*?)(?:\s*\/>|>([\s\S]*?)<\/testcase>)/g)) {
    const name = attribute(match[1], 'name');
    const file = attribute(match[1], 'file') ?? (tier === 'e2e'
      ? playwrightFile(attribute(match[1], 'classname')) : undefined);
    if (!name || !file) continue;
    const body = match[2] ?? '';
    const seconds = Number(attribute(match[1], 'time'));
    result.push({ name, file, tier, failed: /<(?:failure|error)\b/.test(body),
      skipped: /<skipped\b/.test(body),
      ...(Number.isFinite(seconds) && seconds >= 0 ? { durationMs: Math.round(seconds * 1000) } : {}) });
  }
  return result;
}

function playwrightFile(classname: string | undefined): string | undefined {
  if (!classname || classname.includes('..') || classname.includes('\\')) return undefined;
  const path = classname.startsWith('apps/web/tests/') ? classname
    : `apps/web/tests/${classname}`;
  return /^apps\/web\/tests\/[a-zA-Z0-9/_-]+\.e2e\.ts$/.test(path) ? path : undefined;
}

export function junitResults(directory: string, tiers: Tier[]): TestResult[] {
  return tiers.flatMap(tier => {
    const file = join(directory, `${tier.replaceAll('/', '-')}.xml`);
    return existsSync(file) ? parseJUnit(readFileSync(file, 'utf8'), tier) : [];
  });
}

export function titleIds(name: string): string[] {
  const prefix = name.match(/^([A-Z][A-Z0-9]*\d{2,}(?:\/[A-Z][A-Z0-9]*\d{2,})*):/);
  return prefix ? prefix[1].split('/') : [];
}

export function acceptanceStatuses(cases: Case[], tests: TestResult[], completeRun = false,
  caseCoverage: ReadonlyMap<string, readonly string[]> = new Map()): Record<string, {
  status: 'uncovered' | 'partial-pass' | 'passed' | 'failed'; page: string; tests: string[];
}> {
  const map: ReturnType<typeof acceptanceStatuses> = Object.fromEntries(cases.map(item => [item.id, { status: 'uncovered' as const,
    page: item.page, tests: [] as string[] }]));
  for (const test of tests) {
    for (const id of titleIds(test.name)) {
      const entry = map[id];
      if (!entry) continue;
      entry.tests.push(`${test.tier}:${test.file}:${test.name}`);
      if (test.failed) entry.status = 'failed';
      else if (!test.skipped && entry.status !== 'failed') entry.status = 'partial-pass';
    }
  }
  if (completeRun) {
    for (const [id, entry] of Object.entries(map)) {
      const required = caseCoverage.get(id);
      if (!required?.length) continue;
      if (entry.status === 'partial-pass') {
        const mapped = tests.filter(test => titleIds(test.name).some(id => map[id] === entry));
        const observed = new Set(mapped.filter(test => !test.skipped && !test.failed)
          .map(test => `${test.tier}:${test.file}:${test.name}`));
        if (mapped.every(test => !test.skipped && !test.failed)
          && required.every(identity => observed.has(identity))) entry.status = 'passed';
      }
    }
  }
  return map;
}

export interface FailedSelection { sourceRunId: string; tiers: Tier[]; tests: TestResult[];
  retiredTests?: TestResult[] }

// These owner tests do not run in any tier. full-work still requires a separately
// installed host JVM/Jena runtime and awaits migration to QA. activate and
// recovery are already migrated to QA stacks but assert legacy contracts the
// current product contradicts, so they stay unregistered until their owners decide:
// activate expects Work JSON without `admissionId` (routes/works.ts returns it and
// g-523-agent-control requires it); recovery expects a graph hold release to leave
// Access held (releaseRestoredGraphHold releases both atomically, as
// slim-metadata-restore requires). Preserve prior failures in diagnostics meanwhile.
export const legacyHostJenaGateFiles = [
  'services/main/tests/activate.integration.test.ts',
  'services/main/tests/full-work.integration.test.ts',
  'services/main/tests/recovery.integration.test.ts',
] as const;

function isRetiredQaTest(test: TestResult): boolean {
  return (test.tier === 'integration' || test.tier === 'fault/recovery')
    && legacyHostJenaGateFiles.some(file => file === test.file);
}

export { integrationGateFiles };

// Exclusions are file-specific so a new test cannot silently inherit an opt-out.
export const testExclusions: readonly { file: string; reason: string; category?: 'live' | 'load' | 'external' }[] = [
  ...legacyHostJenaGateFiles.map(file => ({ file,
    reason: file.endsWith('/full-work.integration.test.ts')
      ? 'Legacy host Jena harness needs separately installed REZICS_JAVA_HOME, REZICS_JENA_HOME and REZICS_FUSEKI_HOME.'
      : 'Migrated to QA stacks, but asserts a legacy contract the current product contradicts; unregistered until its owners decide.' })),
  { file: 'scripts/research/storage_architecture/dgraph.test.ts', category: 'load',
    reason: 'Opt-in 10k Dgraph load evidence requires a completed research:architecture Dgraph probe and its retained results; ordinary Bun tiers do not prepare that workload.' },
  { file: 'apps/web/tests/g-944-shared-browser.test.ts',
    reason: 'Live shared-stack Playwright fixture requires running web, Accounts and Main services; run it explicitly through goalctl rather than the isolated Bun unit tier.' },
  { file: 'apps/about/tests/build.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'apps/about/tests/catalogs.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'apps/about/tests/g-736-legal.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'apps/about/tests/image-safety-copy.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'apps/about/tests/status-badge.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'apps/about/tests/ui-sources.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'apps/about/tests/worker.test.ts', reason: 'The about site runs its tests through task about:check.' },
  { file: 'tests/live/cargo-crates-io.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/g-722-images.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/go-proxy-live.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/go-refresh-live.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/mod-public-provider.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/npm-registry-oracle.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/open-library-work.test.ts', reason: 'Live network fixtures run only on explicit request.' },
  { file: 'tests/live/source-run-open-library.test.ts', reason: 'Live network fixtures run only on explicit request.' },
];

const unitOwnerDirectories = [
  'services', 'model', 'scripts', 'packages', 'apps/web', 'apps/accounts', 'infra/dev/tests', 'infra/jena/tests',
] as const;

// Discover Bun owner tests by capability location. Stack gates retain their
// explicit registrations, and the registry test catches every other location.
function bunOwnerFiles(root = join(import.meta.dir, '../..')): string[] {
  const reserved = new Set<string>([...integrationGateFiles, ...modelGateFiles, ...faultGateFiles,
    ...testExclusions.map(item => item.file)]);
  const found: string[] = [];
  const walk = (directory: string) => {
    for (const entry of readdirSync(join(root, directory), { withFileTypes: true })) {
      const path = `${directory}/${entry.name}`;
      if (entry.isDirectory() && !['node_modules', '.temp', '.artifacts', 'dist', '.git'].includes(entry.name)) walk(path);
      else if (entry.isFile() && /\.test\.tsx?$/.test(entry.name)
        && !/\.integration\.test\.tsx?$/.test(entry.name) && !reserved.has(path)) found.push(path);
    }
  };
  for (const directory of unitOwnerDirectories) walk(directory);
  return found.sort();
}

// Keep declared acceptance evidence in its reviewed unit tier. The coverage
// gate rejects a future declaration whose owner file has not been retained.
const retainedUnitOwners = new Set([
  'model/tests/claim-analysis.test.ts',
  'model/tests/release-rating.test.ts',
  'scripts/dev/config.test.ts',
  'scripts/operations/search-state.test.ts',
  'services/main/tests/api-contract.test.ts',
  'services/main/tests/command.test.ts',
  'services/main/tests/content-eligibility.test.ts',
  'services/main/tests/content-projection-runtime.test.ts',
  'services/main/tests/context-schema.test.ts',
  'services/main/tests/event-time.test.ts',
  'services/main/tests/immutable-objects.test.ts',
  'services/main/tests/rating-aggregate.test.ts',
  'services/main/tests/rating-calendar.test.ts',
  'services/main/tests/rating-experience.test.ts',
  'services/main/tests/rating-global.test.ts',
  'services/main/tests/structure-listitem.test.ts',
  'services/main/tests/vote-schema-commands.test.ts',
  'services/main/tests/work-command.test.ts',
]);
export function isQaOwnerPath(path: string): boolean {
  return /\.test\.tsx?$/.test(path) && !retainedUnitOwners.has(path) && !modelGateFiles.some(file => file === path)
    && (path.startsWith('scripts/') || path.startsWith('packages/') || path.startsWith('services/'));
}
export function unitOwnerFiles(root = join(import.meta.dir, '../..')): string[] {
  return bunOwnerFiles(root).filter(file => !isQaOwnerPath(file));
}
export function ownerGateFiles(root = join(import.meta.dir, '../..')): string[] {
  return bunOwnerFiles(root).filter(isQaOwnerPath);
}

export function isQaIntegrationPath(path: string): boolean {
  return path.startsWith('tests/qa/integration/') || integrationGateFiles.some(file => file === path);
}
export const modelGateFiles = [
  'infra/jena/tests/command.integration.test.ts',
  'services/main/tests/read-snapshot-native.test.ts',
  'model/compiler/generate.test.ts',
  'model/tests/native-equivalence.test.ts',
  'model/tests/daily-rating.test.ts',
  'model/tests/experience-rating.test.ts',
  'model/tests/source-reification.test.ts',
  'model/tests/validation-shape-terms.test.ts',
  'model/tests/reasoning-profile.test.ts',
  'model/tests/event-time.test.ts',
  'packages/model/tests/generated.test.ts',
] as const;
export function isQaModelPath(path: string): boolean {
  return modelGateFiles.some(file => file === path);
}
export const faultGateFiles = [
  'services/account/tests/account-pitr.integration.test.ts',
  'services/account/tests/account-access-recovery.integration.test.ts',
  'services/main/tests/access-pitr.integration.test.ts',
  'services/main/tests/content-recovery.integration.test.ts',
] as const;
export function isQaFaultPath(path: string): boolean {
  return path.startsWith('tests/qa/fault-recovery/') || faultGateFiles.some(file => file === path);
}
export function isQaLoadPath(path: string): boolean {
  return path.startsWith('tests/qa/load/') && path.endsWith('.test.ts');
}
export function isQaE2ePath(path: string): boolean {
  return /^apps\/web\/tests\/[a-zA-Z0-9/_-]+\.e2e\.ts$/.test(path) && !path.includes('..');
}

export function failedSelection(artifactRoot: string, runId: string): FailedSelection {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) throw new Error('Invalid prior run ID');
  const directory = join(artifactRoot, runId);
  const path = join(directory, 'acceptance.json');
  if (!existsSync(path)) throw new Error(`Prior QA run not found: ${runId}`);
  const prior = JSON.parse(readFileSync(path, 'utf8')) as { tiers?: { name: Tier; status: string }[] };
  const tiers = (prior.tiers ?? []).filter(t => t.status === 'failed').map(t => t.name);
  if (!tiers.length) throw new Error(`Prior QA run ${runId} has no failed tier to diagnose`);
  if (tiers.some(tier => !(['static', 'unit', 'owner', 'integration', 'model', 'fault/recovery', 'e2e', 'load'] as Tier[]).includes(tier))) {
    throw new Error(`Prior QA run ${runId} names an unsupported failed tier`);
  }
  const failed = junitResults(directory, tiers).filter(test => test.failed);
  // Diagnostics follow current registrations when an owner file moves tiers.
  // Keep prior failed tiers too: a missing JUnit file still needs a full rerun.
  const tests = failed.filter(test => !isRetiredQaTest(test)).map(test => {
    if (isQaFaultPath(test.file)) return { ...test, tier: 'fault/recovery' as const };
    if (isQaIntegrationPath(test.file)) return { ...test, tier: 'integration' as const };
    return test;
  });
  return { sourceRunId: runId, tiers: [...new Set([...tiers, ...tests.map(test => test.tier)])], tests,
    retiredTests: failed.filter(isRetiredQaTest) };
}

export function e2eArgs(selection?: FailedSelection,
  chosen?: { files?: string[]; id?: string }): string[] {
  const selected = selection?.tests.filter(test => test.tier === 'e2e') ?? [];
  const files = chosen?.files?.length ? chosen.files
    : selected.length ? [...new Set(selected.map(test => test.file))].sort() : [];
  if (files.some(file => !isQaE2ePath(file))) throw new Error('Selected e2e path is not registered');
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Playwright matches against the full title path, including the file name.
  const grep = chosen?.id ? `(?:^|\\s)(?:[A-Z][A-Z0-9]*\\d{2,}/)*${chosen.id}(?:/|:)`
    : selected.length ? `(?:^|\\s)(?:${selected.map(test => escape(test.name)).join('|')})$` : undefined;
  return [...files, ...(grep ? ['--grep', grep] : [])];
}

export function testArgs(
  tier: 'unit' | 'owner' | 'integration' | 'model' | 'fault/recovery' | 'load',
  selection?: FailedSelection,
  chosen?: { files?: string[]; id?: string },
): string[] {
  const base = tier === 'model' || tier === 'owner' ? '' : tier === 'fault/recovery' ? 'tests/qa/fault-recovery' : `tests/qa/${tier}`;
  const extraGates = tier === 'integration'
    ? [...integrationGateFiles]
    : tier === 'model' ? [...modelGateFiles]
    : tier === 'fault/recovery' ? [...faultGateFiles]
    : tier === 'load' ? [] : tier === 'owner' ? ownerGateFiles() : unitOwnerFiles();
  const defaults = [...(base ? [base] : []), ...extraGates];
  const supportedGates = tier === 'unit' ? [...extraGates, ...unitHarnessFiles] : extraGates;
  if (chosen) {
    const files = chosen.files?.length ? chosen.files : defaults;
    if (
      files.some(
        (file) =>
          !(file === base || file.startsWith(`${base}/`) || supportedGates.includes(file)) ||
          file.includes('..'),
      )
    )
      throw new Error(`Selected ${tier} path is not registered`);
    const pattern = chosen.id ? ['-t', `^(?:[A-Z][A-Z0-9]*\\d{2,}/)*${chosen.id}(?:/|:)`] : [];
    return [...new Set(files), ...pattern];
  }
  if (!selection) return defaults;
  const tests = selection.tests.filter(test => test.tier === tier);
  if (!tests.length) return defaults;
  const files = [...new Set(tests.map(test => test.file))].sort();
  if (
    files.some(
      (file) =>
        !(file.startsWith(`${base}/`) || supportedGates.includes(file)) || file.includes('..'),
    )
  ) {
    throw new Error(`Prior ${tier} result contains an unsupported test path`);
  }
  // A synthetic missing-file result has no real test title to grep. Rerun the
  // selected files completely so interrupted files can recover on the next run.
  if (tests.some((test) => test.name === UNEXECUTED_FILE_TEST)) return files;
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Bun matches describe ancestry as part of the full test title, while JUnit
  // stores the leaf name separately in each testcase.
  return [...files, '-t', `^.*(?:${tests.map(test => escape(test.name)).join('|')})$`];
}

const tierLogHeader = /^(\S+\.(?:test|spec)\.[cm]?[jt]sx?):$/;
const tierLogResult = /^\((pass|fail|skip|todo)\) /;
const tierLogTimeout = /^(?:bun timed out\b|QA tier budget exceeded\b|Command deadline exceeded\b)/;

export interface HungBatch {
  /** Last file header with no result after it. Absent when the log never started a file. */
  file?: string;
  completed: Record<string, 'passed' | 'failed'>;
  /** Batch files the timeout did not finish, excluding the hanging file. */
  after: string[];
}

/** The file still running when a tier log ends on a timeout: the last file
 * header with no result after it. Files that already printed a result keep it.
 * A log that stops before any file header names no file. */
export function hungTestFile(log: string, files: readonly string[]): HungBatch {
  const known = new Set(files);
  const completed = new Map<string, 'passed' | 'failed'>();
  let current: string | undefined;
  let hasResult = false;
  let last: { file: string; open: boolean } | undefined;
  const close = () => {
    if (!current) return;
    last = { file: current, open: !hasResult };
    current = undefined;
    hasResult = false;
  };
  for (const raw of log.split('\n')) {
    const line = raw.replace(/\u001b\[[0-9;]*m/g, '');
    if (tierLogTimeout.test(line)) break;
    const header = tierLogHeader.exec(line);
    if (header) {
      close();
      const file = header[1]!.replace(/^\.\//, '');
      if (known.has(file)) {
        current = file;
        hasResult = false;
      }
      continue;
    }
    const file = current;
    if (!file) continue;
    const result = tierLogResult.exec(line);
    if (!result) continue;
    hasResult = true;
    if (result[1] === 'fail') completed.set(file, 'failed');
    else if (completed.get(file) !== 'failed') completed.set(file, 'passed');
  }
  close();
  const file = last?.open ? last.file : undefined;
  if (file) completed.delete(file);
  const finished = new Set(completed.keys());
  return {
    ...(file ? { file } : {}),
    completed: Object.fromEntries(completed),
    after: file ? files.filter(item => item !== file && !finished.has(item)) : [],
  };
}

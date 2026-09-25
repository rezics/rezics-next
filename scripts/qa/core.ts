import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import { hostname } from 'node:os';
import { acceptanceStatuses, titleIds, type Case, type TestResult } from './acceptance.ts';

export type Tier = 'static' | 'unit' | 'integration' | 'model' | 'fault/recovery' | 'e2e' | 'load';
export const implementedTiers: Tier[] = ['static', 'unit', 'integration', 'model', 'fault/recovery', 'e2e', 'load'];
export const backendTiers: Tier[] = implementedTiers.filter(tier => tier !== 'e2e');
export const uncoveredTiers: Tier[] = [];
export function tierArtifactName(tier: Tier): string { return tier.replaceAll('/', '-'); }

export function parseArgs(args: string[]): { tier?: Tier; onlyFailed?: string; keep: boolean; record: boolean;
  files?: string[]; id?: string; backend?: boolean } {
  let tier: Tier | undefined;
  let onlyFailed: string | undefined;
  let keep = false;
  let record = false;
  let backend = false;
  const files: string[] = [];
  let id: string | undefined;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && implementedTiers.includes(args[i + 1] as Tier)) tier = args[++i] as Tier;
    else if (args[i] === '--only-failed' && /^[a-z0-9][a-z0-9-]{0,30}$/.test(args[i + 1] ?? '')) onlyFailed = args[++i];
    else if (args[i] === '--file' && /\.(?:test|e2e)\.ts$/.test(args[i + 1] ?? '')) files.push(args[++i]!);
    else if (args[i] === '--id' && /^[A-Z][A-Z0-9]*\d{2,}$/.test(args[i + 1] ?? '')) id = args[++i];
    else if (args[i] === '--keep') keep = true;
    else if (args[i] === '--record') record = true;
    else if (args[i] === '--backend') backend = true;
    else throw new Error(`Unsupported QA option: ${args[i]}`);
  }
  if (record && (tier || onlyFailed || files.length || id)) throw new Error('--record requires a full run');
  if (backend && tier === 'e2e') throw new Error('The backend scope has no e2e tier');
  if (backend && onlyFailed) throw new Error('--backend --only-failed is unsupported');
  if (tier && onlyFailed) throw new Error('--tier and --only-failed cannot be combined');
  if ((files.length || id) && (!tier || onlyFailed || !['unit', 'integration', 'model', 'fault/recovery', 'e2e', 'load'].includes(tier))) {
    throw new Error('--file and --id require a unit, integration, model, fault/recovery, e2e or load tier');
  }
  return { tier, onlyFailed, keep, record,
    ...(backend ? { backend } : {}),
    ...(files.length ? { files } : {}), ...(id ? { id } : {}) };
}

export function command(root: string, name: string, args: string[], timeoutMs: number,
  env: NodeJS.ProcessEnv = process.env): { ok: boolean; output: string; elapsedMs: number } {
  const start = Date.now();
  const result = spawnSync(name, args, { cwd: root, env, encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'], timeout: timeoutMs });
  return { ok: result.status === 0 && !result.error,
    output: [result.stdout, result.stderr, result.error?.message].filter(Boolean).join('\n'),
    elapsedMs: Date.now() - start };
}

export function sourceIdentity(root: string): { head: string; fingerprint: string; clean: boolean } {
  const head = command(root, 'git', ['rev-parse', 'HEAD'], 5_000);
  const status = command(root, 'git', ['status', '--porcelain=v1', '--untracked-files=all'], 5_000);
  const diff = command(root, 'git', ['diff', '--binary', 'HEAD'], 10_000);
  if (!head.ok || !status.ok || !diff.ok) throw new Error('Cannot identify source tree');
  const hash = createHash('sha256').update(head.output).update(diff.output);
  for (const line of status.output.split('\n').filter(Boolean)) {
    const path = line.slice(3);
    if (line.startsWith('??') && existsSync(join(root, path))) {
      hash.update(path).update(readFileSync(join(root, path)));
    }
  }
  return { head: head.output.trim(), fingerprint: hash.digest('hex'), clean: !status.output.trim() };
}

export function newRunId(): string {
  return `${new Date().toISOString().replace(/[-:]/g, '').slice(0, 15).toLowerCase()}-${randomBytes(3).toString('hex')}`;
}

export function expectedFusekiModuleVersion(compose: string): string {
  const versions = [...compose.matchAll(/^\s*image:\s*rezics\/fuseki:6\.2\.0-cmd(\d+\.\d+\.\d+)\s*$/gm)]
    .map(match => match[1]!);
  if (versions.length !== 1) throw new Error('Compose must pin one command-module Fuseki image');
  return versions[0]!;
}

export function acquireFullLock(root: string, runId: string): () => void {
  const path = join(root, '.temp', 'qa-full.lock');
  mkdirSync(join(root, '.temp'), { recursive: true });
  try { mkdirSync(path); } catch { throw new Error(`Another full QA run holds ${path}`); }
  writeFileSync(join(path, 'owner.json'), JSON.stringify({ pid: process.pid, runId }));
  return () => rmSync(path, { recursive: true, force: true });
}

export function xmlForCommand(tier: Tier, ok: boolean, elapsedMs: number, output: string): string {
  const escape = (value: string) => value.replaceAll('&', '&amp;').replaceAll('"', '&quot;')
    .replaceAll('<', '&lt;').replaceAll('>', '&gt;');
  return `<?xml version="1.0" encoding="UTF-8"?>\n<testsuite name="${escape(tier)}" tests="1" failures="${ok ? 0 : 1}" time="${elapsedMs / 1000}"><testcase name="${escape(tier)}" time="${elapsedMs / 1000}">${ok ? '' : `<failure message="command failed">${escape(output.slice(-4000))}</failure>`}</testcase></testsuite>\n`;
}

export function writeSummary(directory: string, report: {
  runId: string; sourceBefore: ReturnType<typeof sourceIdentity>; sourceAfter: ReturnType<typeof sourceIdentity>;
  tiers: { name: Tier; status: 'passed' | 'failed' | 'uncovered'; elapsedMs?: number }[];
  partial: boolean; errors: string[]; cases: Case[]; tests: TestResult[]; diagnosticOf?: string;
  retiredTests?: TestResult[];
  caseCoverage?: ReadonlyMap<string, readonly string[]>;
  scope?: 'all' | 'backend';
  excludedCases?: { id: string; page: string; reason: string }[];
  inventoryFingerprint?: string;
}): void {
  mkdirSync(directory, { recursive: true });
  const sourceStable = report.sourceBefore.fingerprint === report.sourceAfter.fingerprint;
  const passed = report.errors.length === 0 && sourceStable && report.tiers.every(t => t.status !== 'failed');
  const scope = report.scope ?? 'all';
  const requiredTiers = [...(scope === 'backend' ? backendTiers : implementedTiers), ...uncoveredTiers];
  const allTiersPassed = !report.partial && report.tiers.length === requiredTiers.length
    && requiredTiers.every(name => report.tiers.filter(tier => tier.name === name && tier.status === 'passed').length === 1);
  const ids = acceptanceStatuses(report.cases, report.tests, passed && allTiersPassed,
    report.caseCoverage);
  const counts = { uncovered: 0, 'partial-pass': 0, passed: 0, failed: 0 };
  for (const item of Object.values(ids)) counts[item.status]++;
  const certifiesFull = report.sourceBefore.clean && passed && allTiersPassed
    && counts.passed === report.cases.length;
  writeFileSync(join(directory, 'acceptance.json'), JSON.stringify({
    runId: report.runId, host: hostname(), source: report.sourceBefore, sourceStable,
    runKind: report.diagnosticOf ? 'failed-diagnostic' : report.partial ? 'selected-tier' : 'full',
    scope, inventoryFingerprint: report.inventoryFingerprint,
    excludedCases: report.excludedCases ?? [],
    partial: report.partial,
    diagnosticOf: report.diagnosticOf, certifiesFull, counts, ids,
    retiredPriorFailures: report.retiredTests?.map(test => `${test.tier}:${test.file}:${test.name}`) ?? [],
    declaredCaseCoverage: Object.fromEntries(report.caseCoverage ?? []),
    tests: report.tests.map(test => ({ ...test, ids: titleIds(test.name),
      status: test.failed ? 'failed' : test.skipped ? 'skipped' : 'passed' })),
    unmappedTests: report.tests.filter(test => titleIds(test.name).some(id => !ids[id]))
      .map(test => `${test.tier}:${test.file}:${test.name}`),
    tiers: report.tiers,
  }, null, 2) + '\n');
  writeFileSync(join(directory, 'summary.md'), [
    `# QA ${report.runId}`, '',
    `- Source: ${report.sourceBefore.head} (${report.sourceBefore.fingerprint.slice(0, 12)})`,
    `- Source stable: ${sourceStable ? 'yes' : 'no'}`,
    `- Result: ${passed ? 'pass' : 'fail'}; full qualification: ${certifiesFull ? 'yes' : 'no'}`,
    `- Scope: ${scope}${report.diagnosticOf ? `; failed tests from ${report.diagnosticOf}` : report.partial ? '; selected tier' : '; full command; acceptance coverage is reported by ID'}`,
    `- Excluded frontend-only IDs: ${(report.excludedCases ?? []).map(item => item.id).join(', ') || 'none'}`,
    `- Acceptance IDs: ${counts.passed} passed, ${counts['partial-pass']} partial pass, ${counts.failed} failed, ${counts.uncovered} uncovered`, '',
    '| Tier | Status | Time |', '| --- | --- | ---: |',
    ...report.tiers.map(t => `| ${t.name} | ${t.status} | ${t.elapsedMs === undefined ? '—' : `${(t.elapsedMs / 1000).toFixed(1)} s`} |`),
    '', 'Partial passes indicate only the named cases exercised in this run; they do not certify an entire acceptance ID.',
    ...(report.retiredTests?.length ? ['Prior failures for host-Jena tests retired from QA are not rerun:',
      ...report.retiredTests.map(test => `- ${test.tier}:${test.file}:${test.name}`)] : []),
    ...report.errors.map(error => `- Error: ${error}`), '',
  ].join('\n'));
}

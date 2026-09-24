import { createHash, randomBytes } from 'node:crypto';
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';

export type Tier = 'static' | 'unit' | 'integration' | 'model' | 'fault/recovery' | 'e2e' | 'load';
export const implementedTiers: Tier[] = ['static', 'unit', 'integration'];
export const uncoveredTiers: Tier[] = ['model', 'fault/recovery', 'e2e', 'load'];
export const coveredIds = ['OPS01', 'IAM01'];

export function parseArgs(args: string[]): { tier?: Tier; keep: boolean; record: boolean } {
  let tier: Tier | undefined;
  let keep = false;
  let record = false;
  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--tier' && implementedTiers.includes(args[i + 1] as Tier)) tier = args[++i] as Tier;
    else if (args[i] === '--keep') keep = true;
    else if (args[i] === '--record') record = true;
    else throw new Error(`Unsupported QA option: ${args[i]}`);
  }
  if (record && tier) throw new Error('--record requires a full run');
  return { tier, keep, record };
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
  partial: boolean; errors: string[];
}): void {
  mkdirSync(directory, { recursive: true });
  const sourceStable = report.sourceBefore.fingerprint === report.sourceAfter.fingerprint;
  const passed = report.errors.length === 0 && sourceStable && report.tiers.every(t => t.status !== 'failed');
  const certifiesFull = passed && !report.partial && report.tiers.every(t => t.status === 'passed');
  writeFileSync(join(directory, 'acceptance.json'), JSON.stringify({
    runId: report.runId, source: report.sourceBefore, sourceStable, partial: report.partial,
    certifiesFull, ids: Object.fromEntries(coveredIds.map(id => [id, {
      status: report.tiers.some(t => t.name === 'integration' && t.status === 'passed') ? 'partial-pass' : 'uncovered',
      detail: 'Shared-stack Main/Account/Fuseki smoke only',
    }])), futureIds: 'uncovered', tiers: report.tiers,
  }, null, 2) + '\n');
  writeFileSync(join(directory, 'summary.md'), [
    `# QA ${report.runId}`, '',
    `- Source: ${report.sourceBefore.head} (${report.sourceBefore.fingerprint.slice(0, 12)})`,
    `- Source stable: ${sourceStable ? 'yes' : 'no'}`,
    `- Result: ${passed ? 'pass' : 'fail'}; full qualification: ${certifiesFull ? 'yes' : 'no'}`,
    `- Scope: ${report.partial ? 'selected tier' : 'full command, incomplete tier coverage'}`, '',
    '| Tier | Status | Time |', '| --- | --- | ---: |',
    ...report.tiers.map(t => `| ${t.name} | ${t.status} | ${t.elapsedMs === undefined ? '—' : `${(t.elapsedMs / 1000).toFixed(1)} s`} |`),
    '', 'OPS01 and IAM01: shared-stack smoke only; all other retained acceptance IDs remain uncovered.',
    ...report.errors.map(error => `- Error: ${error}`), '',
  ].join('\n'));
}

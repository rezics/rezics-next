import { existsSync } from 'node:fs';
import { isAbsolute, relative, resolve } from 'node:path';
import { isQaE2ePath, isQaFaultPath, isQaIntegrationPath, isQaLoadPath, isQaModelPath } from './acceptance.ts';
import { affectedPlan, affectedTiers, formatPlan, type AffectedPlan } from './affected.ts';

const root = resolve(import.meta.dir, '../..');
const testFile = /\.(?:test|spec|e2e)\.[cm]?[jt]sx?$/;

export function selectTestCommand(args: string[]): [string, string[]] {
  const paths = args.filter(arg => testFile.test(arg));
  if (!paths.length) throw new Error('Provide explicit test file paths or --affected; full-suite execution belongs to yarn qa.');
  const files = paths.map(path => {
    const absolute = resolve(root, path);
    const local = relative(root, absolute).replaceAll('\\', '/');
    if (local.startsWith('..') || isAbsolute(local) || !existsSync(absolute)) {
      throw new Error(`Test file is outside this checkout or missing: ${path}`);
    }
    return local;
  });
  const integration = files.filter(isQaIntegrationPath);
  const model = files.filter(isQaModelPath);
  const fault = files.filter(isQaFaultPath);
  const load = files.filter(isQaLoadPath);
  const e2e = files.filter(isQaE2ePath);
  if (!integration.length && !model.length && !fault.length && !load.length && !e2e.length) return ['bun', ['test', ...args]];
  if (integration.length + model.length + fault.length + load.length + e2e.length !== files.length
    || [integration, model, fault, load, e2e].filter(group => group.length).length !== 1) {
    throw new Error('Run registered QA integration, model, fault/recovery, load, e2e and other test files in separate commands');
  }
  const other = args.filter(arg => !testFile.test(arg));
  let id: string | undefined;
  if (other.length) {
    if (other.length !== 2 || other[0] !== '-t'
      || !/^[A-Z][A-Z0-9]*\d{2,}$/.test(other[1]!)) {
      throw new Error('QA stack selection accepts only -t <acceptance ID>');
    }
    id = other[1];
  }
  return ['corepack', ['yarn', 'qa', '--tier', model.length ? 'model' : fault.length ? 'fault/recovery' : load.length ? 'load' : e2e.length ? 'e2e' : 'integration',
    ...files.flatMap(file => ['--file', file]), ...(id ? ['--id', id] : [])]];
}

export function parseAffectedArgs(args: string[]): { ref?: string; list: boolean } | undefined {
  const flag = args.findIndex(arg => arg === '--affected' || arg.startsWith('--affected='));
  if (flag < 0) {
    if (args.includes('--list')) throw new Error('--list requires --affected');
    return undefined;
  }
  let ref = args[flag]!.startsWith('--affected=') ? args[flag]!.slice('--affected='.length) : undefined;
  const next = args[flag + 1];
  const takesNext = ref === undefined && next !== undefined && !next.startsWith('-') && !testFile.test(next);
  if (takesNext) ref = next;
  const rest = args.filter((_, index) => index !== flag && !(takesNext && index === flag + 1));
  const list = rest.includes('--list');
  const unknown = rest.filter(arg => arg !== '--list');
  if (unknown.length) throw new Error(`--affected cannot be combined with ${unknown.join(' ')}; run explicit paths separately`);
  if (ref !== undefined && !/^[A-Za-z0-9._/@^~-]+$/.test(ref)) throw new Error(`Invalid --affected revision: ${ref}`);
  return { ...(ref ? { ref } : {}), list };
}

export function affectedCommands(plan: AffectedPlan): { label: string; command: [string, string[]] }[] {
  const commands: { label: string; command: [string, string[]] }[] = [];
  for (const tier of affectedTiers) {
    const files = plan.tests[tier];
    const widened = plan.widened.some(item => item.tier === tier);
    if (tier === 'unit') {
      // Widened: the registered tier, plus affected unit tests it does not include.
      if (widened) commands.push({ label: 'unit (whole tier)', command: ['corepack', ['yarn', 'qa', '--tier', 'unit']] });
      if (files.length) commands.push({ label: `unit (${files.length} files)`,
        command: ['bun', ['test', ...files.map(file => `./${file}`)]] });
      continue;
    }
    if (widened) {
      commands.push({ label: `${tier} (whole tier)`, command: ['corepack', ['yarn', 'qa', '--tier', tier]] });
    } else if (files.length) {
      commands.push({ label: `${tier} (${files.length} files)`,
        command: ['corepack', ['yarn', 'qa', '--tier', tier, ...files.flatMap(file => ['--file', file])]] });
    }
  }
  return commands;
}

// Direct Bun runs print only failures and the summary (AGENT=1); JUnit output is
// unchanged and AGENT=0 restores the listing. QA tiers keep full logs, because a
// killed tier otherwise leaves no record of the tests that had finished.
async function run([program, args]: [string, string[]]): Promise<number> {
  const env = program === 'bun' ? { ...process.env, AGENT: process.env.AGENT ?? '1' } : process.env;
  const child = Bun.spawn([program, ...args], { cwd: root, env, stdout: 'inherit', stderr: 'inherit' });
  return child.exited;
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const affected = parseAffectedArgs(args);
  if (!affected) process.exit(await run(selectTestCommand(args)));
  const plan = affectedPlan(root, affected.ref);
  console.log(formatPlan(plan));
  if (affected.list) process.exit(0);
  const results: string[] = [];
  let failed = false;
  // Tiers run in sequence and every tier runs, so one pass yields the whole repair queue.
  for (const { label, command } of affectedCommands(plan)) {
    const code = await run(command);
    failed ||= code !== 0;
    results.push(`  ${label}: ${code === 0 ? 'passed' : `failed (exit ${code})`}`);
  }
  if (results.length) console.log(['Affected run:', ...results].join('\n'));
  process.exit(failed ? 1 : 0);
}

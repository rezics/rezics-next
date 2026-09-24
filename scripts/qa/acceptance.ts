import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
import type { Tier } from './core.ts';

export interface Case { id: string; page: string }
export interface TestResult {
  name: string;
  file: string;
  tier: Tier;
  failed: boolean;
  skipped: boolean;
  durationMs?: number;
  seed?: number;
}

export function caseInventory(root: string): Case[] {
  const directory = join(root, 'docs/testing');
  const found = new Map<string, string>();
  for (const page of readdirSync(directory).filter(name => name.endsWith('.md')).sort()) {
    const text = readFileSync(join(directory, page), 'utf8');
    for (const match of text.matchAll(/^\|\s*([A-Z][A-Z0-9]*\d{2,})\s*\|/gm)) {
      const id = match[1];
      if (found.has(id)) throw new Error(`Duplicate acceptance ID ${id}: ${found.get(id)} and ${page}`);
      found.set(id, `docs/testing/${page}`);
    }
  }
  if (!found.size) throw new Error('No acceptance case rows found in docs/testing');
  return [...found].map(([id, page]) => ({ id, page })).sort((a, b) => a.id.localeCompare(b.id));
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
  const map = Object.fromEntries(cases.map(item => [item.id, { status: 'uncovered' as const,
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

export interface FailedSelection { sourceRunId: string; tiers: Tier[]; tests: TestResult[] }

export const integrationGateFiles = [
  'services/main/tests/immutable-objects.integration.test.ts',
  'services/main/tests/content-publication.integration.test.ts',
  'services/main/tests/content-projection.integration.test.ts',
  'services/main/tests/content-revision-read.integration.test.ts',
  'services/content/tests/core.integration.test.ts',
] as const;

export function isQaIntegrationPath(path: string): boolean {
  return path.startsWith('tests/qa/integration/') || integrationGateFiles.some(file => file === path);
}
export const modelGateFiles = [
  'infra/jena/tests/command.integration.test.ts',
  'model/compiler/generate.test.ts',
  'model/tests/native-equivalence.test.ts',
  'packages/model/tests/generated.test.ts',
] as const;
export function isQaModelPath(path: string): boolean {
  // Native Jena fixture tests and the equivalence matrix require an isolated stack.
  return path === 'infra/jena/tests/command.integration.test.ts'
    || path === 'model/tests/native-equivalence.test.ts';
}
export function isQaFaultPath(path: string): boolean {
  return path.startsWith('tests/qa/fault-recovery/');
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
  if (tiers.some(tier => !(['static', 'unit', 'integration', 'model', 'fault/recovery', 'e2e', 'load'] as Tier[]).includes(tier))) {
    throw new Error(`Prior QA run ${runId} names an unsupported failed tier`);
  }
  const tests = junitResults(directory, tiers).filter(test => test.failed);
  return { sourceRunId: runId, tiers, tests };
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

export function testArgs(tier: 'unit' | 'integration' | 'model' | 'fault/recovery' | 'load', selection?: FailedSelection,
  chosen?: { files?: string[]; id?: string }): string[] {
  const base = tier === 'model' ? '' : tier === 'fault/recovery' ? 'tests/qa/fault-recovery' : `tests/qa/${tier}`;
  const extraGates = tier === 'integration'
    ? [...integrationGateFiles]
    : tier === 'model' ? [...modelGateFiles]
    : tier === 'fault/recovery' || tier === 'load' ? [] : [
      'scripts/dev/bootstrap.test.ts', 'scripts/dev/config.test.ts',
      'services/main/tests/command.test.ts',
      'services/main/tests/work-command.test.ts',
      'services/main/tests/content-eligibility.test.ts',
      'services/main/tests/content-projection-runtime.test.ts',
      'services/main/tests/immutable-objects.test.ts',
      'services/main/tests/api-contract.test.ts'];
  const defaults = [...(base ? [base] : []), ...extraGates];
  if (chosen) {
    const files = chosen.files?.length ? chosen.files : defaults;
    if (files.some(file => !(file === base || file.startsWith(`${base}/`) || extraGates.includes(file))
      || file.includes('..'))) throw new Error(`Selected ${tier} path is not registered`);
    const pattern = chosen.id ? ['-t', `^(?:[A-Z][A-Z0-9]*\\d{2,}/)*${chosen.id}(?:/|:)`] : [];
    return [...new Set(files), ...pattern];
  }
  if (!selection) return defaults;
  const tests = selection.tests.filter(test => test.tier === tier);
  if (!tests.length) return defaults;
  const files = [...new Set(tests.map(test => test.file))].sort();
  if (files.some(file => !(file.startsWith(`${base}/`) || extraGates.includes(file))
    || file.includes('..'))) {
    throw new Error(`Prior ${tier} result contains an unsupported test path`);
  }
  const escape = (value: string) => value.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  // Bun matches describe ancestry as part of the full test title, while JUnit
  // stores the leaf name separately in each testcase.
  return [...files, '-t', `^.*(?:${tests.map(test => escape(test.name)).join('|')})$`];
}

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
    const file = attribute(match[1], 'file');
    if (!name || !file) continue;
    const body = match[2] ?? '';
    const seconds = Number(attribute(match[1], 'time'));
    result.push({ name, file, tier, failed: /<(?:failure|error)\b/.test(body),
      skipped: /<skipped\b/.test(body),
      ...(Number.isFinite(seconds) && seconds >= 0 ? { durationMs: Math.round(seconds * 1000) } : {}) });
  }
  return result;
}

export function junitResults(directory: string, tiers: Tier[]): TestResult[] {
  return tiers.flatMap(tier => {
    const file = join(directory, `${tier}.xml`);
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
  'infra/jena/tests/command.integration.test.ts',
  'services/main/tests/immutable-objects.integration.test.ts',
] as const;

export function isQaIntegrationPath(path: string): boolean {
  return path.startsWith('tests/qa/integration/') || integrationGateFiles.some(file => file === path);
}

export function failedSelection(artifactRoot: string, runId: string): FailedSelection {
  if (!/^[a-z0-9][a-z0-9-]{0,30}$/.test(runId)) throw new Error('Invalid prior run ID');
  const directory = join(artifactRoot, runId);
  const path = join(directory, 'acceptance.json');
  if (!existsSync(path)) throw new Error(`Prior QA run not found: ${runId}`);
  const prior = JSON.parse(readFileSync(path, 'utf8')) as { tiers?: { name: Tier; status: string }[] };
  const tiers = (prior.tiers ?? []).filter(t => t.status === 'failed').map(t => t.name);
  if (!tiers.length) throw new Error(`Prior QA run ${runId} has no failed tier to diagnose`);
  if (tiers.some(tier => !(['static', 'unit', 'integration'] as Tier[]).includes(tier))) {
    throw new Error(`Prior QA run ${runId} names an unsupported failed tier`);
  }
  const tests = junitResults(directory, tiers).filter(test => test.failed);
  return { sourceRunId: runId, tiers, tests };
}

export function testArgs(tier: 'unit' | 'integration', selection?: FailedSelection,
  chosen?: { files?: string[]; id?: string }): string[] {
  const base = `tests/qa/${tier}`;
  const extraGates = tier === 'integration'
    ? [...integrationGateFiles]
    : ['model/compiler/generate.test.ts', 'packages/model/tests/generated.test.ts',
      'scripts/dev/bootstrap.test.ts', 'scripts/dev/config.test.ts',
      'services/main/tests/command.test.ts',
      'services/main/tests/work-command.test.ts',
      'services/main/tests/immutable-objects.test.ts'];
  const defaults = [base, ...extraGates];
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
  return [...files, '-t', `^(?:${tests.map(test => escape(test.name)).join('|')})$`];
}

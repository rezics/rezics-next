import { isQaE2ePath, titleIds, type Case } from './acceptance.ts';
import type { CaseDeclarations, TestIdentity } from './coverage/declaration.ts';
import { join } from 'node:path';

/** Declare only cases whose full scenario is exercised by the named tests. Every
 * `coverage/*.ts` file except `declaration.ts` is discovered, and each of its exported
 * `*Cases` records is merged, so parallel work adds its own file instead of editing one. */
const completeCases: Record<string, readonly TestIdentity[]> = mergeCaseDeclarations(await (async () => {
  const directory = join(import.meta.dir, 'coverage');
  const files = [...new Bun.Glob('*.ts').scanSync({ cwd: directory })]
    .filter(file => file !== 'declaration.ts').sort();
  const groups: CaseDeclarations[] = [];
  for (const file of files) {
    const module = await import(join(directory, file)) as Record<string, unknown>;
    for (const [name, value] of Object.entries(module)) {
      if (name.endsWith('Cases') && value && typeof value === 'object') groups.push(value as CaseDeclarations);
    }
  }
  return groups;
})());

function mergeCaseDeclarations(groups: readonly CaseDeclarations[]): Record<string, readonly TestIdentity[]> {
  const merged: Record<string, readonly TestIdentity[]> = {};
  for (const group of groups) {
    for (const [id, tests] of Object.entries(group)) {
      if (Object.hasOwn(merged, id)) throw new Error(`Duplicate complete-case declaration: ${id}`);
      merged[id] = tests;
    }
  }
  return merged;
}

export function declaredCaseCoverage(cases: readonly Case[], scope: 'all' | 'backend' = 'all'): ReadonlyMap<string, readonly string[]> {
  const inventory = new Set(cases.map(item => item.id));
  const coverage = new Map<string, readonly string[]>();
  for (const [id, declared] of Object.entries(completeCases)) {
    if (!inventory.has(id)) {
      if (scope === 'all') throw new Error(`Invalid complete-case declaration: ${id}`);
      continue;
    }
    const tests = scope === 'backend' && id === 'WORK01'
      ? declared.filter(test => test.tier !== 'e2e') : declared;
    if (tests.length === 0) throw new Error(`Invalid complete-case declaration: ${id}`);
    const identities = tests.map(test => {
      if (scope === 'backend' && (test.tier === 'e2e' || test.file.startsWith('apps/web/'))) {
        throw new Error(`Browser evidence cannot declare backend completion: ${id}`);
      }
      const registeredPath = test.tier === 'e2e' ? isQaE2ePath(test.file)
        : !test.file.includes('..') && test.file.endsWith('.test.ts');
      if (!titleIds(test.name).includes(id) || !registeredPath) {
        throw new Error(`Invalid complete-case test for ${id}`);
      }
      return `${test.tier}:${test.file}:${test.name}`;
    });
    if (new Set(identities).size !== identities.length) throw new Error(`Duplicate complete-case test for ${id}`);
    coverage.set(id, identities);
  }
  return coverage;
}

export function missingCaseDeclarations(cases: readonly Case[], coverage: ReadonlyMap<string, readonly string[]>): string[] {
  return cases.filter(item => !coverage.has(item.id)).map(item => item.id);
}

export interface QualificationRecord {
  runId: string;
  scope?: 'all' | 'backend';
  source: { head: string; fingerprint: string; clean: boolean };
  sourceStable: boolean;
  certifiesFull: boolean;
  ids: Record<string, { status: string; page: string; tests: string[] }>;
}

export function renderQualification(record: QualificationRecord): string {
  if (!record.certifiesFull || !record.source.clean || !record.sourceStable
    || Object.values(record.ids).some(item => item.status !== 'passed')) {
    throw new Error('Cannot record an incomplete or dirty QA run');
  }
  const rows = Object.entries(record.ids).sort(([a], [b]) => a.localeCompare(b)).map(([id, item]) => {
    const page = item.page.replace(/^docs\/testing\//, '../testing/');
    const tests = item.tests.map(identity => `\`${identity.replaceAll('|', '\\|')}\``).join('<br>');
    return `| [${id}](${page}) | pass | ${tests} |`;
  });
  return [
    '# Recorded qualification', '',
    `Full \`yarn qa${record.scope === 'backend' ? ' --backend' : ''} --record\` run \`${record.runId}\` passed on clean commit \`${record.source.head}\` `
      + `(source fingerprint \`${record.source.fingerprint}\`).`, '',
    '| Acceptance ID | Status | Executed evidence |', '| --- | --- | --- |',
    ...rows, '',
  ].join('\n');
}

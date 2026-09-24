import { isQaE2ePath, titleIds, type Case, type TestResult } from './acceptance.ts';

type TestIdentity = Pick<TestResult, 'tier' | 'file' | 'name'>;

/** Declare only cases whose full scenario is exercised by the named tests. */
const completeCases: Record<string, readonly TestIdentity[]> = {
  SYS02: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/lost-response.test.ts',
    name: 'SYS02: a real lost Fuseki response resolves to one Main Work receipt and outbox batch',
  }],
  WORK01: [{
    tier: 'integration',
    file: 'tests/qa/integration/web-auth-bootstrap.test.ts',
    name: 'IAM01/WORK01: authenticated metadata-only Work has an empty Main Version',
  }, {
    tier: 'e2e',
    file: 'apps/web/tests/authenticated-create.e2e.ts',
    name: 'WORK01: authenticated member creates a metadata-only Work with an empty Main Version',
  }],
  WORK03: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-selection-oracle.test.ts',
    name: 'WORK03/SEARCH19: Realm adoption switch preserves other selections and contributor state',
  }],
  WORK09: [{
    tier: 'integration',
    file: 'tests/qa/integration/content-publication-native.test.ts',
    name: 'WORK09/WORK10/SEARCH19: Content CAS and partial native publication with exact search',
  }],
  SEARCH01: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH18: Chinese rated Realm join and bounded late match',
  }],
  SEARCH02: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH18: Chinese rated Realm join and bounded late match',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH02/SEARCH10: a 513th raw hit cannot become a false complete empty result',
  }],
  SEARCH04: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH18: Chinese rated Realm join and bounded late match',
  }],
};

export function declaredCaseCoverage(cases: readonly Case[]): ReadonlyMap<string, readonly string[]> {
  const inventory = new Set(cases.map(item => item.id));
  const coverage = new Map<string, readonly string[]>();
  for (const [id, tests] of Object.entries(completeCases)) {
    if (!inventory.has(id) || tests.length === 0) throw new Error(`Invalid complete-case declaration: ${id}`);
    const identities = tests.map(test => {
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
    `Full \`yarn qa --record\` run \`${record.runId}\` passed on clean commit \`${record.source.head}\` `
      + `(source fingerprint \`${record.source.fingerprint}\`).`, '',
    '| Acceptance ID | Status | Executed evidence |', '| --- | --- | --- |',
    ...rows, '',
  ].join('\n');
}

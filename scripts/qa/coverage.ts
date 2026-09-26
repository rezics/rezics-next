import { isQaE2ePath, titleIds, type Case, type TestResult } from './acceptance.ts';

type TestIdentity = Pick<TestResult, 'tier' | 'file' | 'name'>;

/** Declare only cases whose full scenario is exercised by the named tests. */
const completeCases: Record<string, readonly TestIdentity[]> = {
  VIEW01: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-address-api.test.ts',
    name: 'VIEW01/VIEW02: Work address claims, renames and dispositions preserve exact identities',
  }],
  VIEW02: [{
    tier: 'integration',
    file: 'tests/qa/integration/work-address-api.test.ts',
    name: 'VIEW01/VIEW02: Work address claims, renames and dispositions preserve exact identities',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-chain.test.ts',
    name: 'VIEW02: bounded redirect traversal preserves a valid last hop',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-chain.test.ts',
    name: 'VIEW02: a valid chain past the bound is unavailable, not missing',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/work-address-chain.test.ts',
    name: 'VIEW02: a cycle or missing redirect target is unavailable',
  }],
  CTX02: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-selection-oracle.test.ts',
    name: 'CTX02/CTX03/WORK03/SEARCH07/SEARCH19: joined decisions and Realm selection refresh only affected roots',
  }],
  CTX03: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-selection-oracle.test.ts',
    name: 'CTX02/CTX03/WORK03/SEARCH07/SEARCH19: joined decisions and Realm selection refresh only affected roots',
  }],
  IAM10: [{
    tier: 'integration',
    file: 'tests/qa/integration/authenticated-api-journey.test.ts',
    name: 'IAM01/IAM10/IAM21/MODEL01/MODEL08/WORK01/WORK05/WORK09/BOOK04/CTX01/CTX02/SEARCH01: authenticated S2 API journey',
  }],
  IAM23: [{
    tier: 'integration',
    file: 'tests/qa/integration/access-org-realm-api.test.ts',
    name: 'IAM23/IAM24/IAM06: independent Org/Realm participation requires two exact authorities',
  }, {
    tier: 'integration',
    file: 'tests/qa/integration/organization-publication-moderation.test.ts',
    name: 'IAM23: exact organization publication moderation and suspension affect only the admitted Realm',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/organization-publication-recovery.test.ts',
    name: 'IAM23/OPS03: isolated Access cuts and graph replay preserve one exact local organization rejection',
  }],
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
    name: 'CTX02/CTX03/WORK03/SEARCH07/SEARCH19: joined decisions and Realm selection refresh only affected roots',
  }],
  WORK05: [{
    tier: 'integration',
    file: 'tests/qa/integration/authenticated-api-journey.test.ts',
    name: 'IAM01/IAM10/IAM21/MODEL01/MODEL08/WORK01/WORK05/WORK09/BOOK04/CTX01/CTX02/SEARCH01: authenticated S2 API journey',
  }, {
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/fixed-release-recovery.test.ts',
    name: 'MODEL01/WORK05/OPS03: graph loss restores only the admitted fixed release and exact bytes',
  }],
  WORK09: [{
    tier: 'integration',
    file: 'tests/qa/integration/content-publication-native.test.ts',
    name: 'WORK09/WORK10/SEARCH03/SEARCH19: Content CAS, private drafts and exact public search',
  }],
  RATE03: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/rating-daily.test.ts',
    name: 'RATE02/RATE03/OPS03: daily server periods and private slots survive real API races and graph loss',
  }, {
    tier: 'model',
    file: 'model/tests/daily-rating.test.ts',
    name: 'RATE03/MODEL17: daily shapes and native bindings reject missing or mismatched calendar fields',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-calendar.test.ts',
    name: 'RATE03: server civil periods resolve DST, repeated hours and skipped midnight',
  }, {
    tier: 'unit',
    file: 'services/main/tests/rating-calendar.test.ts',
    name: 'RATE03: daily slots count the private principal and civil day independently of personas',
  }],
  RATE04: [{
    tier: 'integration',
    file: 'tests/qa/integration/rating-withdrawal.test.ts',
    name: 'RATE04: a withdrawn latest opinion keeps earlier immutable revisions without resurrecting their values',
  }],
  SEARCH01: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging and author switch',
  }],
  SEARCH02: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging and author switch',
  }, {
    tier: 'unit',
    file: 'tests/qa/unit/search-budgets.test.ts',
    name: 'SEARCH02/SEARCH10: a 513th raw hit cannot become a false complete empty result',
  }],
  SEARCH04: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-scale.test.ts',
    name: 'SEARCH01/SEARCH02/SEARCH04/SEARCH07/SEARCH08/SEARCH16/SEARCH18: rated Realm join, bounded paging and author switch',
  }],
  SEARCH05: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-unsupported.test.ts',
    name: 'SEARCH05: every public phrase lane rejects declared multi-dataset policy before native index access',
  }],
  SEARCH06: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-cjk.test.ts',
    name: 'SEARCH06: versioned CJK Main and Realm phrases bind exact selected bodies and languages',
  }],
  SEARCH09: [{
    tier: 'integration',
    file: 'tests/qa/integration/public-search-unsupported.test.ts',
    name: 'SEARCH09: every current-only public phrase lane rejects an as-of source position',
  }],
  SEARCH13: [{
    tier: 'integration',
    file: 'tests/qa/integration/search-graph-sentinel.test.ts',
    name: 'SEARCH13: a retained named graph exposes deletion of its last indexed literal',
  }],
  SEARCH17: [{
    tier: 'fault/recovery',
    file: 'tests/qa/fault-recovery/search-raw-import.test.ts',
    name: 'SEARCH17: quarantined bare-TDB2 import stays unavailable until exact offline rebuild',
  }],
};

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

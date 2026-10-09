import { existsSync, readFileSync } from 'node:fs';
import { isAbsolute, join, relative } from 'node:path';

/** One authority for a decision. Adapters may carry data or project a read; they do not own the effect. */
export interface Mechanism {
  id: string;
  /** Module directory that owns the decision. */
  owner: string;
  /** `file.ts#Export` paths relative to `owner`. */
  entryPoints: readonly string[];
  /** Tables or values only this owner records. */
  ownedState: readonly string[];
  /** Effects only this owner may perform. */
  protectedEffects: readonly string[];
  /** Adapter roles that may carry or project the owner's data without deciding it. */
  allowedAdapters: readonly string[];
  /** Tests that keep the owner's behaviour. */
  conformanceTests: readonly string[];
}

export const mechanisms = [
  {
    id: 'rights-evaluation',
    owner: 'services/main/src/modules/rights',
    entryPoints: ['store.ts#RightsStore', 'schema.ts#useAssessment', 'schema.ts#obligation'],
    ownedState: ['rights.material', 'rights.use_assessment', 'rights.use_assessment_head', 'rights.obligation'],
    protectedEffects: ['write assessment', 'write obligation', 'derive obligation from a licence'],
    allowedAdapters: ['licence-data', 'assessment-projection'],
    conformanceTests: ['tests/qa/integration/rights-use-assessment.test.ts'],
  },
  {
    id: 'governance-restriction',
    owner: 'services/main/src/modules/governance',
    entryPoints: ['store.ts#GovernanceStore', 'schema.ts#governanceEnforcement'],
    ownedState: ['access.governance_enforcement'],
    protectedEffects: ['write enforcement fence', 'advance fence epoch'],
    allowedAdapters: ['enforcement-read'],
    conformanceTests: ['services/main/tests/governance-schema.test.ts'],
  },
  {
    id: 'language-parsing',
    owner: 'services/main/src/modules/display-language',
    entryPoints: ['tag.ts#parseLanguage', 'tag.ts#canonicalLanguage'],
    ownedState: ['LanguageTag'],
    protectedEffects: ['parse language tag'],
    allowedAdapters: ['parseLanguage'],
    conformanceTests: [
      'services/main/tests/display-language.test.ts',
      'scripts/static/ast-grep/tests/one-language-parser-test.yml',
    ],
  },
  {
    id: 'access-authority',
    owner: 'services/main/src/modules/access',
    entryPoints: [
      'fixture-authority.ts#grantFixtureAuthority',
      'grants.ts#AccessGrants',
      'representations.ts#AccessRepresentations',
      'scope-gates.ts#ensureBaselineScopeGate',
    ],
    ownedState: ['access.scope_gate', 'access.representation', 'access.permission_grant', 'access.policy'],
    protectedEffects: ['write scope gate', 'write representation', 'write permission grant', 'write access policy'],
    allowedAdapters: ['authority-read'],
    conformanceTests: [
      'tests/qa/unit/dataset-bootstrap.test.ts',
      'scripts/static/mechanism-writers.test.ts',
      'tests/qa/integration/access-baseline-seed.test.ts',
      'tests/qa/integration/web-auth-bootstrap.test.ts',
    ],
  },
] as const satisfies readonly Mechanism[];

export type MechanismId = (typeof mechanisms)[number]['id'];

const SELECTORS = ['entryPoints', 'ownedState', 'protectedEffects', 'allowedAdapters', 'conformanceTests'] as const;

function exportsSymbol(source: string, name: string): boolean {
  if (new RegExp(`export\\s+(?:async\\s+)?(?:function|class|const|let|var|type|interface|enum)\\s+${name}\\b`).test(source)) {
    return true;
  }
  for (const group of source.matchAll(/export\s+(?:type\s+)?\{([^}]+)\}/g)) {
    for (const part of group[1]!.split(',')) {
      const names = /^(?:type\s+)?([A-Za-z0-9_]+)(?:\s+as\s+([A-Za-z0-9_]+))?$/.exec(part.trim());
      if (names && (names[2] ?? names[1]) === name) return true;
    }
  }
  return false;
}

/** Duplicate ids or owners, an entry point that does not resolve, or an empty selector. */
export function mechanismMapErrors(list: readonly Mechanism[], root: string): string[] {
  const errors: string[] = [];
  const ids = new Set<string>();
  const owners = new Set<string>();
  for (const entry of list) {
    if (!entry.id.trim()) errors.push('empty mechanism id');
    else if (ids.has(entry.id)) errors.push(`duplicate mechanism id: ${entry.id}`);
    else ids.add(entry.id);
    if (!entry.owner.trim()) errors.push(`${entry.id || '(missing)'}: empty owner`);
    else if (owners.has(entry.owner)) errors.push(`duplicate mechanism owner: ${entry.owner}`);
    else owners.add(entry.owner);
    for (const field of SELECTORS) {
      const values = entry[field];
      if (!values.length) errors.push(`${entry.id}: empty selector ${field}`);
      for (const value of values) if (!value.trim()) errors.push(`${entry.id}: empty selector in ${field}`);
    }
    for (const point of entry.entryPoints) {
      const hash = point.indexOf('#');
      const fileName = hash > 0 ? point.slice(0, hash) : '';
      const symbol = hash > 0 ? point.slice(hash + 1) : '';
      if (!fileName || !symbol || fileName.split('/').includes('..') || isAbsolute(fileName)) {
        errors.push(`${entry.id}: entry point does not resolve: ${point}`);
        continue;
      }
      const file = join(root, entry.owner, fileName);
      if (relative(join(root, entry.owner), file).startsWith('..') || !existsSync(file)) {
        errors.push(`${entry.id}: entry point does not resolve: ${point}`);
        continue;
      }
      if (!exportsSymbol(readFileSync(file, 'utf8'), symbol)) {
        errors.push(`${entry.id}: entry point does not resolve: ${point}`);
      }
    }
    for (const test of entry.conformanceTests) {
      if (isAbsolute(test) || test.split('/').includes('..') || !existsSync(join(root, test))) {
        errors.push(`${entry.id}: conformance test does not resolve: ${test}`);
      }
    }
  }
  return errors;
}

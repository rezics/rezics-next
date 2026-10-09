import { expect, test } from 'bun:test';
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { mechanisms, type Mechanism } from './mechanisms.ts';
import {
  allowedImportFiles,
  assessMechanismDependencies,
  cruiseDependencies,
  cruiseMechanismDependencies,
  loadMechanismDependencyDebt,
  mechanismCruiseConfig,
  mechanismDependencyDebtErrors,
  mechanismDependencyDebtShapeErrors,
  mechanismRuleName,
  ownerSelector,
  readDependencyCruiseConfig,
  type MechanismCruiseRule,
  type MechanismDependency,
} from './mechanism-dependencies.ts';

const root = fileURLToPath(new URL('../../', import.meta.url));

function withTree(files: Record<string, string>, run: (tree: string) => void) {
  mkdirSync(join(root, '.temp'), { recursive: true });
  const tree = mkdtempSync(join(root, '.temp', 'mechanism-dependencies-'));
  try {
    for (const [path, body] of Object.entries(files)) {
      const absolute = join(tree, path);
      mkdirSync(join(absolute, '..'), { recursive: true });
      writeFileSync(absolute, body);
    }
    run(tree);
  } finally {
    rmSync(tree, { recursive: true, force: true });
  }
}

const sample = (owner: string): Mechanism => ({
  id: 'sample-owner',
  owner,
  entryPoints: ['store.ts#Store'],
  ownedState: ['sample.state'],
  protectedEffects: ['write sample'],
  allowedAdapters: ['licence-data'],
  conformanceTests: ['scripts/static/mechanisms.test.ts'],
});

function cruiseSample(tree: string): MechanismDependency[] {
  const assessment = assessMechanismDependencies([sample('modules/rights')], tree);
  expect(assessment.errors).toEqual([]);
  const rules: MechanismCruiseRule[] = assessment.rules;
  return cruiseDependencies(
    tree,
    { forbidden: rules, options: { doNotFollow: { path: 'node_modules' } } },
    ['modules'],
  ).mechanism;
}

test('an existing allowed caller and an adapter file pass', () => {
  withTree(
    {
      'modules/rights/store.ts': 'export class Store {}\n',
      'modules/rights/internal.ts': 'export const secret = 1;\n',
      'modules/rights/licence-data.ts': 'export const licence = 1;\n',
      'modules/caller/allowed.ts':
        "import { Store } from '../rights/store.ts';\nexport const store = Store;\n",
      'modules/caller/adapter.ts':
        "import { licence } from '../rights/licence-data.ts';\nexport const value = licence;\n",
    },
    (tree) => {
      expect(cruiseSample(tree)).toEqual([]);
    },
  );
});

test('a new import of an owner internal fails, including a pass-through facade', () => {
  withTree(
    {
      'modules/rights/store.ts': 'export class Store {}\n',
      'modules/rights/internal.ts': 'export const secret = 1;\n',
      'modules/rights/facade.ts': "export { secret } from './internal.ts';\n",
      'modules/caller/leak.ts':
        "import { secret } from '../rights/internal.ts';\nexport const value = secret;\n",
      'modules/caller/wrapped.ts':
        "import { secret } from '../rights/facade.ts';\nexport const value = secret;\n",
    },
    (tree) => {
      const assessment = assessMechanismDependencies([sample('modules/rights')], tree);
      expect(assessment.rules[0]?.comment).toContain('entry point');
      expect(assessment.rules[0]?.comment).toContain('facade');
      expect(assessment.rules[0]?.from.pathNot).toBe(ownerSelector('modules/rights'));
      expect(Array.isArray(assessment.rules[0]?.from.pathNot)).toBe(false);
      const found = cruiseDependencies(
        tree,
        { forbidden: assessment.rules, options: { doNotFollow: { path: 'node_modules' } } },
        ['modules'],
      ).mechanism;
      expect(found).toContainEqual({
        importer: 'modules/caller/leak.ts',
        imported: 'modules/rights/internal.ts',
      });
      expect(found).toContainEqual({
        importer: 'modules/caller/wrapped.ts',
        imported: 'modules/rights/facade.ts',
      });
    },
  );
});

test('a debt entry that no longer occurs fails until removed', () => {
  const live = [{ importer: 'modules/caller/leak.ts', imported: 'modules/rights/internal.ts' }];
  const stale = { importer: 'modules/caller/allowed.ts', imported: 'modules/rights/store.ts' };
  expect(mechanismDependencyDebtErrors(live, [live[0]!, stale])).toEqual([
    'modules/caller/allowed.ts → modules/rights/store.ts no longer occurs; remove it from the debt list',
  ]);
  expect(mechanismDependencyDebtErrors(live, live)).toEqual([]);
  withTree(
    {
      'modules/rights/store.ts': 'export class Store {}\n',
      'modules/rights/internal.ts': 'export const secret = 1;\n',
      'modules/caller/leak.ts':
        "import { secret } from '../rights/internal.ts';\nexport const value = secret;\n",
    },
    (tree) => {
      const found = cruiseSample(tree);
      expect(mechanismDependencyDebtErrors(found, [...found, stale]).join('\n')).toContain(
        'no longer occurs',
      );
    },
  );
});

test('an empty selector fails and does not emit a rule that matches nothing', () => {
  const [rights] = mechanisms;
  const missing = assessMechanismDependencies(
    [{ ...rights!, owner: 'services/main/src/modules/rights-missing' }],
    root,
  );
  expect(missing.errors).toContain(
    'rights-evaluation: selector matches no file: services/main/src/modules/rights-missing',
  );
  expect(missing.rules.map((rule) => rule.name)).not.toContain(
    mechanismRuleName('rights-evaluation'),
  );
  const empty = assessMechanismDependencies([{ ...rights!, entryPoints: [] }], root);
  expect(empty.errors).toContain('rights-evaluation: selector matches no file: entry points');
});

test('debt accepts only exact file pairs', () => {
  expect(mechanismDependencyDebtShapeErrors([{ importer: 'a.ts', imported: 'b.ts' }])).toEqual([]);
  expect(
    mechanismDependencyDebtShapeErrors([{ importer: 'dir/', imported: 'b.ts' }]).join('\n'),
  ).toContain('exact file pair');
  expect(
    mechanismDependencyDebtShapeErrors([{ importer: '**/*.ts', imported: 'b.ts' }]).join('\n'),
  ).toContain('exact file pair');
  expect(
    mechanismDependencyDebtShapeErrors([{ importer: 'a.ts', imported: 'owner/' }]).join('\n'),
  ).toContain('exact file pair');
  expect(
    mechanismDependencyDebtShapeErrors([
      { importer: 'a.ts', imported: 'b.ts', directory: 'services/main/src/modules/rights' },
    ]).join('\n'),
  ).toContain('only an importer');
});

test("the mechanism map's import surface is its entry-point files and named adapter files", () => {
  expect(assessMechanismDependencies(mechanisms, root).errors).toEqual([]);
  expect(
    Object.fromEntries(mechanisms.map((entry) => [entry.id, allowedImportFiles(entry, root)])),
  ).toEqual({
    'rights-evaluation': [
      'services/main/src/modules/rights/schema.ts',
      'services/main/src/modules/rights/store.ts',
    ],
    'governance-restriction': [
      'services/main/src/modules/governance/rules.ts',
      'services/main/src/modules/governance/schema.ts',
      'services/main/src/modules/governance/store.ts',
    ],
    'language-parsing': [
      'services/main/src/modules/display-language/public-request.ts',
      'services/main/src/modules/display-language/schema.ts',
      'services/main/src/modules/display-language/select.ts',
      'services/main/src/modules/display-language/tag.ts',
    ],
    'access-authority': [
      'services/main/src/modules/access/admission.ts',
      'services/main/src/modules/access/authority-read.ts',
      'services/main/src/modules/access/baseline.ts',
      'services/main/src/modules/access/exposure.ts',
      'services/main/src/modules/access/fixture-authority.ts',
      'services/main/src/modules/access/grants.ts',
      'services/main/src/modules/access/memberships.ts',
      'services/main/src/modules/access/platform-administrator.ts',
      'services/main/src/modules/access/representations.ts',
      'services/main/src/modules/access/scope-gates.ts',
      'services/main/src/modules/access/semantic-disclosure.ts',
      'services/main/src/modules/access/topology-control.ts',
    ],
  });
  const rules = assessMechanismDependencies(mechanisms, root).rules;
  expect(rules.map((rule) => rule.name)).toEqual(
    mechanisms.map((entry) => mechanismRuleName(entry.id)),
  );
  for (const entry of mechanisms) {
    const rule = rules.find((item) => item.name === mechanismRuleName(entry.id));
    expect(typeof rule?.from.pathNot).toBe('string');
    const boundary = new RegExp(rule!.from.pathNot);
    expect(boundary.test(`${entry.owner}-renamed/file.ts`)).toBe(false);
    for (const file of allowedImportFiles(entry, root)) {
      expect(boundary.test(file)).toBe(true);
      expect(new RegExp(rule!.to.path).test(file)).toBe(true);
      expect(rule!.to.pathNot?.some((pattern) => new RegExp(pattern).test(file))).toBe(true);
      expect(
        rule!.to.pathNot?.some((pattern) => new RegExp(pattern).test(`${file}.extra.ts`)),
      ).toBe(false);
    }
  }
  const merged = mechanismCruiseConfig(readDependencyCruiseConfig(root), rules);
  const names = (merged.forbidden ?? []).map((rule) => (rule as { name?: string }).name);
  expect(names).toContain('web-only-uses-public-service-contract');
  expect(names).toContain(mechanismRuleName('rights-evaluation'));
});

test('repository imports outside an owner stay on the entry-point debt list', () => {
  const loaded = loadMechanismDependencyDebt(root);
  expect(loaded.errors).toEqual([]);
  const findings = cruiseMechanismDependencies(root);
  expect(findings.errors).toEqual([]);
  expect(findings.other).toEqual([]);
  expect(mechanismDependencyDebtErrors(findings.mechanism, loaded.debt)).toEqual([]);
  expect(findings.mechanism).not.toContainEqual({
    importer: 'services/main/src/modules/search/ranked.ts',
    imported: 'services/main/src/modules/display-language/tag.ts',
  });
}, 180_000);

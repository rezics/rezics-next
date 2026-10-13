import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';
import { integrationGateFiles } from './integration-gate-files.ts';

/** Outcome proofs may depend on public clients and fixture support, never product internals. */
export function outcomeTestViolations(
  file: string,
  source: string,
  root = process.cwd(),
): string[] {
  const path = relative(root, resolve(root, file)).replaceAll('\\', '/');
  if (!path.startsWith('tests/qa/integration/outcomes/')) return [];
  const transpiler = new Bun.Transpiler({ loader: 'tsx' });
  const violations = new Set<string>();
  const checkImport = (specifier: string) => {
    const target = specifier.startsWith('.')
      ? relative(root, resolve(root, dirname(path), specifier)).replaceAll('\\', '/')
      : specifier;
    if (/(?:^|\/)(?:services|apps)\/[^/]+\/src(?:\/|$)/.test(target))
      violations.add(`imports product source: ${specifier}`);
  };
  for (const item of transpiler.scan(source).imports) checkImport(item.path);
  // Bun erases type-only and unused import-equals declarations. Keep their
  // literal dependencies in this conservative source inventory as well.
  const withoutComments = source.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '');
  for (const match of withoutComments.matchAll(
    /\b(?:import|export)\s+[^;]*?\bfrom\s*['"]([^'"]+)['"]/g,
  ))
    checkImport(match[1]!);
  for (const match of withoutComments.matchAll(/\b(?:require|import)\s*\(\s*['"]([^'"]+)['"]/g))
    checkImport(match[1]!);
  // Transformation removes comments; masking quoted values avoids treating examples as calls.
  const executable = transpiler
    .transformSync(source)
    .replace(/\bmock\s*\[\s*['"]module['"]\s*\]/g, 'mock.module')
    .replace(/"(?:\\.|[^"\\])*"|'(?:\\.|[^'\\])*'/g, '""');
  if (/\bmock\s*(?:\.|\?\.)\s*module\s*(?:\?\.)?\s*\(/.test(executable))
    violations.add('calls mock.module');
  return [...violations];
}

export function outcomeRepositoryViolations(root = process.cwd()): string[] {
  return [
    ...new Bun.Glob(outcomeSourcePattern).scanSync({
      cwd: root,
    }),
  ]
    .sort()
    .flatMap((file) =>
      outcomeTestViolations(file, readFileSync(resolve(root, file), 'utf8'), root).map(
        (reason) => `${file}: ${reason}`,
      ),
    );
}

export const outcomeSourcePattern = 'tests/qa/integration/outcomes/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}';

export interface RepositoryGuard {
  file: string;
  reason: string;
  /** Repository-relative files/globs, including scan inputs and supporting code.
   * Omit when the inventory cannot be bounded more narrowly than the whole tree. */
  reads?: readonly string[];
}

const mainContractReads = ['services/main/src/**', 'packages/{model,document,observability,wiki-toolkit}/**', 'scripts/api/**'];
const generatedContractReads = ['generated/openapi/main/public.json'];
const migrationReads = ['services/*/migrations/**/*.sql'];
const webSourcePattern = 'apps/web/**/*.{ts,tsx,js,jsx,mts,cts}';

/** Inventory guards read beyond their import graph. Gate selection uses these
 * inventories; main-wide runs retain the complete registry. */
export const repositoryGuards = [
  {
    file: 'scripts/api/answer-records.guard.test.ts',
    reads: ['tests/qa/fixtures/outcomes/**/*.json', ...mainContractReads],
    reason: 'Every outcome answer record must validate against the public contract generated from the tree.',
  },
  {
    file: 'scripts/qa/repository-guards.test.ts',
    reads: [outcomeSourcePattern],
    reason: 'Outcome tests use the public API without importing product source or mocking modules.',
  },
  {
    file: 'scripts/qa/raw-sparql-integration-files.test.ts',
    reads: ['tests/**', ...integrationGateFiles, 'services/*/tests/**', 'scripts/qa/**', 'scripts/fixture/**', 'scripts/dev/**'],
    reason:
      'No new test file may write raw SPARQL; a new test selects only itself, never this inventory.',
  },
  {
    file: 'packages/observability/tests/http-measurement.test.ts',
    reads: ['infra/jena/command-module/src/main/java/com/rezics/jena/*.java', 'packages/observability/src/**'],
    reason:
      'Every counter the native module reports must be on the HTTP measurement allowlist; a Java change does not select this test.',
  },
  {
    file: 'services/account/tests/authentication-subject.test.ts',
    reads: ['services/account/**', 'scripts/qa/**', 'scripts/dev/**', 'packages/observability/**', 'package.json', 'yarn.lock'],
    reason:
      'Every Account request cookie parser must use the provider-exact authentication selector.',
  },
  {
    file: 'tests/qa/unit/g-1046-sql-relations.test.ts',
    reads: ['{services,scripts,tests}/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', ...migrationReads, 'tests/qa/unit/g-1046-parent-frame.ts.txt'],
    reason: 'Every SQL source relation must exist in the complete migrated relation inventory.',
  },
  {
    file: 'services/main/tests/platform-exposure.test.ts',
    reads: [...mainContractReads, 'services/main/tests/platform-foundation.ts', 'services/main/tests/support/**'],
    reason: 'Every installed Main route must declare its platform exposure.',
  },
  {
    file: 'scripts/static/list-convention.test.ts',
    reads: [...generatedContractReads, 'scripts/static/list-convention*'],
    reason: 'Every public OpenAPI list operation must meet the list convention without new debt.',
  },
  {
    file: 'scripts/static/web-continuations.test.ts',
    reads: [webSourcePattern, ...generatedContractReads, 'scripts/static/web-continuations*'],
    reason: 'Web list consumers preserve continuations and offer a route beyond capped results.',
  },
  {
    file: 'scripts/static/web-accepted-commands.test.ts',
    reads: ['apps/web/**/*.{ts,tsx}', 'packages/**', ...generatedContractReads, 'scripts/static/web-accepted-commands*'],
    reason: 'Web command consumers distinguish accepted pending operations from completed effects.',
  },
  {
    file: 'scripts/static/web-acting-identity.test.ts',
    reads: ['apps/web/**/*.{ts,tsx}', ...mainContractReads, 'scripts/static/web-acting-identity*'],
    reason: 'Identity-required web reads carry the selected acting identity.',
  },
  {
    file: 'scripts/static/web-page-filtering.test.ts',
    reads: [webSourcePattern, ...generatedContractReads, 'scripts/static/web-page-filtering*', 'scripts/static/web-continuations*'],
    reason: 'Web consumers do not define result eligibility by filtering only a capped API page.',
  },
  {
    file: 'tests/qa/unit/test-registry.test.ts',
    reads: ['**/*.test.{ts,tsx}', 'scripts/qa/**', 'scripts/goal/**'],
    reason: 'Every tracked Bun test must belong to a QA tier or a reasoned exclusion.',
  },
  {
    file: 'services/main/tests/g-543-rate-limit.test.ts',
    reads: [...mainContractReads, 'services/main/migrations/access/*.sql', 'services/main/tests/support/**', 'tests/qa/support/**', 'scripts/dev/**', 'scripts/lib/**', 'apps/web/features/api/bff.ts'],
    reason: 'Every installed Main route and generated operation must have a rate-limit family.',
  },
  {
    file: 'tests/qa/unit/migration-numbers.test.ts',
    reads: [...migrationReads],
    reason: 'Every owner migration directory must number its files uniquely.',
  },
  {
    file: 'scripts/lib/g-940-migration-order.test.ts',
    reads: [...migrationReads, 'services/content/src/migrate.ts', 'scripts/lib/**', 'scripts/ops/migrate.ts', 'scripts/fixture/**', 'scripts/load/compatibility.ts', 'model/**'],
    reason: 'All owner migration inventories must retain numeric order and complete versions.',
  },
  {
    file: 'scripts/qa/schema-order-audit.test.ts',
    reads: ['{scripts,services,tests}/**/*.{ts,tsx,js,jsx}', 'scripts/static/ast-grep/rules/numeric-migrations.yml'],
    reason: 'All migration readers in scripts, services and tests must use numeric ordering.',
  },
  {
    file: 'tests/qa/unit/serialization-points.test.ts',
    reads: ['services/*/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', 'services/*/migrations/**/*.sql', 'scripts/qa/serialization-points.ts', 'scripts/qa/sql-relations.ts', 'scripts/lib/migration-order.ts'],
    reason:
      'All service migrations and write sources must avoid unapproved serialization and gate upgrades.',
  },
  {
    file: 'scripts/static/anti-silo.test.ts',
    reads: ['services/main/src/**', 'apps/web/app/**', 'apps/web/features/**', '{services,apps}/**/migrations/**/*.sql', 'packages/zone-sdk/src/index.ts', 'model/**', 'scripts/static/anti-silo-baseline.json', 'scripts/static/fixtures/anti-silo/**', '.dependency-cruiser.json', 'tsconfig.json'],
    reason:
      'All migrations and shared Main/web source trees must stay within the anti-silo baseline.',
  },
  {
    file: 'tests/qa/unit/outbox-event-handlers.test.ts',
    reads: ['services/main/src/modules/**/*.ts', 'services/main/src/**', 'packages/{model,observability}/**'],
    reason: 'Every statically emitted Main outbox event kind must have a relay reader.',
  },
  {
    file: 'services/main/tests/g-896-content-sequence.test.ts',
    reads: ['services/**/src/**/*.ts'],
    reason:
      'All service source files must leave Content event numbering and appends to the sequencer.',
  },
  {
    file: 'services/main/tests/g-829-public-reads.test.ts',
    reads: [...mainContractReads, 'services/main/tests/support/**'],
    reason:
      'The complete resource, composition, Collection and lexicon GET inventory must declare disclosure.',
  },
  {
    file: 'services/main/tests/g-656-vertical-facts.test.ts',
    reads: [...mainContractReads],
    reason: 'The full served Main operation inventory must contain no vertical facts operations.',
  },
  {
    file: 'services/main/tests/api-contract.test.ts',
    reads: [...generatedContractReads, ...mainContractReads],
    reason:
      'Every generated public operation must retain versioned paths and declared success/problem responses.',
  },
  {
    file: 'tests/qa/unit/openapi-tuples.test.ts',
    reads: [...generatedContractReads, 'scripts/api/generate.ts'],
    reason:
      'Every schema in the generated public contract must use JSON Schema 2020-12 tuple keywords.',
  },
  {
    file: 'tests/qa/unit/acceptance.test.ts',
    reads: ['scripts/qa/**', 'services/*/tests/**', 'tests/qa/**', 'scripts/goal/test-command.ts'],
    reason: 'Every acceptance case file must leave the frozen rows and their digest unchanged.',
  },
  {
    file: 'tests/qa/unit/backend-operation-map.test.ts',
    reads: [...generatedContractReads, 'scripts/qa/**'],
    reason:
      'The complete frozen backend case inventory must map existing operations to the public contract.',
  },
  {
    file: 'services/main/tests/g-845-protocol.test.ts',
    reads: [...mainContractReads, 'packages/wiki-toolkit/**', 'scripts/static/ast-grep/rules/*.yml'],
    reason:
      'Every standalone wiki protocol source must retain licensing and avoid product/runtime dependencies.',
  },
  {
    file: 'packages/wiki-toolkit/tests/package.test.ts',
    reads: ['packages/wiki-toolkit/**', 'tests/fixtures/wiki-toolkit/**', 'package.json', 'yarn.lock'],
    reason:
      'Every wiki toolkit source import must stay local or declared and avoid networking/runtime dependencies.',
  },
  {
    file: 'tests/qa/unit/app-error-hook.test.ts',
    reads: ['services/main/src/app.ts', 'services/main/src/routes/*.ts'],
    reason:
      'Route modules mounted by createMainApp must not declare a local error hook the app hook would hide.',
  },
  {
    file: 'scripts/static/mechanisms.test.ts',
    reads: ['scripts/static/mechanisms.ts', 'services/main/src/modules/{rights,governance,display-language,access}/**', 'scripts/static/*.test.ts', 'services/main/tests/**'],
    reason: 'The mechanism map has one owner per concept and resolvable entry points.',
  },
  {
    file: 'scripts/static/mechanism-dependencies.test.ts',
    reads: ['{services,apps,packages,model,scripts}/**', '.dependency-cruiser.json', 'tsconfig.json'],
    reason:
      "Code outside a mechanism owner may import only that owner's entry points and named adapter files.",
  },
  {
    file: 'scripts/static/mechanism-writers.test.ts',
    reads: ['services/**/src/**/*.ts', 'scripts/**/*.ts', 'scripts/static/fixtures/mechanism-writers/**', 'scripts/static/mechanism-writers.ts'],
    reason:
      'Only the Rights and Governance owners write assessment, obligation and enforcement-fence state.',
  },
  {
    file: 'scripts/static/one-language-parser-debt.test.ts',
    reason:
      'Language-tag parsing outside the display-language module stays at the frozen violations.',
  },
  {
    file: 'scripts/static/docker-ownership.test.ts',
    reads: ['tests/**/*.ts', 'tests/**/*.tsx', 'scripts/qa/**/*.ts', 'scripts/qa/**/*.tsx', 'services/*/tests/**/*.ts', 'services/*/tests/**/*.tsx', 'scripts/static/docker-ownership*', 'scripts/static/fixtures/docker-ownership/**'],
    reason: 'Every QA docker spawn must keep the reap owner, and the frozen exceptions stay exact.',
  },
  {
    file: 'scripts/static/access-fixture-writes.test.ts',
    reads: ['{apps,services,tests,scripts,packages}/**/*.{ts,tsx,mts,cts}', 'scripts/static/access-fixture-writes-debt.json', 'scripts/static/fixtures/access-fixture-writes/**'],
    reason: 'Every direct write to access fixture tables stays on the frozen debt list.',
  },
  {
    file: 'scripts/qa/hidden-id-equality.test.ts',
    reads: [...generatedContractReads, 'scripts/qa/hidden-id-equality.ts', 'scripts/static/hidden-id-reads.json'],
    reason:
      'Every id-accepting GET or POST must be registered, exempted, or kept on the frozen hidden-id debt list.',
  },
] as const satisfies readonly RepositoryGuard[];

/** Empty changes run nothing, even conservative guards. An omitted change set
 * means a main-wide/regression run and deliberately retains every guard. */
export function selectRepositoryGuards(
  changed: readonly string[] | undefined,
  guards: readonly RepositoryGuard[] = repositoryGuards,
): RepositoryGuard[] {
  if (changed === undefined) return [...guards];
  if (!changed.length) return [];
  if (changed.includes('scripts/qa/repository-guards.ts')) return [...guards];
  return guards.filter(guard => !guard.reads || changed.some(file =>
    file === guard.file || guard.reads!.some(pattern => new Bun.Glob(pattern).match(file))));
}

/** Apply the same decision to guards already included by an affected plan. */
export function filterRepositoryGuardFiles(files: readonly string[], changed: readonly string[] | undefined): string[] {
  const all = new Set<string>(repositoryGuards.map(guard => guard.file));
  const selected = new Set(selectRepositoryGuards(changed).map(guard => guard.file));
  return files.filter(file => !all.has(file) || selected.has(file));
}

export function repositoryGuardSelectionLine(changed: readonly string[], root = process.cwd()): string {
  const present = selectRepositoryGuards(changed).filter(guard => existsSync(resolve(root, guard.file)));
  return `Repository guards: ${present.length}/${repositoryGuards.length} selected for changed paths: ${changed.join(', ') || '(none)'}`;
}

// `task guards`: a worker runs the same rules before it hands off. Prints the failures or one summary line.
if (import.meta.main) {
  const files = repositoryGuards.map((guard) => guard.file).filter((file) => existsSync(file));
  const run = Bun.spawnSync(['bun', 'test', ...files], { stdout: 'pipe', stderr: 'pipe' });
  const lines = `${run.stdout.toString()}${run.stderr.toString()}`.split('\n');
  const summary = lines.filter((line) => /^\s*\d+ (pass|fail)\b|^Ran \d+ tests/.test(line));
  if (run.exitCode === 0)
    console.log(`Repository guards passed: ${summary.join(',').replace(/\s+/g, ' ').trim()}`);
  else
    console.log(
      [
        ...lines.filter((line) => /^\(fail\)|^error:|^\s+error:/.test(line)).slice(0, 60),
        ...lines.slice(-25),
      ].join('\n'),
    );
  process.exit(run.exitCode ?? 1);
}

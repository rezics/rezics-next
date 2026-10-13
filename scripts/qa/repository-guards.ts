import { existsSync, readFileSync } from 'node:fs';
import { dirname, relative, resolve } from 'node:path';

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
    ...new Bun.Glob('tests/qa/integration/outcomes/**/*.{ts,tsx,js,jsx,mts,mjs,cts,cjs}').scanSync({
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

/** Inventory guards read files beyond their import graph, so affected selection
 * cannot establish their coverage. Merge runs these in its existing unit gate.
 * Owner-specific assertions and migration setup for database fixtures stay in
 * their normal affected tiers; these entries enforce an inventory-wide rule. */
export const repositoryGuards = [
  {
    file: 'scripts/api/answer-records.guard.test.ts',
    reason: 'Every outcome answer record must validate against the public contract generated from the tree.',
  },
  {
    file: 'scripts/qa/repository-guards.test.ts',
    reason: 'Outcome tests use the public API without importing product source or mocking modules.',
  },
  {
    file: 'scripts/qa/raw-sparql-integration-files.test.ts',
    reason:
      'No new test file may write raw SPARQL; a new test selects only itself, never this inventory.',
  },
  {
    file: 'packages/observability/tests/http-measurement.test.ts',
    reason:
      'Every counter the native module reports must be on the HTTP measurement allowlist; a Java change does not select this test.',
  },
  {
    file: 'services/account/tests/authentication-subject.test.ts',
    reason:
      'Every Account request cookie parser must use the provider-exact authentication selector.',
  },
  {
    file: 'tests/qa/unit/g-1046-sql-relations.test.ts',
    reason: 'Every SQL source relation must exist in the complete migrated relation inventory.',
  },
  {
    file: 'services/main/tests/platform-exposure.test.ts',
    reason: 'Every installed Main route must declare its platform exposure.',
  },
  {
    file: 'scripts/static/list-convention.test.ts',
    reason: 'Every public OpenAPI list operation must meet the list convention without new debt.',
  },
  {
    file: 'scripts/static/web-continuations.test.ts',
    reason: 'Web list consumers preserve continuations and offer a route beyond capped results.',
  },
  {
    file: 'scripts/static/web-accepted-commands.test.ts',
    reason: 'Web command consumers distinguish accepted pending operations from completed effects.',
  },
  {
    file: 'scripts/static/web-acting-identity.test.ts',
    reason: 'Identity-required web reads carry the selected acting identity.',
  },
  {
    file: 'scripts/static/web-page-filtering.test.ts',
    reason: 'Web consumers do not define result eligibility by filtering only a capped API page.',
  },
  {
    file: 'tests/qa/unit/test-registry.test.ts',
    reason: 'Every tracked Bun test must belong to a QA tier or a reasoned exclusion.',
  },
  {
    file: 'services/main/tests/g-543-rate-limit.test.ts',
    reason: 'Every installed Main route and generated operation must have a rate-limit family.',
  },
  {
    file: 'tests/qa/unit/migration-numbers.test.ts',
    reason: 'Every owner migration directory must number its files uniquely.',
  },
  {
    file: 'scripts/lib/g-940-migration-order.test.ts',
    reason: 'All owner migration inventories must retain numeric order and complete versions.',
  },
  {
    file: 'scripts/qa/schema-order-audit.test.ts',
    reason: 'All migration readers in scripts, services and tests must use numeric ordering.',
  },
  {
    file: 'tests/qa/unit/serialization-points.test.ts',
    reason:
      'All service migrations and write sources must avoid unapproved serialization and gate upgrades.',
  },
  {
    file: 'scripts/static/anti-silo.test.ts',
    reason:
      'All migrations and shared Main/web source trees must stay within the anti-silo baseline.',
  },
  {
    file: 'tests/qa/unit/outbox-event-handlers.test.ts',
    reason: 'Every statically emitted Main outbox event kind must have a relay reader.',
  },
  {
    file: 'services/main/tests/g-896-content-sequence.test.ts',
    reason:
      'All service source files must leave Content event numbering and appends to the sequencer.',
  },
  {
    file: 'services/main/tests/g-829-public-reads.test.ts',
    reason:
      'The complete resource, composition, Collection and lexicon GET inventory must declare disclosure.',
  },
  {
    file: 'services/main/tests/g-656-vertical-facts.test.ts',
    reason: 'The full served Main operation inventory must contain no vertical facts operations.',
  },
  {
    file: 'services/main/tests/api-contract.test.ts',
    reason:
      'Every generated public operation must retain versioned paths and declared success/problem responses.',
  },
  {
    file: 'tests/qa/unit/openapi-tuples.test.ts',
    reason:
      'Every schema in the generated public contract must use JSON Schema 2020-12 tuple keywords.',
  },
  {
    file: 'tests/qa/unit/acceptance.test.ts',
    reason: 'Every acceptance case file must leave the frozen rows and their digest unchanged.',
  },
  {
    file: 'tests/qa/unit/backend-operation-map.test.ts',
    reason:
      'The complete frozen backend case inventory must map existing operations to the public contract.',
  },
  {
    file: 'services/main/tests/g-845-protocol.test.ts',
    reason:
      'Every standalone wiki protocol source must retain licensing and avoid product/runtime dependencies.',
  },
  {
    file: 'packages/wiki-toolkit/tests/package.test.ts',
    reason:
      'Every wiki toolkit source import must stay local or declared and avoid networking/runtime dependencies.',
  },
  {
    file: 'tests/qa/unit/app-error-hook.test.ts',
    reason:
      'Route modules mounted by createMainApp must not declare a local error hook the app hook would hide.',
  },
  {
    file: 'scripts/static/mechanisms.test.ts',
    reason: 'The mechanism map has one owner per concept and resolvable entry points.',
  },
  {
    file: 'scripts/static/mechanism-dependencies.test.ts',
    reason:
      "Code outside a mechanism owner may import only that owner's entry points and named adapter files.",
  },
  {
    file: 'scripts/static/mechanism-writers.test.ts',
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
    reason: 'Every QA docker spawn must keep the reap owner, and the frozen exceptions stay exact.',
  },
  {
    file: 'scripts/static/access-fixture-writes.test.ts',
    reason: 'Every direct write to access fixture tables stays on the frozen debt list.',
  },
  {
    file: 'scripts/qa/hidden-id-equality.test.ts',
    reason:
      'Every id-accepting GET or POST must be registered, exempted, or kept on the frozen hidden-id debt list.',
  },
] as const;

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

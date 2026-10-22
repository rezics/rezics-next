import { repositoryGlob } from '../lib/repository-files.ts';
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { dirname, join, relative, resolve } from 'node:path';
import { availableParallelism, freemem } from 'node:os';
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
    ...repositoryGlob(root, outcomeSourcePattern),
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
const repositoryIndexReads = ['tools/repo-index/**', 'scripts/lib/repo-index*.ts'];

/** Inventory guards read beyond their import graph. Gate selection uses these
 * inventories; main-wide runs retain the complete registry. */
export const repositoryGuards = [
  {
    file: 'apps/web/tests/server-client-boundary.test.ts',
    reads: [
      'apps/web/{app,features,i18n,worker,zones}/**/*.{ts,tsx}', 'packages/ui/src/**/*.{ts,tsx}',
      'apps/web/proxy.ts', 'apps/accounts/features/api/oauth-query.ts', 'generated/openapi/main/exposure.ts',
    ],
    reason: 'Server routes and their server imports may render client components, but cannot invoke client references as ordinary functions.',
  },
  ...[
    'scripts/goal/deployment-canaries.test.ts',
    'scripts/goal/dependencies.test.ts',
    'scripts/qa/retained-preflight.test.ts',
    'scripts/qa/retained-source-inputs.test.ts',
  ].map(file => ({
    file,
    reads: ['scripts/goal/**', 'scripts/qa/**', '.goalctl/**', '**/{yarn.lock,package-lock.json,pnpm-lock.yaml,bun.lock,bun.lockb}',
      'scripts/fixture/{manifest.ts,model.ts,owners/**}', 'scripts/load/{compatibility.ts,work-profile-corpus.ts}',
      'tests/qa/support/{realm-discussion-source*,seed-checkpoints*,seed-specification.ts}',
      'tests/qa/fault-recovery/{*source*,independent-restore-support.ts,owner-restore-erasure-fixture.ts}'],
    reason: 'Tooling deployments preserve older worktrees, installed dependencies, fixture preparation, executable repairs and retained keys.',
  })),
  {
    file: 'scripts/api/response-coverage.guard.test.ts',
    reads: mainContractReads,
    reason: 'Handler status branches and applicable transport-policy outcomes must be declared on every REST operation.',
  },
  {
    file: 'scripts/qa/cases/outcomes.test.ts',
    reads: ['tests/qa/integration/outcomes/**', 'scripts/qa/cases/outcomes/**',
      'scripts/qa/cases/outcomes.ts', 'scripts/qa/cases/outcome-cells.ts',
      'scripts/qa/cases/launch-coverage.ts', 'scripts/qa/isolated-integration-files.ts',
      'tests/qa/support/outcome-test.ts'],
    reason: 'Every declared outcome cell must have its registered proof in the repository tree.',
  },
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
    reads: ['{services,scripts,tests}/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', ...migrationReads, ...repositoryIndexReads, 'tests/qa/unit/g-1046-parent-frame.ts.txt'],
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
    file: 'scripts/lib/dependency-analysis.test.ts',
    reads: ['scripts/**/*.ts'],
    reason: 'Every dependency analysis uses the host-wide admission wrapper and fails closed on a busy lane.',
  },
  {
    file: 'scripts/static/web-continuations.test.ts',
    reads: [webSourcePattern, ...generatedContractReads, 'scripts/static/web-continuations*', 'scripts/static/web-source-scan*', 'scripts/static/ast-grep/rules/no-cursor-arithmetic.yml'],
    reason: 'Web list consumers preserve continuations and offer a route beyond capped results.',
  },
  {
    file: 'scripts/static/web-accepted-commands.test.ts',
    reads: ['apps/web/**/*.{ts,tsx}', 'packages/**', ...generatedContractReads, 'scripts/static/web-accepted-commands*'],
    reason: 'Web command consumers distinguish accepted pending operations from completed effects.',
  },
  {
    file: 'scripts/static/web-acting-identity.test.ts',
    reads: ['apps/web/**/*.{ts,tsx}', ...mainContractReads, ...repositoryIndexReads, 'scripts/static/web-acting-identity*'],
    reason: 'Identity-required web reads carry the selected acting identity.',
  },
  {
    file: 'scripts/static/web-page-filtering.test.ts',
    reads: [webSourcePattern, ...generatedContractReads, 'scripts/static/web-page-filtering*', 'scripts/static/web-continuations*', 'scripts/static/web-source-scan*', 'scripts/static/ast-grep/rules/no-cursor-arithmetic.yml'],
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
    reads: ['services/*/src/**/*.{ts,tsx,js,jsx,mts,cts,mjs,cjs}', 'services/*/migrations/**/*.sql', ...repositoryIndexReads, 'scripts/qa/serialization-points.ts', 'scripts/qa/sql-relations.ts', 'scripts/lib/migration-order.ts'],
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
    reads: ['{services,apps,packages,model,scripts}/**', ...repositoryIndexReads, '.dependency-cruiser.json', 'tsconfig.json'],
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
  if (changed.includes('scripts/qa/repository-guards.ts')
    || changed.includes('scripts/lib/repository-files.ts')) return [...guards];
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

/** A dependency scan and its Bun parent need up to 2 GiB. Keep the same 8 GiB
 * host reserve as QA admission; a constrained host can still run one file. */
export function guardParallelism(files: number, processors: number, availableBytes: number, reserveBytes = 8 * 1024 ** 3): number {
  return files === 0 ? 0 : Math.max(1, Math.min(files, processors,
    Math.floor((availableBytes - reserveBytes) / (2 * 1024 ** 3))));
}

function availableHostMemory(): number {
  if (process.platform === 'linux') {
    const available = /^MemAvailable:\s+(\d+)\s+kB$/m.exec(readFileSync('/proc/meminfo', 'utf8'));
    if (available) return Number(available[1]) * 1024;
  }
  return freemem();
}

export function parseGuardRunArgs(args: readonly string[]): { files: string[]; bunArgs: string[]; report?: string } {
  const files: string[] = [];
  const bunArgs: string[] = [];
  let report: string | undefined;
  const valueOptions = new Set(['--timeout', '--preload', '--test-name-pattern', '-t', '--rerun-each', '--seed']);
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]!;
    if (arg === '--reporter' || arg.startsWith('--reporter=')) {
      const value = arg === '--reporter' ? args[++i] : arg.slice('--reporter='.length);
      if (value !== 'junit') throw new Error('Repository guards support one junit reporter');
    } else if (arg === '--reporter-outfile' || arg.startsWith('--reporter-outfile=')) {
      report = arg === '--reporter-outfile' ? args[++i] : arg.slice('--reporter-outfile='.length);
      if (!report || report.startsWith('--')) throw new Error('--reporter-outfile needs a path');
    } else if (valueOptions.has(arg)) {
      const value = args[++i];
      if (!value || value.startsWith('--')) throw new Error(`${arg} needs a value`);
      bunArgs.push(arg, value);
    } else if (arg.startsWith('-')) bunArgs.push(arg);
    else if (/\.(?:test|spec)\.[cm]?[jt]sx?$/.test(arg)) files.push(arg);
    else throw new Error(`Expected an explicit test file, got ${arg}`);
  }
  return { files: [...new Set(files)], bunArgs, ...(report ? { report } : {}) };
}

function xmlEscape(value: string): string {
  return value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;')
    .replaceAll('"', '&quot;').replaceAll("'", '&apos;');
}

function failedGuardReport(file: string, detail: string): string {
  return `<testsuite name="${xmlEscape(file)}" file="${xmlEscape(file)}" tests="1" failures="1" skipped="0" time="0">`
    + `<testcase name="Guard process did not complete" file="${xmlEscape(file)}" time="0">`
    + `<error message="${xmlEscape(detail)}" /></testcase></testsuite>`;
}

interface GuardFileResult { file: string; code: number; output: string; suites: string }
export interface GuardRunOptions {
  cwd?: string;
  bunArgs?: readonly string[];
  report?: string;
  env?: NodeJS.ProcessEnv;
  parallelism?: number;
}

/** These six files consumed 81% of the measured serial run. Starting them first
 * keeps short inventories from delaying the critical path on a bounded pool. */
const slowGuardFiles = [
  'services/account/tests/authentication-subject.test.ts',
  'scripts/static/mechanism-dependencies.test.ts',
  'tests/qa/unit/serialization-points.test.ts',
  'scripts/static/web-acting-identity.test.ts',
  'services/main/tests/g-543-rate-limit.test.ts',
  'tests/qa/unit/g-1046-sql-relations.test.ts',
];

/** Each file has its own Bun module cache and fixtures. Reading the registered
 * guards and helpers found only mkdtemp/UUID fixture writes, ephemeral ports,
 * and one writer of .temp/web-acting-identity-inventory.json; no guards share
 * mutable state. Contract builds return documents without writing generated files.
 * Inherit admission/reaper ownership: a child must not acquire a second QA slot. */
export async function runRepositoryGuardFiles(input: readonly string[], options: GuardRunOptions = {}): Promise<{
  code: number; summary: string; report: string; parallelism: number;
}> {
  const cwd = options.cwd ?? process.cwd();
  const env = options.env ?? process.env;
  const reserveGiB = Number(env.REZICS_QA_HOST_RESERVE_GIB ?? 8);
  if (!Number.isFinite(reserveGiB) || reserveGiB < 0 || env.REZICS_QA_HOST_RESERVE_GIB?.trim() === '')
    throw new Error('REZICS_QA_HOST_RESERVE_GIB must be a nonnegative number');
  const files = [...new Set(input)];
  const parallelism = options.parallelism ?? guardParallelism(files.length, availableParallelism(), availableHostMemory(), reserveGiB * 1024 ** 3);
  if (!Number.isSafeInteger(parallelism) || parallelism < (files.length ? 1 : 0)) throw new Error('Guard parallelism must be a positive integer');
  const temporaryRoot = join(cwd, '.temp/repository-guards');
  mkdirSync(temporaryRoot, { recursive: true });
  const directory = mkdtempSync(join(temporaryRoot, 'run-'));
  const report = resolve(cwd, options.report ?? join(directory, 'unit.xml'));
  const started = performance.now();
  const queue = [...files].sort((left, right) => {
    const rank = (file: string) => {
      const index = slowGuardFiles.indexOf(relative(cwd, resolve(cwd, file)).replaceAll('\\', '/'));
      return index < 0 ? slowGuardFiles.length : index;
    };
    return rank(left) - rank(right);
  });
  const results = new Map<string, GuardFileResult>();
  const children = new Set<ReturnType<typeof Bun.spawn>>();
  let interrupted = false;
  const stop = () => {
    interrupted = true;
    for (const child of children) child.kill('SIGTERM');
  };
  process.on('SIGINT', stop);
  process.on('SIGTERM', stop);
  async function worker(): Promise<void> {
    while (queue.length && !interrupted) {
      const file = queue.shift()!;
      const index = files.indexOf(file);
      const childReport = join(directory, `${index}.xml`);
      let output = '';
      let suites = '';
      let code = 1;
      try {
        // Stay in the caller's process group so gate cancellation also reaches
        // depcruise and other grandchildren. Options (including preloads) survive.
        const child = Bun.spawn([process.execPath, 'test', ...(options.bunArgs ?? []),
          resolve(cwd, file), '--reporter=junit', `--reporter-outfile=${childReport}`],
        { cwd, env: { ...env, FORCE_COLOR: '0' }, stdout: 'pipe', stderr: 'pipe' });
        children.add(child);
        try {
          const [stdout, stderr, exitCode] = await Promise.all([
            new Response(child.stdout).text(), new Response(child.stderr).text(), child.exited,
          ]);
          output = `${stdout}${stderr}`;
          code = exitCode;
        } finally { children.delete(child); }
        const xml = existsSync(childReport) ? readFileSync(childReport, 'utf8') : '';
        suites = [...xml.matchAll(/<testsuite\b[^>]*>[\s\S]*?<\/testsuite>/g)].map(match => match[0]).join('\n');
        if (!suites || (code !== 0 && !/<(?:failure|error)\b/.test(suites))) {
          output += `\nerror: Guard process exited (${code}) without ${suites ? 'a reported failure' : 'a complete JUnit report'}`;
          code = 1;
          suites += failedGuardReport(file, output.trim());
        }
        // A failure in the report cannot be masked by an incorrect exit code.
        if (/<(?:failure|error)\b/.test(suites)) code = 1;
      } catch (error) {
        output += `\nerror: ${String(error)}`;
        suites = failedGuardReport(file, output.trim());
      } finally { rmSync(childReport, { force: true }); }
      writeFileSync(join(directory, `${index}.log`), output);
      results.set(file, { file, code, output, suites });
    }
  }
  try { await Promise.all(Array.from({ length: Math.min(parallelism, files.length) }, worker)); }
  finally { process.off('SIGINT', stop); process.off('SIGTERM', stop); }
  for (const file of queue) results.set(file, { file, code: 1, output: 'Guard run interrupted',
    suites: failedGuardReport(file, 'Guard run interrupted before this file started') });
  const ordered = files.map(file => results.get(file)!);
  const suites = ordered.map(result => result.suites).join('\n');
  const sum = (name: string) => [...suites.matchAll(new RegExp(`<testsuite\\b[^>]*\\b${name}="(\\d+)"`, 'g'))]
    .reduce((total, match) => total + Number(match[1]), 0);
  mkdirSync(dirname(report), { recursive: true });
  writeFileSync(report, `<?xml version="1.0" encoding="UTF-8"?>\n<testsuites tests="${sum('tests')}" failures="${sum('failures')}" skipped="${sum('skipped')}" time="${(performance.now() - started) / 1000}">\n${suites}\n</testsuites>\n`);
  const failed = ordered.filter(result => result.code !== 0);
  const failures = failed.map(result => `${result.file}:\n${result.output.trim()}`).join('\n\n');
  const summary = `${failures ? `${failures}\n\n` : ''}Repository guards ${failed.length ? 'failed' : 'passed'}: ${files.length} files, ${sum('tests')} tests, ${failed.length} failing files; ${parallelism} parallel processes; JUnit: ${report}`;
  return { code: interrupted || failed.length ? 1 : 0, summary, report, parallelism };
}

if (import.meta.main) {
  try {
    const args = process.argv.slice(2);
    const selected = parseGuardRunArgs(args);
    // Omitted arguments mean the complete registry; explicit runs never widen.
    const files = args.length ? selected.files : repositoryGuards.map(guard => guard.file).filter(file => existsSync(file));
    if (args.length && !files.length) throw new Error('Provide explicit guard test files');
    const result = await runRepositoryGuardFiles(files, { bunArgs: selected.bunArgs, report: selected.report });
    console.log(result.summary);
    process.exit(result.code);
  } catch (error) {
    console.error(`error: ${String(error)}`);
    process.exit(1);
  }
}

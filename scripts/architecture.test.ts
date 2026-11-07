import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  auditArchitecture,
  buildGraph,
  changedGraph,
  formatModuleMap,
  findLoadTimeReads,
  type ArchitectureManifest,
  type BoundaryBaseline,
  loadBaseline,
  loadManifest,
  MAX_MODULE_MAP_CHARACTERS,
  MODULE_MAP_POINTER,
  MODULE_MAP_TRUNCATION,
  validateBaseline,
  writeGraphCache,
} from './architecture';

const temporaryRoots: string[] = [];

function fixtureRoot(): string {
  const temp = join(process.cwd(), '.temp');
  mkdirSync(temp, { recursive: true });
  const root = mkdtempSync(join(temp, 'architecture-test-'));
  temporaryRoots.push(root);
  return root;
}

function put(root: string, path: string, content: string): void {
  const absolute = join(root, path);
  mkdirSync(join(absolute, '..'), { recursive: true });
  writeFileSync(absolute, content);
}

function copySources(root: string, paths: readonly string[]): void {
  for (const path of paths) put(root, path, readFileSync(join(process.cwd(), path), 'utf8'));
}

function baseline(): BoundaryBaseline {
  return { version: 1, modules: {} };
}

function manifest(modules: ArchitectureManifest['modules']): ArchitectureManifest {
  return {
    version: 1,
    sourceRoots: [
      { path: 'src', extensions: ['.ts'] },
      { path: 'packages', extensions: ['.ts'] },
      { path: 'apps', extensions: ['.ts'] },
    ],
    modules,
  };
}

afterEach(() => {
  for (const root of temporaryRoots.splice(0)) rmSync(root, { recursive: true, force: true });
});

describe('architecture boundaries', () => {
  test('reports new cycles, private type imports, effects, unowned files, and package-to-app imports', () => {
    const root = fixtureRoot();
    const current = manifest([
      {
        id: 'main',
        kind: 'application',
        owner: 'platform',
        paths: ['src/main/**'],
        publicEntries: [],
        allowedDependencies: [],
        capabilities: [],
      },
      {
        id: 'peer',
        kind: 'core',
        owner: 'platform',
        paths: ['src/peer/**'],
        publicEntries: ['src/peer/index.ts'],
        allowedDependencies: [],
        capabilities: [],
      },
      {
        id: 'pure',
        kind: 'core',
        owner: 'platform',
        paths: ['src/core/**'],
        publicEntries: [],
        allowedDependencies: [],
        capabilities: [],
      },
      {
        id: 'runtime-adapter',
        kind: 'adapter',
        owner: 'platform',
        paths: ['src/adapter/**'],
        publicEntries: [],
        allowedDependencies: [],
        capabilities: [],
      },
      {
        id: 'package',
        kind: 'core',
        owner: 'platform',
        paths: ['packages/foo/src/**'],
        publicEntries: [],
        allowedDependencies: [],
        capabilities: [],
      },
      {
        id: 'app',
        kind: 'composition root',
        owner: 'web',
        paths: ['apps/web/src/**'],
        publicEntries: [],
        allowedDependencies: [],
        capabilities: [],
      },
    ]);
    put(root, 'src/main/a.ts', 'import type { Private } from "../peer/private"; import "./b";\n');
    put(root, 'src/main/b.ts', 'import "./a";\n');
    put(root, 'src/peer/index.ts', "export type { Public } from './public';\n");
    put(root, 'src/peer/private.ts', 'export interface Private { value: string }\n');
    put(root, 'src/peer/public.ts', 'export interface Public { value: string }\n');
    put(root, 'src/core/pure.ts', 'import type React from "react"; import "../adapter/private";\n');
    put(root, 'src/adapter/private.ts', 'export const native = true;\n');
    put(root, 'src/orphan.ts', 'export const orphan = true;\n');
    put(root, 'packages/foo/src/index.ts', 'import "../../../apps/web/src/main";\n');
    put(root, 'apps/web/src/main.ts', 'export const app = true;\n');

    const result = auditArchitecture(root, current, baseline(), buildGraph(root, current));
    const report = result.errors.join('\n');
    expect(report).toContain('rule 3: src/main/a.ts:');
    expect(report).toContain('value-import cycle');
    expect(report).toContain('rule 2: src/main/a.ts:');
    expect(report).toContain('type import');
    expect(report).toContain('src/peer/private.ts');
    expect(report).toContain('rule 4: src/core/pure.ts:');
    expect(report).toContain('modules pure -> runtime-adapter');
    expect(report).toContain('src/adapter/private.ts');
    expect(report).toContain('rule 1: src/orphan.ts:');
    expect(report).toContain('rule 7: packages/foo/src/index.ts:');
    expect(report).toContain('apps/web/src/main.ts');
  });

  test('reports eager repository reads through aliases, local calls, callbacks and static initialization', () => {
    const root = fixtureRoot();
    const current = manifest([]);
    put(
      root,
      'src/peer.ts',
      'export const value = Object.assign({}, { count: 1 }); export function make() { return value; }',
    );
    put(
      root,
      'src/literals.ts',
      'import type { Value } from "./types"; export const LIMIT = Object.freeze({ count: 4 } as const);',
    );
    put(root, 'src/types.ts', 'export interface Value { count: number }');
    put(
      root,
      'src/main.ts',
      `
      import { value as remote, make } from './peer';
      import * as peer from './peer';
      import { LIMIT } from './literals';
      import type { Value } from './types';
      const literal = LIMIT.count;
      const copied = remote;
      const called = make();
      const namespace = peer.value;
      function local() { return remote.count; }
      const indirect = local();
      const callback = [1].map(() => remote.count);
      const immediate = (() => remote.count)();
      const nested = (() => { function read() { return remote; } return read(); })();
      const nestedArrow = (() => { const read = () => remote; return read(); })();
      const deferred = () => remote.count;
      function later(value = remote) { return value; }
      function shadowed(remote: Value) { return remote.count; }
      const shadow = shadowed({ count: 1 });
      type Schema = typeof remote;
      class Fields { instance = remote; static value = remote; method() { return remote; } }
      class Deferred { instance = remote; method() { return remote; } }
    `,
    );
    const reads = findLoadTimeReads(root, buildGraph(root, current)).filter((read) => read.file === 'src/main.ts');
    expect([...new Set(reads.map((read) => read.initializer))].sort()).toEqual([
      'ClassDeclaration',
      'callback',
      'called',
      'copied',
      'immediate',
      'indirect',
      'namespace',
      'nested',
      'nestedArrow',
    ]);
    expect(reads.every((read) => read.line > 0 && read.column > 0 && read.specifier === './peer')).toBe(true);
  });

  test('enforces Kernel load-time reads and rechecks a changed literal leaf against the full graph', () => {
    const root = fixtureRoot();
    const current: ArchitectureManifest = {
      version: 1,
      sourceRoots: [{ path: 'services/kernel/src', extensions: ['.ts'] }],
      modules: [
        {
          id: 'kernel',
          kind: 'adapter',
          owner: 'platform',
          paths: ['services/kernel/src/**'],
          publicEntries: [],
          allowedDependencies: [],
          capabilities: [],
        },
      ],
    };
    put(root, 'services/kernel/src/leaf.ts', 'export const LIMIT = 4;');
    put(root, 'services/kernel/src/consumer.ts', `import { LIMIT } from './leaf'; export const limit = LIMIT + 1;`);
    const graph = buildGraph(root, current);
    expect(auditArchitecture(root, current, baseline(), graph).violations.filter((v) => v.rule === 'rule 9')).toEqual(
      [],
    );
    writeGraphCache(root, graph);
    put(root, 'services/kernel/src/leaf.ts', 'export const LIMIT = Number("4");');
    const result = auditArchitecture(
      root,
      current,
      baseline(),
      changedGraph(root, current, ['services/kernel/src/leaf.ts']),
    );
    expect(result.errors.join('\n')).toContain(
      'rule 9: services/kernel/src/consumer.ts: load-time initializer limit reads LIMIT',
    );
  });

  test('Kernel production modules have no cross-module load-time evaluation', () => {
    const root = process.cwd();
    const graph = buildGraph(root, loadManifest(root));
    expect(
      findLoadTimeReads(
        root,
        graph,
        Object.keys(graph.hashes)
          .filter((file) => file.startsWith('services/kernel/src/'))
          .sort(),
      ),
    ).toEqual([
      {
        binding: 'CollectionSourceLedger',
        column: 30,
        file: 'services/kernel/src/zones/membership.ts',
        initializer: 'ClassDeclaration',
        line: 90,
        specifier: '../library/collection-source-work.ts',
      },
    ]);
  }, 60_000);

  test('requires an owner and reason on every ratchet group', () => {
    const errors = validateBaseline({
      version: 1,
      modules: {
        core: {
          owner: '',
          reason: '',
          violations: [{ rule: 'rule 2', file: 'src/core.ts', edge: 'type import ./private => src/private.ts' }],
        },
      },
    });
    expect(errors.join('\n')).toContain('rule 8: src/core.ts: type import ./private => src/private.ts');
    expect(errors.join('\n')).toContain('owner and reason');
  });

  test('rechecks changed edges against the complete cached graph', () => {
    const root = fixtureRoot();
    const current = manifest([
      {
        id: 'core',
        kind: 'core',
        owner: 'platform',
        paths: ['src/**'],
        publicEntries: [],
        allowedDependencies: [],
        capabilities: [],
      },
    ]);
    put(root, 'src/a.ts', 'export const a = true;\n');
    put(root, 'src/b.ts', 'export const b = true;\n');
    writeGraphCache(root, buildGraph(root, current));
    put(root, 'src/a.ts', 'import "./b"; export const a = true;\n');
    put(root, 'src/b.ts', 'import "./a"; export const b = true;\n');
    const graph = changedGraph(root, current, ['src/a.ts', 'src/b.ts']);
    const result = auditArchitecture(root, current, baseline(), graph);
    expect(result.errors.join('\n')).toContain('value-import cycle');
  });

  test('check tooling resolves oxc-parser from the canonical root package without NODE_PATH', () => {
    const resolved = createRequire(join(process.cwd(), 'package.json')).resolve('oxc-parser');
    expect(resolved.includes(`${join('node_modules', 'oxc-parser')}`)).toBe(true);
    const architectureSource = readFileSync(join(process.cwd(), 'scripts/architecture.ts'), 'utf8');
    expect(architectureSource).toContain(
      "createRequire(join(dirname(fileURLToPath(import.meta.url)), '..', 'package.json'))",
    );
    expect(architectureSource).not.toContain('NODE_PATH');
    const mapSource = readFileSync(join(process.cwd(), 'scripts/architecture-map.ts'), 'utf8');
    expect(mapSource).not.toMatch(/from ['"]oxc-parser['"]/);
    expect(mapSource).not.toMatch(/require\(['"]oxc-parser['"]\)/);
  });

  test('prints a compact map', () => {
    const current = manifest([
      {
        id: 'core',
        kind: 'core',
        owner: 'platform',
        paths: ['src/**'],
        publicEntries: ['@rezics/core', '@rezics/core/contracts/*'],
        allowedDependencies: [],
        capabilities: [],
      },
    ]);
    const output = formatModuleMap(current);
    expect(output).toContain('core|c|@/core:{.,contracts/*}|-');
    expect(output.length).toBeLessThanOrEqual(2_000);

    const bulky = manifest(
      Array.from({ length: 80 }, (_, index) => ({
        id: `mod${String(index).padStart(3, '0')}`,
        kind: 'core' as const,
        owner: 'platform',
        paths: [`src/m${index}/**`],
        publicEntries: Array.from(
          { length: 12 },
          (_, entry) => `src/m${index}/entry-${entry}-quite-long-public-name.ts`,
        ),
        allowedDependencies: [],
        capabilities: [],
      })),
    );
    const overflowing = formatModuleMap(bulky);
    expect(overflowing.length).toBeLessThanOrEqual(MAX_MODULE_MAP_CHARACTERS);
    expect(overflowing).toContain(MODULE_MAP_TRUNCATION);
    expect(overflowing).toContain('mod000|');
  });

  test('keeps a path-selected module map complete when it fits the worker map budget', () => {
    const committed = loadManifest(process.cwd());
    const selected = formatModuleMap(committed, ['services/kernel/src/search/query.ts']);
    expect(selected).toContain('ksearch|');
    expect(selected).toContain(MODULE_MAP_POINTER);
    expect(selected).not.toContain(MODULE_MAP_TRUNCATION);
    expect(selected).not.toMatch(/^wsearch\|/m);
    expect(selected.length).toBeLessThanOrEqual(MAX_MODULE_MAP_CHARACTERS);
    expect(selected).toMatch(/^ksearch\|d\|/m);

    const overflowing = manifest([
      {
        id: 'owned',
        kind: 'adapter',
        owner: 'platform',
        paths: ['src/owned/**'],
        publicEntries: ['src/owned/index.ts', 'src/owned/public.ts'],
        allowedDependencies: Array.from({ length: 40 }, (_, index) => `dep${String(index).padStart(2, '0')}`),
        capabilities: [],
      },
      ...Array.from({ length: 40 }, (_, index) => ({
        id: `dep${String(index).padStart(2, '0')}`,
        kind: 'core' as const,
        owner: 'platform',
        paths: [`src/d${index}/**`],
        publicEntries: Array.from(
          { length: 16 },
          (_, entry) => `src/d${index}/entry-${entry}-quite-long-public-name.ts`,
        ),
        allowedDependencies: [],
        capabilities: [],
      })),
    ]);
    const overflow = formatModuleMap(overflowing, ['src/owned/index.ts']);
    expect(overflow.length).toBeLessThanOrEqual(MAX_MODULE_MAP_CHARACTERS);
    expect(overflow).toContain('owned|');
    expect(overflow).toContain('src/owned:{index.ts,public.ts}');
    expect(overflow).toContain('dep00,dep01');
    expect(overflow).toContain(MODULE_MAP_POINTER);
    expect(overflow).toContain(MODULE_MAP_TRUNCATION);
  });

  test('registers extracted packages and admitted source edges at public entries', () => {
    const root = process.cwd();
    const committed = loadManifest(root);
    const baseline = loadBaseline(root);
    const sourceGroups = [
      'packages/access/package.json packages/access/src/index.ts packages/bounds/package.json packages/bounds/src/index.ts packages/operations/package.json packages/operations/src/index.ts packages/operations/src/protocol.ts',
      'services/kernel/src/access/gates/admission.ts services/kernel/src/access/gates/catalogue.ts services/kernel/src/access/gates/declaration.ts services/kernel/src/access/gates/management-read.ts services/kernel/src/access/gates/visibility.ts services/kernel/src/access/permission.ts services/kernel/src/access/policy-core.ts services/kernel/src/access/policy-filter.ts services/kernel/src/library/collection-list-policy.ts',
      'services/kernel/src/history/core/operational-work-axes.ts services/kernel/src/history/core/operational-work-budget.ts services/kernel/src/library/collection-source-work-native.ts services/kernel/src/search/scope-members-source-declaration.ts services/kernel/src/work/selected-runtime-cost.ts services/kernel/src/work/selected-runtime.ts',
      'services/kernel/src/http/headers.ts services/kernel/src/http/kernel.ts services/kernel/src/http/operation-adapter.ts services/kernel/src/library/continue-routes.ts services/kernel/src/library/operation-declarations.ts services/kernel/src/library/progress-routes.ts services/kernel/src/content/feed-operation-declarations.ts services/kernel/src/content/feed-routes.ts',
      'services/kernel/src/content/community-projection/index.ts services/kernel/src/content/board-page.ts services/kernel/src/content/conversation-activity.ts services/kernel/src/content/feed-conversation-activity.ts services/kernel/src/content/realm-community.ts services/kernel/src/content/subject-threads-cards.ts',
      'apps/web/src/routes/editions/$id.tsx apps/web/src/routes/search.tsx apps/web/src/checkout/reader-origin.ts apps/web/src/search/search.tsx apps/web/src/kernel/client.ts apps/web/src/inbox/inbox-read.ts apps/web/src/settings/account-rename-actions.ts apps/web/src/settings/actions.server.ts apps/web/src/settings/actions.ts apps/web/src/settings/managed-account-actions-read.ts apps/web/src/settings/managed-account-detail-read.ts apps/web/src/settings/shelf-preferences-current.tsx apps/web/src/settings/verification-actions.ts',
    ];
    copySources(
      root,
      sourceGroups.flatMap((group) => group.split(/\s+/)),
    );
    const graphManifest: ArchitectureManifest = {
      version: 1,
      sourceRoots: [
        'services/kernel/src',
        'apps/web/src',
        'packages/access/src',
        'packages/bounds/src',
        'packages/operations/src',
      ].map((path) => ({ path, extensions: ['.ts', '.tsx'] })),
      modules: [],
    };
    const graph = buildGraph(root, graphManifest);
    const module = (id: string) => committed.modules.find((candidate) => candidate.id === id);
    const split = (value: string) => value.trim().split(/\s+/);
    const expectTargets = (target: string, sources: string) => {
      for (const source of split(sources))
        expect(graph.imports[source]?.some((edge) => edge.targets.includes(target))).toBe(true);
    };
    const expectImports = (specifier: string, target: string, sources: string) => {
      const expected = split(sources).sort();
      const actual = Object.entries(graph.imports)
        .filter(([, edges]) => edges.some((edge) => edge.specifier === specifier))
        .map(([source]) => source)
        .sort();
      expect(actual).toEqual(expected);
      expectTargets(target, sources);
    };

    expect(committed.sourceRoots.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['packages/access/src', 'packages/bounds/src', 'packages/operations/src']),
    );
    for (const [id, config] of Object.entries({
      'access-policy': { kind: 'core', owner: 'accounts', publicEntries: ['@rezics/access'], allowedDependencies: [] },
      bounds: { kind: 'core', owner: 'performance', publicEntries: ['@rezics/bounds'], allowedDependencies: [] },
      operations: {
        kind: 'core',
        owner: 'performance',
        publicEntries: ['@rezics/operations', '@rezics/operations/protocol'],
        allowedDependencies: [],
      },
    }))
      expect(module(id)).toMatchObject(config);
    for (const [id, dependencies] of Object.entries({
      'kernel-access': ['access-policy'],
      'kernel-content': ['operations'],
      'kernel-library': ['access-policy', 'bounds', 'operations'],
      'kernel-platform': ['bounds', 'operations'],
      'kernel-search': ['bounds'],
    }))
      expect(module(id)?.allowedDependencies).toEqual(expect.arrayContaining(dependencies));
    expect(module('kernel-access')?.publicEntries).toContain('services/kernel/src/access/index.ts');
    expect(module('kernel-content-community-projection')?.publicEntries).toContain(
      'services/kernel/src/content/community-projection/index.ts',
    );
    expect(module('web-commerce')?.publicEntries).toContain('apps/web/src/checkout/reader-origin.ts');
    expect(module('web-search')?.publicEntries).toContain('apps/web/src/search/search.tsx');

    expectImports(
      '@rezics/access',
      'packages/access/src/index.ts',
      'services/kernel/src/access/gates/admission.ts services/kernel/src/access/gates/catalogue.ts services/kernel/src/access/gates/declaration.ts services/kernel/src/access/gates/management-read.ts services/kernel/src/access/gates/visibility.ts services/kernel/src/access/permission.ts services/kernel/src/access/policy-core.ts services/kernel/src/access/policy-filter.ts services/kernel/src/library/collection-list-policy.ts',
    );
    expectImports(
      '@rezics/bounds',
      'packages/bounds/src/index.ts',
      'services/kernel/src/history/core/operational-work-axes.ts services/kernel/src/history/core/operational-work-budget.ts services/kernel/src/library/canonical-source-bounds.ts services/kernel/src/library/label-command-admission.ts services/kernel/src/library/collection-directory-bounds.ts services/kernel/src/library/collection-history-bounds.ts services/kernel/src/library/collection-kind-input-bounds.ts services/kernel/src/library/collection-order-bounds.ts services/kernel/src/library/collection-publication-bounds.ts services/kernel/src/library/collection-retention-bounds.ts services/kernel/src/library/collection-rule-edit-bounds.ts services/kernel/src/library/collection-rule-read-bounds.ts services/kernel/src/library/collection-selected-publication-bounds.ts services/kernel/src/library/collection-source-native.ts services/kernel/src/library/collection-source-work-native.ts services/kernel/src/library/command-support.ts services/kernel/src/library/copy-operation-bounds.ts services/kernel/src/library/core/identity-bounds.ts services/kernel/src/library/core/page-plan.ts services/kernel/src/library/entry-operation-bounds.ts services/kernel/src/library/follow-operation-bounds.ts services/kernel/src/library/identity-native-bounds.ts services/kernel/src/library/identity-original-work.ts services/kernel/src/library/label-operation-bounds.ts services/kernel/src/library/loan-operation-bounds.ts services/kernel/src/library/members-preparation-budget.ts services/kernel/src/library/native-public-output-bounds.ts services/kernel/src/library/native-source-custody-bounds.ts services/kernel/src/library/pin-operation-bounds.ts services/kernel/src/library/published-log-bounds.ts services/kernel/src/library/published-log-native.ts services/kernel/src/library/session-operation-bounds.ts services/kernel/src/library/shelf-maintenance-bounds.ts services/kernel/src/library/subject-collection-read-bounds.ts services/kernel/src/search/scope-members-source-declaration.ts services/kernel/src/search/service-scope-order.ts services/kernel/src/semantic/public-filter-collection-reduction-work.ts services/kernel/src/work/adapters/native.ts services/kernel/src/work/core/selected-cost.ts',
    );
    expectImports(
      '@rezics/operations',
      'packages/operations/src/index.ts',
      'services/kernel/src/content/feed-operation-declarations.ts services/kernel/src/content/feed-routes.ts services/kernel/src/http/kernel.ts services/kernel/src/http/operation-adapter.ts services/kernel/src/library/continue-routes.ts services/kernel/src/library/operation-declarations.ts services/kernel/src/library/progress-routes.ts',
    );
    expectImports(
      '@rezics/operations/protocol',
      'packages/operations/src/protocol.ts',
      'services/kernel/src/http/headers.ts',
    );

    expectTargets(
      'services/kernel/src/content/community-projection/index.ts',
      'services/kernel/src/content/board-page.ts services/kernel/src/content/conversation-activity.ts services/kernel/src/content/feed-conversation-activity.ts services/kernel/src/content/realm-community.ts services/kernel/src/content/subject-threads-cards.ts',
    );
    expectTargets('apps/web/src/checkout/reader-origin.ts', 'apps/web/src/routes/editions/$id.tsx');
    expectTargets('apps/web/src/search/search.tsx', 'apps/web/src/routes/search.tsx');

    const performanceSources = split(
      'apps/web/src/inbox/inbox-read.ts apps/web/src/settings/account-rename-actions.ts apps/web/src/settings/actions.server.ts apps/web/src/settings/actions.ts apps/web/src/settings/managed-account-actions-read.ts apps/web/src/settings/managed-account-detail-read.ts apps/web/src/settings/shelf-preferences-current.tsx apps/web/src/settings/verification-actions.ts',
    );
    expectTargets('apps/web/src/kernel/client.ts', performanceSources.join(' '));
    for (const source of performanceSources)
      expect(
        baseline.modules['web-performance']?.violations.some(
          (violation) =>
            violation.rule === 'rule 2' &&
            violation.file === source &&
            violation.edge.includes('apps/web/src/kernel/client.ts'),
        ),
      ).toBe(false);

    const removedCycles = [
      [
        'kernel-library',
        'services/kernel/src/library/builtin-runtime.ts',
        '../semantic/identity-adapters/identity-epoch-read.ts',
      ],
      [
        'kernel-library',
        'services/kernel/src/library/collection-list-facts.ts',
        '../semantic/identity-adapters/identity-epoch-read.ts',
      ],
      ['kernel-library', 'services/kernel/src/library/collection-source-work-native.ts', './collection-source-work.ts'],
      ['kernel-library', 'services/kernel/src/library/members-preparation.ts', '../history/operational-work-budget.ts'],
      [
        'kernel-library',
        'services/kernel/src/library/viewer-facts.ts',
        '../semantic/identity-adapters/identity-epoch-read.ts',
      ],
      ['kernel-platform', 'services/kernel/src/command/operational.ts', '../history/operational-work-budget.ts'],
      ['kernel-platform', 'services/kernel/src/command/operational.ts', '../history/operational-work.ts'],
      ['kernel-platform', 'services/kernel/src/command/operational.ts', '../work/selected-runtime.ts'],
      [
        'kernel-search',
        'services/kernel/src/search/account-context-native.ts',
        '../semantic/identity-adapters/identity-epoch-read.ts',
      ],
    ] as const;
    for (const [moduleId, file, specifier] of removedCycles) {
      const isRemovedCycle = (violation: { rule: string; file: string; edge: string }) =>
        violation.rule === 'rule 3' &&
        violation.file === file &&
        violation.edge.includes(JSON.stringify(specifier) + ' #1 =>') &&
        violation.edge.endsWith('(value-import cycle)');
      expect(baseline.modules[moduleId]?.violations.some(isRemovedCycle)).toBe(false);
    }
  }, 15_000);
});

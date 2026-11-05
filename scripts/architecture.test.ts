import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, describe, expect, test } from 'bun:test';
import {
  auditArchitecture,
  buildGraph,
  changedGraph,
  formatModuleMap,
  type ArchitectureManifest,
  type BoundaryBaseline,
  loadBaseline,
  loadManifest,
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
    expect(output).toContain('core|c|l|');
    expect(output.length).toBeLessThanOrEqual(2_000);
  });

  test('keeps the committed module map within the worker prompt limit', () => {
    const committed = loadManifest(process.cwd());
    expect(formatModuleMap(committed).length).toBeLessThanOrEqual(2_000);
  });

  test('registers extracted packages and admitted source edges at public entries', () => {
    const root = process.cwd();
    const committed = loadManifest(root);
    const baseline = loadBaseline(root);
    const sourceGroups = [
      'packages/access/package.json packages/access/src/index.ts packages/bounds/package.json packages/bounds/src/index.ts packages/operations/package.json packages/operations/src/index.ts packages/operations/src/protocol.ts',
      'services/kernel/src/access/gates/admission.ts services/kernel/src/access/gates/catalogue.ts services/kernel/src/access/gates/declaration.ts services/kernel/src/access/gates/management-read.ts services/kernel/src/access/gates/visibility.ts services/kernel/src/access/permission.ts services/kernel/src/access/policy-core.ts services/kernel/src/access/policy-filter.ts services/kernel/src/library/collection-list-policy.ts',
      'services/kernel/src/history/operational-work-axes.ts services/kernel/src/history/operational-work-budget.ts services/kernel/src/library/collection-source-work-native.ts services/kernel/src/search/scope-members-source-declaration.ts services/kernel/src/work/selected-runtime-cost.ts services/kernel/src/work/selected-runtime.ts',
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
      'services/kernel/src/history/operational-work-axes.ts services/kernel/src/history/operational-work-budget.ts services/kernel/src/library/collection-source-work-native.ts services/kernel/src/search/scope-members-source-declaration.ts services/kernel/src/work/selected-runtime-cost.ts services/kernel/src/work/selected-runtime.ts',
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

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
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
    put(root, 'src/core/pure.ts', 'import type React from "react";\n');
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
    expect(output).toContain('core|core|platform|');
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
    const graph = buildGraph(root, committed);
    const audit = auditArchitecture(root, committed, baseline, graph);
    const module = (id: string) => committed.modules.find((candidate) => candidate.id === id);
    const hasTarget = (source: string, target: string) =>
      graph.imports[source]?.some((edge) => edge.targets.includes(target)) ?? false;
    const consumerSources = (specifier: string) =>
      Object.entries(graph.imports)
        .filter(([, edges]) => edges.some((edge) => edge.specifier === specifier))
        .map(([source]) => source)
        .sort();
    const expectConsumers = (specifier: string, target: string, sources: readonly string[]) => {
      expect(consumerSources(specifier)).toEqual([...sources].sort());
      for (const source of sources) expect(hasTarget(source, target)).toBe(true);
    };

    expect(committed.sourceRoots.map(({ path }) => path)).toEqual(
      expect.arrayContaining(['packages/access/src', 'packages/bounds/src', 'packages/operations/src']),
    );
    expect(module('access-policy')?.publicEntries).toEqual(['@rezics/access']);
    expect(module('bounds')?.publicEntries).toEqual(['@rezics/bounds']);
    expect(module('operations')?.publicEntries).toEqual(['@rezics/operations', '@rezics/operations/protocol']);
    expect(module('access-policy')?.allowedDependencies).toEqual([]);
    expect(module('bounds')?.allowedDependencies).toEqual([]);
    expect(module('operations')?.allowedDependencies).toEqual([]);
    expect(module('kernel-access')?.publicEntries).toContain('services/kernel/src/access/index.ts');
    expect(module('kernel-content-community-projection')?.publicEntries).toContain(
      'services/kernel/src/content/community-projection/index.ts',
    );
    expect(module('kernel-access')?.allowedDependencies).toContain('access-policy');
    expect(module('kernel-library')?.allowedDependencies).toEqual(
      expect.arrayContaining(['access-policy', 'bounds', 'operations']),
    );
    expect(module('kernel-platform')?.allowedDependencies).toEqual(expect.arrayContaining(['bounds', 'operations']));
    expect(module('kernel-search')?.allowedDependencies).toContain('bounds');
    expect(module('kernel-content')?.allowedDependencies).toContain('operations');

    expectConsumers('@rezics/access', 'packages/access/src/index.ts', [
      'services/kernel/src/access/gates/admission.ts',
      'services/kernel/src/access/gates/catalogue.ts',
      'services/kernel/src/access/gates/declaration.ts',
      'services/kernel/src/access/gates/management-read.ts',
      'services/kernel/src/access/gates/visibility.ts',
      'services/kernel/src/access/permission.ts',
      'services/kernel/src/access/policy-core.ts',
      'services/kernel/src/access/policy-filter.ts',
      'services/kernel/src/library/collection-list-policy.ts',
    ]);
    expectConsumers('@rezics/bounds', 'packages/bounds/src/index.ts', [
      'services/kernel/src/history/operational-work-axes.ts',
      'services/kernel/src/history/operational-work-budget.ts',
      'services/kernel/src/library/collection-source-work-native.ts',
      'services/kernel/src/search/scope-members-source-declaration.ts',
      'services/kernel/src/work/selected-runtime-cost.ts',
      'services/kernel/src/work/selected-runtime.ts',
    ]);
    expectConsumers('@rezics/operations', 'packages/operations/src/index.ts', [
      'services/kernel/src/content/feed-operation-declarations.ts',
      'services/kernel/src/content/feed-routes.ts',
      'services/kernel/src/http/kernel.ts',
      'services/kernel/src/http/operation-adapter.ts',
      'services/kernel/src/library/continue-routes.ts',
      'services/kernel/src/library/operation-declarations.ts',
      'services/kernel/src/library/progress-routes.ts',
    ]);
    expectConsumers('@rezics/operations/protocol', 'packages/operations/src/protocol.ts', [
      'services/kernel/src/http/headers.ts',
    ]);

    for (const source of [
      'services/kernel/src/content/board-page.ts',
      'services/kernel/src/content/conversation-activity.ts',
      'services/kernel/src/content/feed-conversation-activity.ts',
      'services/kernel/src/content/realm-community.ts',
      'services/kernel/src/content/subject-threads-cards.ts',
    ]) {
      expect(hasTarget(source, 'services/kernel/src/content/community-projection/index.ts')).toBe(true);
    }
    expect(hasTarget('apps/web/src/routes/editions/$id.tsx', 'apps/web/src/checkout/reader-origin.ts')).toBe(true);
    expect(hasTarget('apps/web/src/routes/search.tsx', 'apps/web/src/search/search.tsx')).toBe(true);

    const publicClientSources = [
      'apps/web/src/inbox/inbox-read.ts',
      'apps/web/src/settings/account-rename-actions.ts',
      'apps/web/src/settings/actions.server.ts',
      'apps/web/src/settings/actions.ts',
      'apps/web/src/settings/managed-account-actions-read.ts',
      'apps/web/src/settings/managed-account-detail-read.ts',
      'apps/web/src/settings/shelf-preferences-current.tsx',
      'apps/web/src/settings/verification-actions.ts',
    ];
    for (const source of publicClientSources) {
      expect(hasTarget(source, 'apps/web/src/kernel/client.ts')).toBe(true);
      expect(
        baseline.modules['web-performance']?.violations.some(
          (violation) =>
            violation.rule === 'rule 2' &&
            violation.file === source &&
            violation.edge.includes('apps/web/src/kernel/client.ts'),
        ),
      ).toBe(false);
    }

    const removedCycles = [
      ['kernel-library', 'services/kernel/src/library/builtin-runtime.ts', 'value import "../semantic/identity-adapters/identity-epoch-read.ts" #1 => services/kernel/src/semantic/identity-adapters/identity-epoch-read.ts (value-import cycle)'],
      ['kernel-library', 'services/kernel/src/library/collection-list-facts.ts', 'value import "../semantic/identity-adapters/identity-epoch-read.ts" #1 => services/kernel/src/semantic/identity-adapters/identity-epoch-read.ts (value-import cycle)'],
      ['kernel-library', 'services/kernel/src/library/collection-source-work-native.ts', 'value import "./collection-source-work.ts" #1 => services/kernel/src/library/collection-source-work.ts (value-import cycle)'],
      ['kernel-library', 'services/kernel/src/library/members-preparation.ts', 'value import "../history/operational-work-budget.ts" #1 => services/kernel/src/history/operational-work-budget.ts (value-import cycle)'],
      ['kernel-library', 'services/kernel/src/library/viewer-facts.ts', 'value import "../semantic/identity-adapters/identity-epoch-read.ts" #1 => services/kernel/src/semantic/identity-adapters/identity-epoch-read.ts (value-import cycle)'],
      ['kernel-platform', 'services/kernel/src/command/operational.ts', 'value import "../history/operational-work-budget.ts" #1 => services/kernel/src/history/operational-work-budget.ts (value-import cycle)'],
      ['kernel-platform', 'services/kernel/src/command/operational.ts', 'value import "../history/operational-work.ts" #1 => services/kernel/src/history/operational-work.ts (value-import cycle)'],
      ['kernel-platform', 'services/kernel/src/command/operational.ts', 'value import "../work/selected-runtime.ts" #1 => services/kernel/src/work/selected-runtime.ts (value-import cycle)'],
      ['kernel-search', 'services/kernel/src/search/account-context-native.ts', 'value import "../semantic/identity-adapters/identity-epoch-read.ts" #1 => services/kernel/src/semantic/identity-adapters/identity-epoch-read.ts (value-import cycle)'],
    ] as const;
    for (const [moduleId, file, edge] of removedCycles) {
      expect(baseline.modules[moduleId]?.violations).not.toContainEqual({ rule: 'rule 3', file, edge });
      expect(audit.violations).not.toContainEqual({ rule: 'rule 3', file, edge });
    }

    expect(
      audit.violations.filter(
        (violation) =>
          ['rule 2', 'rule 3'].includes(violation.rule) &&
          ['packages/access/src/index.ts', 'packages/bounds/src/index.ts', 'packages/operations/src/index.ts', 'packages/operations/src/protocol.ts', 'services/kernel/src/content/community-projection/index.ts', 'apps/web/src/kernel/client.ts', 'apps/web/src/checkout/reader-origin.ts', 'apps/web/src/search/search.tsx'].some((target) => violation.edge.includes(target)),
      ),
    ).toEqual([]);
  });

  test('reports both modules and the offending edge for a reverse private import', () => {
    const root = fixtureRoot();
    const current: ArchitectureManifest = {
      ...manifest([
        {
          id: 'access-policy',
          kind: 'core',
          owner: 'accounts',
          paths: ['packages/access/src/**'],
          publicEntries: ['@rezics/access'],
          allowedDependencies: [],
          capabilities: ['permission-policy'],
        },
        {
          id: 'kernel-work',
          kind: 'adapter',
          owner: 'platform',
          paths: ['services/kernel/src/work/**'],
          publicEntries: [],
          allowedDependencies: [],
          capabilities: [],
        },
      ]),
      sourceRoots: [
        { path: 'packages', extensions: ['.ts'] },
        { path: 'services', extensions: ['.ts'] },
      ],
    };
    put(root, 'packages/access/src/index.ts', 'import "../../../services/kernel/src/work/private.ts";\n');
    put(root, 'services/kernel/src/work/private.ts', 'export const nativeWork = true;\n');

    const result = auditArchitecture(root, current, baseline(), buildGraph(root, current));
    const report = result.errors.join('\n');
    expect(report).toContain('packages/access/src/index.ts');
    expect(report).toContain('services/kernel/src/work/private.ts');
    expect(report).toContain('modules access-policy -> kernel-work');
  });
});

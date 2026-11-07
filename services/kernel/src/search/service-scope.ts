import { SearchOperationError } from './operation-outcomes.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { createSearchScopeSource } from './scope-source.ts';
import type { SearchServiceContract } from './service-contract.ts';
import type { RealmSubjectSource } from '../content/index.ts';
import type { SearchLibraryScopePort } from './library-scope-port.ts';

export type SearchService = SearchServiceContract;
export type ScopeRuntime = Omit<Parameters<typeof createSearchScopeSource>[0], 'evidence'> & {
  realmSubjectsForReader?: (reader: LeafOptions) => RealmSubjectSource | undefined;
  library?: SearchLibraryScopePort;
};

const runtimes = new WeakMap<SearchService, ScopeRuntime>();

/**
 * INTERNAL constructor handoff. Only createSearchService in search/service.ts may call this,
 * with its resolved pool, client, prefix, source and release reader. Never register an injected
 * service, clone or mock, and never expose this runtime to a scope consumer.
 * Registration records ownership; it asserts no canonical, source or evidence capability.
 */
export function registerSearchScopeRuntime(service: SearchService, runtime: ScopeRuntime): void {
  if (runtimes.has(service)) throw new TypeError('Search service scope runtime is already registered');
  runtimes.set(service, runtime);
}

/**
 * Reuse the constructor's runtime and the caller's actual reader context. Runtime ownership
 * permits admission, not native readiness; the Source owns capability checks during preparation.
 * The same runtime carries Content's RealmSubjectSource or its disclosure/maintenance
 * composition. Realm preparation, finite prefix capture, predicate refinement and final
 * page revalidation use that installed source with these exact reader options. Absent live
 * maintenance remains unavailable; population_ready is preparation input, never a page.
 */
export function createSearchScopeForService(
  service: SearchService,
  options: LeafOptions,
): ReturnType<typeof createSearchScopeSource> {
  const runtime = runtimes.get(service);
  if (!runtime) throw new SearchOperationError('index_not_ready');
  const { realmSubjects: installedSubjects, realmSubjectsForReader, ...scopeRuntime } = runtime;
  const realmSubjects = realmSubjectsForReader ? realmSubjectsForReader(options) : installedSubjects;
  return createSearchScopeSource({
    ...scopeRuntime,
    ...(realmSubjects ? { realmSubjects } : {}),
    evidence: options,
    ...(runtime.library ? { library: runtime.library } : {}),
  });
}

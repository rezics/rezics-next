import { ProblemError } from '../http/problem.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { createSearchScopeSource } from './scope-source.ts';
import type { createSearchService } from './service.ts';

export type SearchService = ReturnType<typeof createSearchService>;
export type ScopeRuntime = Omit<Parameters<typeof createSearchScopeSource>[0], 'evidence'>;

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
  if (!runtime) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  return createSearchScopeSource({ ...runtime, evidence: options });
}

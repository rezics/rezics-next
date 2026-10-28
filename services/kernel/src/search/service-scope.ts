import { ProblemError } from '../http/problem.ts';
import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import type { createSearchScopeSource } from './scope-source.ts';
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
 * Service-bound scope contract. Constructor wiring and native execution follow separately.
 * The eventual handoff passes options unchanged as evidence to createSearchScopeSource using
 * the registered runtime; it must not create another client or reconstruct Actor or native time.
 */
export function createSearchScopeForService(
  service: SearchService,
  _options: LeafOptions,
): ReturnType<typeof createSearchScopeSource> {
  if (!runtimes.has(service)) throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
  // Owning a runtime is not proof that native canonical preparation is implemented.
  throw new ProblemError('index_not_ready', { headers: { 'retry-after': '1' } });
}

import type { LeafOptions } from '../semantic/scope-leaf-evidence.ts';
import { createSearchScopeSource } from './scope-source.ts';
import type { createSearchService } from './service.ts';
export type SearchService = ReturnType<typeof createSearchService>;
export type ScopeRuntime = Omit<Parameters<typeof createSearchScopeSource>[0], 'evidence'>;
/**
 * INTERNAL constructor handoff. Only createSearchService in search/service.ts may call this,
 * with its resolved pool, client, prefix, source and release reader. Never register an injected
 * service, clone or mock, and never expose this runtime to a scope consumer.
 * Registration records ownership; it asserts no canonical, source or evidence capability.
 */
export declare function registerSearchScopeRuntime(service: SearchService, runtime: ScopeRuntime): void;
/**
 * Reuse the constructor's runtime and the caller's actual reader context. Runtime ownership
 * permits admission, not native readiness; the Source owns capability checks during preparation.
 * The same runtime carries the optional Content RealmSubjectSource; absent native enumeration
 * remains unavailable through the Realm scope seam, never an empty population.
 */
export declare function createSearchScopeForService(service: SearchService, options: LeafOptions): ReturnType<typeof createSearchScopeSource>;

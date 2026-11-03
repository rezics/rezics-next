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
 * The same runtime carries Content's RealmSubjectSource or its disclosure/maintenance
 * composition. realm.prepare, realm.sourcePrefix and realm.evaluate use that installed
 * source with these exact reader options. Absent live maintenance remains unavailable;
 * population_ready is preparation input, never a useful canonical Search page.
 */
export declare function createSearchScopeForService(service: SearchService, options: LeafOptions): ReturnType<typeof createSearchScopeSource>;

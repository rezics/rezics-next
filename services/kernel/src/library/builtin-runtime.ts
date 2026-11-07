import type { Access } from '../request/access.ts';
import type { KeyRing } from '../tokens/seal.ts';
import type { Pool } from 'pg';
import type { OwnerQueryDependencies } from './builtin-runtime-query.ts';
import { requireLibraryPresentation } from './domain-binding.ts';
export type { BuiltinCollectionView, DynamicMemberView } from './adapters/builtin-runtime.ts';

/** The ordinary composition owns all built-in construction and current producer bindings. */
export function createBuiltinRuntime(
  config: Omit<OwnerQueryDependencies, 'access'> & { access?: Access; tokens?: KeyRing },
) {
  return requireLibraryPresentation().builtins(config);
}

/** Retained participant input: one native prefix and the producer's exact batched mappings. */
export function readBuiltinOriginalInputs(pool: Pool, accountId: string, after: string | null, limit: number) {
  return requireLibraryPresentation().builtinOriginalInputs(pool, accountId, after, limit);
}

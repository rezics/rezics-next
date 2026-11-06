import type { Pool } from 'pg';
import { tupleRoute } from '../../content/imported-contract.ts';
import { resolvedSemanticDomain } from './registry.ts';

/** Imported-tuple home selection without loading cover media. */
export function importedTupleRouteOf(pool?: Pool) {
  return resolvedSemanticDomain(pool)?.ports.contentLifecycle.importedTupleRoute ?? tupleRoute;
}

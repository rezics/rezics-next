import type { Pool } from 'pg';
import type { IdentityScopedObservations, IdentityScopeFailure } from './identity-scope-types.ts';

/** Provisional exact Semantic factory; the native producer replaces this adapter on integration. */
export function createIdentityScopedObservations(_pool: Pool): IdentityScopedObservations {
  const unavailable = async (): Promise<IdentityScopeFailure> => ({
    status: 'unavailable',
    reason: 'source_unready',
    work: { rows: 0, points: 0, statements: 0, bytes: 0 },
  });
  return {
    register: unavailable,
    arm: unavailable,
    finish: unavailable,
    revalidate: unavailable,
    repair: unavailable,
    retire: unavailable,
  };
}

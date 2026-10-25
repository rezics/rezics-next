import type { Pool } from 'pg';
import type { GLOBAL_CONTEXT } from '../semantic/definitions.ts';

export const PLATFORM_GOVERNANCE_ROLE = 'platform.governance';
// Bind the existing Global identity without loading Semantic's runtime command dependencies.
export const PLATFORM_RESOURCE = Object.freeze({
  route: 0,
  id: '00000000-0000-8000-8000-000000000000' satisfies typeof GLOBAL_CONTEXT,
} as const);

export class BootstrapGovernanceUnavailableError extends Error {
  constructor() {
    super('Operator governance bootstrap is unavailable');
    this.name = 'BootstrapGovernanceUnavailableError';
  }
}

export type BootstrapGovernanceResult = {
  accountId: string;
  role: typeof PLATFORM_GOVERNANCE_ROLE;
  resource: typeof PLATFORM_RESOURCE;
  replayed: boolean;
};

/** Operator-only contract. Until native implementation, performs no I/O or grants. */
export async function bootstrapGovernance(_pool: Pool, _accountId: string): Promise<BootstrapGovernanceResult> {
  throw new BootstrapGovernanceUnavailableError();
}

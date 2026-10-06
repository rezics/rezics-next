// Typed outcomes shared by the policy, interaction and revocation operations.
export class PolicyInvalid extends Error {}
export class PolicyDenied extends Error {}
export class PolicyNotFound extends Error {}
export class PolicyStale extends Error {}
export class PolicyConflict extends Error {}
/** A removal that would leave a resource with no controller. Distinct from an idempotency clash. */
export class PolicyControllerContinuity extends Error {}
export class PolicyUnavailable extends Error {}
/** One generic answer for every unusable set reference, so it is no roster oracle. */
export class PolicyReferenceNotAdmitted extends Error {}
export class ProofHandleStale extends Error {}
export class ProofHandleMismatch extends Error {}

export const uuidPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export const agentPattern = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;
export const generationPattern = /^(0|[1-9][0-9]{0,18})$/;

/** PostgreSQL lock, serialization and timeout failures are unavailable, never denial. */
export function normalizePolicyError(error: unknown): Error {
  if (error && typeof error === 'object' && 'code' in error) {
    const code = String(error.code);
    if (code === '23505') return new PolicyConflict('Access identifier already exists');
    if (['40001', '40P01', '55P03', '57014'].includes(code)) {
      return new PolicyUnavailable('Access owner could not complete');
    }
  }
  return error instanceof Error ? error : new Error(String(error));
}

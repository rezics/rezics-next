import { securityResponseLimits as limits } from '@rezics/auth-contract';

/** Canonical projections at the historical/imported record boundary. No raw row spread. */
export function securityId(value: unknown): string {
  if (typeof value !== 'string' || !value || value.length > limits.id) throw new Error('Invalid Security identifier');
  return value;
}
export function securityDisplay(value: unknown, limit: number): string | null {
  return typeof value === 'string' && value.length <= limit ? value : null;
}
export function securityDate(value: unknown): string {
  if (!(value instanceof Date) && typeof value !== 'string') throw new Error('Invalid Security date');
  const date = value instanceof Date ? value : new Date(value);
  return date.toISOString();
}
export function securityPasskey(row: Record<string, unknown>) {
  return {
    id: securityId(row.id),
    name: securityDisplay(row.name, limits.passkeyName) ?? '',
    created_at: securityDate(row.created_at),
    last_used_at: row.last_used_at === null ? null : securityDate(row.last_used_at),
  };
}
/** Scope authority from stored records is refused, never clipped to fit a budget. */
export function securityScopes(value: unknown, limit: number): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= limit &&
    value.every(
      (scope) => typeof scope === 'string' && scope.length <= limits.scope && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    )
  );
}

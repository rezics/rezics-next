import { MAX_CONSENTED_SCOPES } from '@rezics/auth-contract';
import type { Pool } from 'pg';

export type CurrentConsent = Readonly<{
  actorAccountId: string;
  clientId: string;
  scopes: readonly string[];
}>;

export function validConsentId(value: unknown): value is string {
  return typeof value === 'string' && /^[\x21-\x7e]{1,1024}$/.test(value);
}
export function validConsentInput(value: unknown): value is { actorAccountId: string; clientId: string } {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  return (
    Object.keys(record).length === 2 &&
    Object.hasOwn(record, 'actorAccountId') &&
    Object.hasOwn(record, 'clientId') &&
    validConsentId(record.actorAccountId) &&
    validConsentId(record.clientId)
  );
}
export function validConsentScopes(value: unknown): value is string[] {
  return (
    Array.isArray(value) &&
    value.length <= MAX_CONSENTED_SCOPES &&
    value.every(
      (scope) => typeof scope === 'string' && scope.length <= 128 && /^[\x21\x23-\x5b\x5d-\x7e]+$/.test(scope),
    )
  );
}

/** Auth-only current fact, in one statement snapshot. First-party authority must
 * already be materialized by the native issuer; reading never refreshes it.
 * No Access epoch or caller timestamp can revive a missing/reduced consent.
 */
export function createCurrentConsentReader({ database }: { database: Pool }): {
  readCurrentConsent(input: { actorAccountId: string; clientId: string }): Promise<CurrentConsent | null>;
} {
  return {
    async readCurrentConsent(input) {
      if (!validConsentInput(input)) return null;
      const { actorAccountId, clientId } = input;
      const result = await database.query<{ consent: unknown; ceiling: unknown; pending: unknown }>(
        `SELECT c.scopes AS consent, a.scopes AS ceiling, c.pending_scopes AS pending
         FROM auth_consent c JOIN auth_client a ON a.client_id=c.client_id
         JOIN auth_client_coverage v ON v.client_id=a.client_id AND v.ready
         WHERE c.account_id=$1 AND c.client_id=$2
           AND NOT EXISTS (SELECT 1 FROM auth_client_reduction r WHERE r.client_id=$2)`,
        [actorAccountId, clientId],
      );
      const row = result.rows[0];
      if (
        !row ||
        !validConsentScopes(row.consent) ||
        !validConsentScopes(row.ceiling) ||
        (row.pending !== null && !validConsentScopes(row.pending))
      )
        return null;
      const ceiling = new Set(row.ceiling);
      // This durable ceiling belongs to the selected consent, independently of
      // proof expiry/collection and acknowledgement of the Access floor.
      const pending = row.pending === null ? null : new Set(row.pending);
      return {
        actorAccountId,
        clientId,
        scopes: [
          ...new Set(row.consent.filter((scope) => ceiling.has(scope) && (!pending || pending.has(scope)))),
        ].sort(),
      };
    },
  };
}

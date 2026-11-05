import type {
  ProvisioningReceiptMetadata,
  ProvisioningEvidenceLocator,
  ProvisioningEvidenceReference,
  ProvisioningEvidence,
} from '@rezics/auth-contract';
export type {
  ProvisioningReceiptMetadata,
  ProvisioningAuthorization,
  ProvisioningEvidenceLocator,
  ProvisioningEvidenceReference,
  ProvisioningEvidence,
  ProvisioningResult,
} from '@rezics/auth-contract';
import type { Pool } from 'pg';

const bounded = (value: unknown): value is string =>
  typeof value === 'string' && value.length > 0 && value.length <= 1024 && !value.includes('\0');
export function validProvisioningReceipt(value: ProvisioningReceiptMetadata): boolean {
  return (
    !!value &&
    bounded(value.registrationId) &&
    bounded(value.reservationId) &&
    Number.isSafeInteger(value.authnEpoch) &&
    value.authnEpoch > 0 &&
    typeof value.expiresAt === 'string' &&
    value.expiresAt.length === 24 &&
    Number.isFinite(Date.parse(value.expiresAt)) &&
    new Date(value.expiresAt).toISOString() === value.expiresAt
  );
}
function locator(value: ProvisioningEvidenceLocator): boolean {
  return !!value && bounded(value.receiptKey) && bounded(value.accountId) && validProvisioningReceipt(value);
}
function snapshot(input: ProvisioningEvidenceLocator): ProvisioningEvidenceLocator {
  const { receiptKey, accountId, registrationId, reservationId, authnEpoch, expiresAt } = input;
  return { receiptKey, accountId, registrationId, reservationId, authnEpoch, expiresAt };
}
function decode(value: unknown): ProvisioningEvidenceReference | null {
  const keys = [
    'version',
    'receiptKey',
    'accountId',
    'registrationId',
    'reservationId',
    'authnEpoch',
    'expiresAt',
    'credentialId',
  ];
  if (
    !value ||
    typeof value !== 'object' ||
    Array.isArray(value) ||
    Object.keys(value).length !== keys.length ||
    keys.some((key) => !Object.hasOwn(value, key))
  )
    return null;
  const input = value as ProvisioningEvidenceReference;
  // Capture primitives before any asynchronous database work. The caller cannot
  // replace a verified registration/epoch by mutating its reference while waiting.
  const candidate = { version: input.version, ...snapshot(input), credentialId: input.credentialId };
  return candidate.version === 1 && locator(candidate) && bounded(candidate.credentialId) ? candidate : null;
}

/** Internal Auth read capability. No HTTP endpoint, credential payload, staging
 * authority or kernel database access. Both operations require an exact committed
 * receipt and its still-bound native Better Auth owner/credential row. */
export function createProvisioningEvidenceVerifier({ database }: { database: Pool }) {
  async function lookup(input: ProvisioningEvidenceLocator): Promise<string | null> {
    if (!locator(input)) return null;
    const result = await database.query<{ credential_id: string }>(
      `SELECT r.credential_id FROM auth_provisioning_receipt r
       JOIN "user" u ON u.id=r.owner_id
       JOIN account c ON c.id=r.credential_id
       WHERE r.idempotency_key=$1 AND r.account_id=$2 AND r.registration_id=$3
         AND r.reservation_id=$4 AND r.authn_epoch=$5 AND r.expires_at=$6::timestamptz
         AND r.expires_at>statement_timestamp() AND r.owner_id=r.account_id
         AND c."userId"=u.id AND c."accountId"=u.id AND c."providerId"='credential'
         AND ((r.provisioning_kind='password' AND c.password IS NOT NULL AND c.password<>'')
           OR (r.provisioning_kind='credentialless' AND c.password IS NULL))`,
      [input.receiptKey, input.accountId, input.registrationId, input.reservationId, input.authnEpoch, input.expiresAt],
    );
    return result.rows[0]?.credential_id ?? null;
  }
  return {
    /** The composition owner supplies exact original pending facts and the native
     * idempotency key. This verifies Auth commit only; pending authorization must
     * still be verified by the trusted Access binding before publication. */
    async createReference(input: ProvisioningEvidenceLocator): Promise<ProvisioningEvidenceReference | null> {
      let original: ProvisioningEvidenceLocator;
      try {
        original = snapshot(input);
      } catch {
        return null;
      }
      const credentialId = await lookup(original);
      return credentialId ? { version: 1, ...original, credentialId } : null;
    },
    async resolve(reference: unknown): Promise<ProvisioningEvidence | null> {
      let input: ProvisioningEvidenceReference | null;
      try {
        input = decode(reference);
      } catch {
        return null;
      }
      if (!input || (await lookup(input)) !== input.credentialId) return null;
      return {
        accountId: input.accountId,
        registrationId: input.registrationId,
        authIdentityId: input.accountId,
        authnEpoch: input.authnEpoch,
      };
    },
  };
}

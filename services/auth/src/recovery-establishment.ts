import type { Pool } from 'pg';

/** Committed successful native Auth recovery, bound to the exact Access barrier
 * and a new credential establishment. Structurally matches Access evidence. */
export type RecoveryEstablishmentEvidence = Readonly<{
  accountId: string;
  receiptId: string;
  minimumAuthnEpoch: string;
  authnEpoch: number;
  establishmentId: string;
}>;

/** A reference is a nonsecret bounded locator, never caller-supplied evidence.
 * This unavailable contract always denies in O(1), with zero product SQL.
 * Construction reads no environment, opens no database and starts no workflows.
 *
 * Future resolution must prove committed native credential success and current
 * credential state with exact point seeks, without enumerating recovery/session
 * history. Access separately checks its current receipt and floor under lock;
 * it must not access the Auth database. Native growth checks and bounded cleanup
 * ownership are required before claiming a working recovery implementation.
 */
export function createRecoveryEstablishmentVerifier(_options: { database: Pool }) {
  return {
    async resolve(_reference: unknown): Promise<RecoveryEstablishmentEvidence | null> {
      return null;
    },
  };
}

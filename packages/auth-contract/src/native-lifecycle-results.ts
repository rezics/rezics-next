import type { ProvisioningEvidence, RecoveryEstablishmentEvidence } from './index.ts';

/** Private native lookup hints. Possession grants no command, session or disclosure authority. */
export type OriginalLifecycleRequest =
  | {
      kind: 'activation';
      accountId: string;
      reservationId: string;
      operationKey: string;
      source: { registrationId: string; provisioningReceiptKey: string };
    }
  | {
      kind: 'recovery';
      accountId: string;
      operationKey: string;
      source: { establishmentReference: string };
    };

/** Auth's owner point read, consumed only inside the native Access composition.
 * These fields reconstruct the installed command ABI, never a new authorization.
 * The opaque pending reference stays inside this verification boundary. */
export type OriginalLifecycleSource =
  | {
      kind: 'activation';
      proof: ProvisioningEvidence;
      pendingReference: string;
      expiresAt: string;
    }
  | {
      kind: 'recovery';
      proof: RecoveryEstablishmentEvidence;
      floor: { operationKey: string; previousEpoch: number; proofDigest: string };
    };

export interface OriginalLifecycleSourcePort {
  readOriginalLifecycleSource(input: OriginalLifecycleRequest): Promise<OriginalLifecycleSource | null>;
}

type NativeCommit<Value> = {
  partition: number;
  epoch: number;
  position: string;
  transactionId: string;
  value: Value;
};

/** Least technical result for mechanical settlement. No request digest, pending
 * reference, credential, descriptor, handle or private source payload escapes. */
export type OriginalLifecycleResult =
  | {
      kind: 'activation';
      accountId: string;
      reservationId: string;
      authnEpoch: number;
      outcome: NativeCommit<{ accountId: string }>;
    }
  | {
      kind: 'recovery';
      accountId: string;
      establishmentId: string;
      outcome: NativeCommit<{ accountId: string; receiptId: string; minimumAuthnEpoch: string }>;
    };

export interface OriginalLifecycleResultPort {
  /** Null includes absent, imported, retired, minimized or mismatched originals. */
  readOriginalLifecycleResult(input: OriginalLifecycleRequest): Promise<OriginalLifecycleResult | null>;
}

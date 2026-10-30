import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { IdentityBindingData } from './identity-epoch-binding.ts';
import type {
  IdentityAdmissionInput,
  IdentityJobRef,
  IdentityNativeReceipt,
  IdentityReceipt,
} from './identity-epoch-contract.ts';

export type OriginalAccountAgentIdentitySelection = Readonly<{
  account: string;
  direction: Exclude<IdentityReceipt, { kind: 'subject.merge' }>['kind'];
  receipt: string;
}>;

/** Original accepted claim custody, not an Accounts decision or a recovery command receipt. */
export type OriginalAccountAgentIdentitySource = Readonly<{
  input: IdentityAdmissionInput;
  digest: string;
  native: IdentityNativeReceipt;
  job: IdentityJobRef;
  claim: Pick<IdentityBindingData, 'partition' | 'key' | 'generation' | 'transactionId' | 'home' | 'scope' | 'sources'>;
}>;

export type OriginalAccountAgentIdentity = OriginalAccountAgentIdentitySource &
  Readonly<{
    priorVerification: (OriginalAccountAgentIdentitySource & Readonly<{ verificationReceipt: string }>) | null;
  }>;

/** Provisional declaration: unavailable until the retained native implementation is installed. */
export async function readOriginalAccountAgentIdentity(
  _pool: Pool,
  _selection: OriginalAccountAgentIdentitySelection,
): Promise<OriginalAccountAgentIdentity | null> {
  return null;
}

/** Provisional declaration; never treats a released pre-read as same-transaction authority. */
export async function verifyOriginalAccountAgentIdentity(
  _tx: CommandTransaction,
  _selection: OriginalAccountAgentIdentitySelection,
  _result: OriginalAccountAgentIdentity,
): Promise<boolean> {
  return false;
}

import type { Pool } from 'pg';
import type { CommandTransaction } from '../command/command.ts';
import type { IdentityJobRef, IdentityFrontier, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type {
  IdentityReceivingSelection,
  IdentityReceivingDisposition,
} from '../semantic/identity-receiving-effects-types.ts';
import type { NativeSourceIdentity } from './native-source-custody.ts';
import type { WorkAllowance, WorkReceipt } from './collection-source.ts';

export type LibraryScopeEffectsKey = Readonly<{
  job: IdentityJobRef;
  sourceIdentity: NativeSourceIdentity;
  scope: string;
}>;
export type LibraryExpectedEffectAfter = Readonly<{
  effectKey: string;
  disposition: IdentityReceivingDisposition;
}>;
declare const scopeEffectsSeal: unique symbol;
export type LibraryScopeEffectSeal = Readonly<{
  [scopeEffectsSeal]: true;
  key: LibraryScopeEffectsKey;
  generation: string;
  version: string;
  frontier: IdentityFrontier;
  receipt: IdentityNativeReceipt;
}>;
export type LibraryScopeEffectsPage =
  | Readonly<{
      status: 'pending';
      rows: readonly IdentityReceivingSelection[];
      after: LibraryExpectedEffectAfter | null;
      work: WorkReceipt;
    }>
  | Readonly<{
      status: 'sealed';
      rows: readonly IdentityReceivingSelection[];
      after: LibraryExpectedEffectAfter | null;
      exhausted: boolean;
      seal: LibraryScopeEffectSeal;
      work: WorkReceipt;
    }>
  | Readonly<{ status: 'unavailable'; work: WorkReceipt }>;

/** PROVISIONAL exact Library handoff. Native implementation replaces this unavailable adapter on integration. */
export async function readLibraryScopeEffectsPage(
  pool: Pool,
  input: LibraryScopeEffectsKey &
    Readonly<{
      after: LibraryExpectedEffectAfter | null;
      limit: number;
      allowance: WorkAllowance;
      deadline: number;
    }>,
): Promise<LibraryScopeEffectsPage> {
  return {
    status: 'unavailable',
    work: {
      reservationId: input.allowance.reservationId,
      used: {
        candidateKeys: 0,
        nativeRows: 0,
        identityMetadataRows: 0,
        nativePoints: 0,
        witnessKeys: 0,
        statements: 0,
        bytes: 0,
        emptySeeks: 0,
      },
    },
  };
}
export async function verifyLibraryScopeEffectsSeal(
  tx: CommandTransaction,
  key: LibraryScopeEffectsKey,
  seal: LibraryScopeEffectSeal,
): Promise<boolean> {
  return false;
}

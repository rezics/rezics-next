import type { Pool } from 'pg';
import { type CommandTransaction } from '../command/command.ts';
import { NativeCollectionWork } from './collection-source-work.ts';
import type { IdentityJobRef, IdentityFrontier, IdentityNativeReceipt } from '../semantic/identity-epoch-contract.ts';
import type { IdentityReceivingSelection, IdentityReceivingDisposition } from '../semantic/identity-receiving-effects-types.ts';
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
export type LibraryScopeEffectsPage = Readonly<{
    status: 'pending';
    rows: readonly IdentityReceivingSelection[];
    after: LibraryExpectedEffectAfter | null;
    work: WorkReceipt;
}> | Readonly<{
    status: 'sealed';
    rows: readonly IdentityReceivingSelection[];
    after: LibraryExpectedEffectAfter | null;
    exhausted: boolean;
    seal: LibraryScopeEffectSeal;
    work: WorkReceipt;
}> | Readonly<{
    status: 'unavailable';
    work: WorkReceipt;
}>;
/** Native expected selections only. Sealed pages still require exhaustive consumer pagination.
 * Missing/changed captures and unsealed native plans cannot become an empty complete observation.
 */
export declare function readLibraryScopeEffectsPage<Source extends NativeSourceIdentity>(pool: Pool, input: LibraryScopeEffectsKey & Readonly<{
    sourceIdentity: Source;
    after: LibraryExpectedEffectAfter | null;
    limit: number;
    allowance: WorkAllowance;
    deadline: number;
}>): Promise<Exclude<LibraryScopeEffectsPage, {
    status: 'sealed';
}> | (Extract<LibraryScopeEffectsPage, {
    status: 'sealed';
}> & Readonly<{
    seal: LibraryScopeEffectSeal & Readonly<{
        key: LibraryScopeEffectsKey & Readonly<{
            sourceIdentity: Source;
        }>;
    }>;
}>)>;
export type LibraryScopeEffectsPageInput<Source extends NativeSourceIdentity = NativeSourceIdentity> = LibraryScopeEffectsKey & Readonly<{
    sourceIdentity: Source;
    after: LibraryExpectedEffectAfter | null;
    limit: number;
    deadline: number;
}>;
export type LibraryScopeEffectsPageFor<Source extends NativeSourceIdentity> = Exclude<LibraryScopeEffectsPage, {
    status: 'sealed';
}> | (Extract<LibraryScopeEffectsPage, {
    status: 'sealed';
}> & Readonly<{
    seal: LibraryScopeEffectSeal & Readonly<{
        key: LibraryScopeEffectsKey & Readonly<{
            sourceIdentity: Source;
        }>;
    }>;
}>);
/** Use the live owner's exact prepaid ledger. The input carries no funding authority. */
export declare function readLibraryScopeEffectsPageWithWork<Source extends NativeSourceIdentity>(pool: Pool, input: LibraryScopeEffectsPageInput<Source>, work: NativeCollectionWork): Promise<LibraryScopeEffectsPageFor<Source>>;
/** SAME Source-local Core client only. No foreign receiving lookup, checkout or supplied records[] here. */
export declare function verifyLibraryScopeEffectsSeal(tx: CommandTransaction, key: LibraryScopeEffectsKey, seal: LibraryScopeEffectSeal): Promise<boolean>;
export {};

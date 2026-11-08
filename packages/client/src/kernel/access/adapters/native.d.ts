import type { Pool } from 'pg';
import type { AccessApplicationPorts, AccessIdentityReceipt, KindAudienceLibraryPort, RealmCommandTransaction } from '../contract/index.ts';
export type NativeAccessLibraryBindings = Readonly<{
    resolveCollectionKindRawNative: NonNullable<KindAudienceLibraryPort['resolveCollectionKindRawNative']>;
    historyOriginalLibraryDeclaration: () => unknown;
}>;
/** Native Access ports. Composition roots bind these; applications never import this module. */
export declare function createNativeAccessPorts(acknowledgeErasure: (deps: {
    pool: Pool;
}, input: {
    accountId: string;
    participant: 'access';
    outcome: 'erased';
}) => Promise<unknown>, library?: NativeAccessLibraryBindings): AccessApplicationPorts;
export type { AccessIdentityReceipt, RealmCommandTransaction };

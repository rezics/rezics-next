/** Identity/disclosure adapter. Semantic and Access implementations arrive through composition. */
import type { NativeReleasedDefinitions } from '../../semantic/adapters/index.ts';
import type { readIdentityMappings } from '../../semantic/identity-adapters/read.ts';
import type { durableInitiatorCommitment } from '../../access/durable-initiator-capture.ts';
import type { Pool } from 'pg';
import type { IdentityDisclosureCapability } from '../contract/index.ts';
import type { LibraryActor } from '../contract/index.ts';
export type IdentityDisclosureAdapterPorts = Readonly<{
    readRelease: NativeReleasedDefinitions['read'];
    readActiveRelease: NativeReleasedDefinitions['active'];
    readIdentityMappings: typeof readIdentityMappings;
    durableInitiatorCommitment: typeof durableInitiatorCommitment;
    within<T>(deadline: number, work: () => Promise<T>): Promise<T>;
}>;
export declare function createIdentityDisclosureAdapter(input: {
    pool?: Pool | undefined;
    ports: IdentityDisclosureAdapterPorts;
}): IdentityDisclosureCapability;
export type { LibraryActor };

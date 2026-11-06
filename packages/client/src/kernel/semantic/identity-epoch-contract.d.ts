/** Compatibility entry for retained native callers. */
export * from './identity-adapters/identity-epoch-contract.ts';
import type { CommandBasis, CommandAuthorization } from '../command/command.ts';
export type IdentityAdmissionAuthority = Readonly<{
    basis?: CommandBasis;
    authorization?: CommandAuthorization;
    authorizationFor?: (partition: number) => Promise<CommandAuthorization>;
    deadline?: number;
    clock?: () => Date;
}>;
export declare function commandAuthorityAt(authority: IdentityAdmissionAuthority, partition: number): Promise<{
    partition: number;
    basis?: CommandBasis;
    authorization?: CommandAuthorization;
    deadline?: number;
    clock?: () => Date;
}>;

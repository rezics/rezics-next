import type { CommandTransaction } from '../command/command.ts';
import type { IdentityRepairPage } from './identity-work-frame.ts';
export type RatingIdentityMapping = Readonly<{
    originalId: string;
    terminalId: string;
    epoch: string;
}>;
export type RatingIdentityAuthority = Readonly<{
    status: 'pending';
    reason: string;
}> | Readonly<{
    status: 'current';
    obligationId: string;
    mappings: readonly RatingIdentityMapping[];
}>;
/** Trusted producer composition only. Released Pool observations cannot implement this port.
 * hold must protect the exact original-to-visible-terminal mappings against change until this
 * voter transaction commits, and retain a repair obligation for later identity changes.
 * complete must bind that obligation to the native Rating receipt in the SAME transaction;
 * false rolls back vote effects, receipt and checkpoint. Neither method supplies authorization.
 */
export type RatingIdentityProducer = Readonly<{
    hold(tx: CommandTransaction, page: Readonly<IdentityRepairPage>): Promise<RatingIdentityAuthority>;
    complete(tx: CommandTransaction, input: Readonly<{
        page: Readonly<IdentityRepairPage>;
        obligationId: string;
        mappingDigest: string;
        transactionId: string;
    }>): Promise<boolean>;
}>;
export declare const unavailableRatingIdentityProducer: RatingIdentityProducer;
export declare function validIdentityAuthority(page: IdentityRepairPage, authority: Extract<RatingIdentityAuthority, {
    status: 'current';
}>): boolean;
export declare function identityMappingDigest(mappings: readonly RatingIdentityMapping[]): string;
export declare class RatingIdentityVotePending extends Error {
    readonly reason: string;
    constructor(reason: string);
}

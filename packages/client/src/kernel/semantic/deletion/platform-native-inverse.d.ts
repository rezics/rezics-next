import type { WorkDimensions } from '../../library/contract/work-dimensions.ts';
import type { CommandTransaction } from '../../command/command.ts';
export declare const PLATFORM_NATIVE_INVERSE_REMOVAL_PURPOSE = "identity-platform-native-inverse-removal";
export type PlatformNativeInverseLocator = Readonly<{
    home: number;
    generation: string;
    original: string;
    sourcePartition: number;
    captureId: string;
    registration: string;
    scopeKey: string;
    sourceKey: string;
}>;
export type PlatformNativeInverseCommand = Readonly<{
    partition: number;
    basis: unknown;
    transactionId: string;
}>;
/** Source-commit plus two inverse deletes. Native commit stays the caller's existing purpose. */
export declare function platformNativeInverseRemovalCost(): WorkDimensions;
/** Platform capture commands have no editorial write-basis. Record erasure-source provenance in this
 * home/T, then delete admitted inverses so prearm export and cancellation can close. */
export declare function removePlatformNativeInverse(tx: CommandTransaction, locator: PlatformNativeInverseLocator, command: PlatformNativeInverseCommand): Promise<void>;

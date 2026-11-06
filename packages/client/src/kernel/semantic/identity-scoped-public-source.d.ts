import type { CommandTransaction } from '../command/command.ts';
import type { PublicFilterSourceFactory, PublicFilterReadContext, PublicFilterCost } from './public-filter-source-contract.ts';
import { type NativePublicSource, type PublicFilterSourceDefinition } from './public-filter-source-binding.ts';
declare const publicSourceCapture: unique symbol;
export type PublicIdentitySourceCapture = Readonly<{
    [publicSourceCapture]: true;
}>;
export type PublicIdentitySourceCapturePage = Readonly<{
    status: 'progress';
    captureId: string;
    frontier: string;
    originals: readonly string[];
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'complete';
    captureId: string;
    frontier: null;
    originals: readonly string[];
    capture: PublicIdentitySourceCapture;
    cost: PublicFilterCost;
}> | Readonly<{
    status: 'changed' | 'unready' | 'unavailable';
    cost: PublicFilterCost;
}>;
export type PublicIdentitySourceCaptureProducer = Readonly<{
    capturePage(request: Readonly<{
        definition: PublicFilterSourceDefinition;
        frontier: string | null;
        inputLimit: number;
        context: PublicFilterReadContext;
    }>): Promise<PublicIdentitySourceCapturePage>;
}>;
export type CreatePublicIdentitySourceCapture = (config: Parameters<PublicFilterSourceFactory>[0]) => PublicIdentitySourceCaptureProducer;
export type VerifyPublicIdentitySourceCapture = (tx: CommandTransaction, capture: PublicIdentitySourceCapture) => Promise<boolean>;
type Locator = {
    source: NativePublicSource;
    captureId: string;
    definition: string;
};
export declare function publicIdentityCaptureLocator(capture: PublicIdentitySourceCapture): Locator | null;
/** Background structural scan; it never evaluates a matcher or grants public read authority. */
export declare const createPublicIdentitySourceCapture: CreatePublicIdentitySourceCapture;
/** Native committed capture + current local Source owner, on the caller's own command client. */
export declare function verifyPublicIdentitySourceCapture(tx: CommandTransaction, capture: PublicIdentitySourceCapture): Promise<boolean>;
export declare function verifyPublicIdentitySourceCaptureLocator(tx: CommandTransaction, locator: Locator): Promise<boolean>;
/** Native receiving uses only persisted Semantic selectors on the actual shared command. */
export declare function lockPublicIdentityOutputCaptureDisposition(tx: CommandTransaction, selection: import('../library/native-public-output-contract.ts').PublicOutputDispositionSelection, context: import('../library/native-public-output-contract.ts').PublicOutputCommandContext): Promise<Readonly<{
    status: 'changed' | 'unavailable';
    dependency?: string;
    work: import("../library/access-capabilities.ts").WorkReceipt;
}> | import("../library/native-public-output-contract.ts").LockedPublicOutputDisposition>;
export {};

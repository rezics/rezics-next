import { type OperationalTransaction } from '../command/operational.ts';
import { type SelectedCost } from '../work/selected-runtime-cost.ts';
import { type SelectedIdentity } from '../work/selected-runtime.ts';
export type SelectedLocator = Readonly<{
    route: number;
    ownerAccountId: string;
    collectionId: string;
    episodeId: string;
}>;
export type SelectedOutcome = Readonly<{
    kind: 'complete' | 'continue' | 'failure' | 'obsolete';
    version: string;
    continuation?: string;
}>;
declare const selectedEpisode: unique symbol;
/** Result is durable data for replay. This object itself is usable only inside its original invocation. */
export type SelectedEpisode = Readonly<{
    result: SelectedOutcome | null;
    readonly [selectedEpisode]: true;
}>;
export declare function associateSelectedEpisode(tx: OperationalTransaction, identity: SelectedIdentity, locator: SelectedLocator, charge: (cost: SelectedCost) => void, fresh?: boolean): Promise<SelectedEpisode>;
export declare function finishSelectedEpisode(tx: OperationalTransaction, identity: SelectedIdentity, episode: SelectedEpisode, phase: 'apply' | 'failure', body: (tx: OperationalTransaction) => Promise<SelectedOutcome>, charge: (cost: SelectedCost) => void): Promise<SelectedOutcome>;
export {};

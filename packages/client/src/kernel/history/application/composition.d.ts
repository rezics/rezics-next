import { type HistoryComposition } from '../contract/index.ts';
/** Installed once by the process composition root before History is used. Replaces any earlier install. */
export declare function installHistoryComposition(composition: HistoryComposition): void;
/** The installed native composition. Nothing is substituted when it is absent. */
export declare function historyComposition(): HistoryComposition;

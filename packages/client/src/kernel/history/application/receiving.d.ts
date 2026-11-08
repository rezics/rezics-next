import { type HistoryComposition } from '../contract/index.ts';
/** Receiving proof and owner coverage. Each facade delegates to the installed native composition; adapters implement them. */
export declare const readHistoryOwnerCoverage: HistoryComposition['readHistoryOwnerCoverage'];
export declare const verifyHistoryReceivingReceipt: HistoryComposition['verifyHistoryReceivingReceipt'];
export declare const recordHistoryReceivingProof: HistoryComposition['recordHistoryReceivingProof'];
export declare const historyDeadline: HistoryComposition['historyDeadline'];
export declare const lockHistoryBarrier: HistoryComposition['lockHistoryBarrier'];
export declare const historyReceivingGap: HistoryComposition['historyReceivingGap'];
export declare const readHistoryReceivingReceipt: HistoryComposition['readHistoryReceivingReceipt'];
export declare const verifyCurrentHistoryReceiving: HistoryComposition['verifyCurrentHistoryReceiving'];

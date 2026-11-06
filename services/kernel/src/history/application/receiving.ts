import { historyComposition } from './composition.ts';
import { type HistoryComposition } from '../contract/index.ts';
/** Receiving proof and owner coverage. Each facade delegates to the installed native composition; adapters implement them. */

export const readHistoryOwnerCoverage: HistoryComposition['readHistoryOwnerCoverage'] = (...args) =>
  historyComposition().readHistoryOwnerCoverage(...args);

export const verifyHistoryReceivingReceipt: HistoryComposition['verifyHistoryReceivingReceipt'] = (...args) =>
  historyComposition().verifyHistoryReceivingReceipt(...args);

export const recordHistoryReceivingProof: HistoryComposition['recordHistoryReceivingProof'] = (...args) =>
  historyComposition().recordHistoryReceivingProof(...args);

export const historyDeadline: HistoryComposition['historyDeadline'] = (...args) =>
  historyComposition().historyDeadline(...args);

export const lockHistoryBarrier: HistoryComposition['lockHistoryBarrier'] = (...args) =>
  historyComposition().lockHistoryBarrier(...args);

export const historyReceivingGap: HistoryComposition['historyReceivingGap'] = (...args) =>
  historyComposition().historyReceivingGap(...args);

export const readHistoryReceivingReceipt: HistoryComposition['readHistoryReceivingReceipt'] = (...args) =>
  historyComposition().readHistoryReceivingReceipt(...args);

export const verifyCurrentHistoryReceiving: HistoryComposition['verifyCurrentHistoryReceiving'] = (...args) =>
  historyComposition().verifyCurrentHistoryReceiving(...args);

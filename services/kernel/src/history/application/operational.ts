import { historyComposition } from './composition.ts';
import { type HistoryComposition, type HistoryHandle, type HistoryTransaction } from '../contract/index.ts';
/** Operational work attempts, transfers and selected execution. Each facade delegates to the installed native composition; adapters implement them. */

export const historyExecutionPort: HistoryComposition['historyExecutionPort'] = Object.freeze({
  begin: (tx: HistoryTransaction, original: HistoryHandle) =>
    historyComposition().historyExecutionPort.begin(tx, original),
  finalize: (tx: HistoryTransaction) => historyComposition().historyExecutionPort.finalize(tx),
  finish: (tx: HistoryTransaction, committed: boolean) =>
    historyComposition().historyExecutionPort.finish(tx, committed),
  enqueueCapture: (tx: HistoryTransaction, intent: HistoryHandle) =>
    historyComposition().historyExecutionPort.enqueueCapture(tx, intent),
});

export const registerPositionedOperationalHistoryWork: HistoryComposition['registerPositionedOperationalHistoryWork'] =
  (...args) => historyComposition().registerPositionedOperationalHistoryWork(...args);

export const reserveOperationalWorkTransfer: HistoryComposition['reserveOperationalWorkTransfer'] = (...args) =>
  historyComposition().reserveOperationalWorkTransfer(...args);

export const receiveOperationalWorkDestination: HistoryComposition['receiveOperationalWorkDestination'] = (...args) =>
  historyComposition().receiveOperationalWorkDestination(...args);

export const associateSelectedEpisode: HistoryComposition['associateSelectedEpisode'] = (...args) =>
  historyComposition().associateSelectedEpisode(...args);

export const finishSelectedEpisode: HistoryComposition['finishSelectedEpisode'] = (...args) =>
  historyComposition().finishSelectedEpisode(...args);

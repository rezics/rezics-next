import { historyComposition } from './composition.ts';
import { type HistoryComposition } from '../contract/index.ts';
/** Command declarations, record sources, gates, record purge and durable work locators. Each facade delegates to the installed native composition; adapters implement them. */

export const declareCommandHistory: HistoryComposition['declareCommandHistory'] = (...args) =>
  historyComposition().declareCommandHistory(...args);

export const bindCommandHistoryEvidence: HistoryComposition['bindCommandHistoryEvidence'] = (...args) =>
  historyComposition().bindCommandHistoryEvidence(...args);

export const commandHistoryIdentityAccounts: HistoryComposition['commandHistoryIdentityAccounts'] = (...args) =>
  historyComposition().commandHistoryIdentityAccounts(...args);

export const validateCommandHistory: HistoryComposition['validateCommandHistory'] = (...args) =>
  historyComposition().validateCommandHistory(...args);

export const validateCommandHistoryScope: HistoryComposition['validateCommandHistoryScope'] = (...args) =>
  historyComposition().validateCommandHistoryScope(...args);

export const recordCommandHistory: HistoryComposition['recordCommandHistory'] = (...args) =>
  historyComposition().recordCommandHistory(...args);

export const releaseCommandHistory: HistoryComposition['releaseCommandHistory'] = (...args) =>
  historyComposition().releaseCommandHistory(...args);

export const beginRecordHistorySerialization: HistoryComposition['beginRecordHistorySerialization'] = (...args) =>
  historyComposition().beginRecordHistorySerialization(...args);

export const commandRecordSources: HistoryComposition['commandRecordSources'] = (...args) =>
  historyComposition().commandRecordSources(...args);

export const declareCommandRecordSources: HistoryComposition['declareCommandRecordSources'] = (...args) =>
  historyComposition().declareCommandRecordSources(...args);

export const declareCommandRecordSourceSet: HistoryComposition['declareCommandRecordSourceSet'] = (...args) =>
  historyComposition().declareCommandRecordSourceSet(...args);

export const finalizeCommandRecordSources: HistoryComposition['finalizeCommandRecordSources'] = (...args) =>
  historyComposition().finalizeCommandRecordSources(...args);

export const releaseCommandRecordSources: HistoryComposition['releaseCommandRecordSources'] = (...args) =>
  historyComposition().releaseCommandRecordSources(...args);

export const recordRecordHistoryCopy: HistoryComposition['recordRecordHistoryCopy'] = (...args) =>
  historyComposition().recordRecordHistoryCopy(...args);

export const hasCommandRecordSourceSet: HistoryComposition['hasCommandRecordSourceSet'] = (...args) =>
  historyComposition().hasCommandRecordSourceSet(...args);

export const finalizeCommandRecordSourceSet: HistoryComposition['finalizeCommandRecordSourceSet'] = (...args) =>
  historyComposition().finalizeCommandRecordSourceSet(...args);

export const releaseCommandRecordSourceSet: HistoryComposition['releaseCommandRecordSourceSet'] = (...args) =>
  historyComposition().releaseCommandRecordSourceSet(...args);

export const recordCommandRecordSourceSetCopy: HistoryComposition['recordCommandRecordSourceSetCopy'] = (...args) =>
  historyComposition().recordCommandRecordSourceSetCopy(...args);

export const guardHistoryAccounts: HistoryComposition['guardHistoryAccounts'] = (...args) =>
  historyComposition().guardHistoryAccounts(...args);

export const prepareRecordHistoryPurge: HistoryComposition['prepareRecordHistoryPurge'] = (...args) =>
  historyComposition().prepareRecordHistoryPurge(...args);

export const minimizeRecordHistoryPurge: HistoryComposition['minimizeRecordHistoryPurge'] = (...args) =>
  historyComposition().minimizeRecordHistoryPurge(...args);

export const recordDurableWorkLocator: HistoryComposition['recordDurableWorkLocator'] = (...args) =>
  historyComposition().recordDurableWorkLocator(...args);

export const commandHistoryKind: HistoryComposition['commandHistoryKind'] = (...args) =>
  historyComposition().commandHistoryKind(...args);

import { type HistoryComposition } from '../contract/index.ts';
/** Operational work attempts, transfers and selected execution. Each facade delegates to the installed native composition; adapters implement them. */
export declare const historyExecutionPort: HistoryComposition['historyExecutionPort'];
export declare const registerPositionedOperationalHistoryWork: HistoryComposition['registerPositionedOperationalHistoryWork'];
export declare const reserveOperationalWorkTransfer: HistoryComposition['reserveOperationalWorkTransfer'];
export declare const receiveOperationalWorkDestination: HistoryComposition['receiveOperationalWorkDestination'];
export declare const associateSelectedEpisode: HistoryComposition['associateSelectedEpisode'];
export declare const finishSelectedEpisode: HistoryComposition['finishSelectedEpisode'];

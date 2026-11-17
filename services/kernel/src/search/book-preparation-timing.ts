export type BookPreparationSpan =
  | 'publication'
  | 'nativeSource'
  | 'advance'
  | 'settlement'
  | 'initialAuthority'
  | 'savedLocal'
  | 'releasedForeign'
  | 'freshLocal'
  | 'enginePhysical'
  | 'engineRefresh'
  | 'engineOther'
  | 'ackReceiver'
  | 'ackCursor';

export type BookPreparationMark =
  | 'terminalRepair'
  | 'ackAdvanced'
  | 'writerFence'
  | 'writerDrain'
  | 'aliasWrite'
  | 'aliasConfirmed';

export type BookPreparationTurn = {
  startedAtMs: number;
  claimMs: number;
  inputRevision: string;
  revision: string;
  phase: 'scan' | 'replay' | 'native' | 'activate';
  deliveryDeadlineMs: number;
};

export type BookPublicationStatus =
  | 'progress'
  | 'reconciled'
  | 'unavailable'
  | 'unready'
  | 'activated'
  | 'superseded'
  | 'preparing';

export type BookPreparationTiming = {
  turn<T>(turn: BookPreparationTurn, run: () => Promise<T>): Promise<T>;
  start(span: BookPreparationSpan): (() => void) | undefined;
  mark(phase: BookPreparationMark, count?: number): void;
  outcome(status: BookPublicationStatus, sourceAdvanced?: boolean): void;
};

export let bookPreparationTiming: BookPreparationTiming | undefined;

export function installBookPreparationTiming(observer: BookPreparationTiming): void {
  bookPreparationTiming = observer;
}

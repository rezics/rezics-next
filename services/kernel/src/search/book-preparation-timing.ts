import type {
  NativePublicFilterPublicationCompletion,
  PublicFilterBindingFailure,
} from '../semantic/public-filter-source-binding.ts';
import type { PublicFilterConsumerUnavailable } from '../semantic/source-binding-port.ts';
import type { PublicFilterConsumerRepair } from './public-filter-consumer-contract.ts';

export type BookPreparationSpan =
  | 'publication'
  | 'publicationCheckout'
  | 'publicationLock'
  | 'publicationLoad'
  | 'publicationAdopt'
  | 'publicationHeld'
  | 'publicationPhysical'
  | 'publicationRefresh'
  | 'publicationPitOpen'
  | 'publicationPitPage'
  | 'publicationEngineHome'
  | 'publicationPitClose'
  | 'publicationValidate'
  | 'publicationMetadata'
  | 'publicationSave'
  | 'publicationAliasRead'
  | 'publicationAliasWrite'
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

export type BookPublicationOutcome = {
  status: BookPublicationStatus;
  advanced: boolean;
  sourceAdvanced: boolean;
  reason?: PublicFilterConsumerUnavailable['reason'];
};

export type BookSourceOutcome = {
  status:
    | NativePublicFilterPublicationCompletion['status']
    | PublicFilterConsumerUnavailable['status']
    | 'custody-unavailable'
    | 'input-budget-exhausted';
  reason?:
    | Extract<NativePublicFilterPublicationCompletion, { reason: unknown }>['reason']
    | PublicFilterConsumerUnavailable['reason'];
  advanced?: boolean;
};

export type BookRepairStage =
  | 'source-binding'
  | 'retained-custody'
  | 'page-budget'
  | 'source-page'
  | 'page-verification'
  | 'writer-dispatch'
  | 'page-settlement'
  | 'terminal-repair';

export type BookRepairOutcome = {
  status: PublicFilterConsumerRepair['status'];
  reason?: PublicFilterConsumerUnavailable['reason'];
};

export type BookRepairStepRefusal = Readonly<
  {
    observation: string;
    execution: string;
    predecessor: string | null;
  } & (
    | { status: PublicFilterBindingFailure['status']; reason: PublicFilterBindingFailure['reason'] }
    | { status: 'exception' }
  )
>;

export type BookPreparationTiming = {
  turn<T>(turn: BookPreparationTurn, run: () => Promise<T>): Promise<T>;
  start(span: BookPreparationSpan): (() => void) | undefined;
  mark(phase: BookPreparationMark, count?: number): void;
  outcome(outcome: BookPublicationOutcome): void;
  sourceOutcome(source: BookSourceOutcome): void;
  repairStage(stage: BookRepairStage): void;
  repairOutcome(repair: BookRepairOutcome): void;
  sourcePageRefusal(reason: PublicFilterBindingFailure['reason']): void;
  repairStepRefusal(refusal: BookRepairStepRefusal): void;
};

export let bookPreparationTiming: BookPreparationTiming | undefined;

export function installBookPreparationTiming(observer: BookPreparationTiming): void {
  bookPreparationTiming = observer;
}

export function measureBookPreparation<T>(span: BookPreparationSpan, run: () => Promise<T>): Promise<T> {
  const end = bookPreparationTiming?.start(span);
  if (!end) return run();
  try {
    return run().finally(end);
  } catch (error) {
    end();
    throw error;
  }
}

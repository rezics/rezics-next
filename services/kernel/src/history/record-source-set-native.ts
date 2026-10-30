export type {
  SemanticRecordSourceSet,
  SemanticRecordSourceSetLocator,
  SemanticRecordSourceSetSnapshot,
} from '../semantic/record-source-set.ts';

/** Exact owner module, including its original opaque type; History defines no producer API. */
export type RecordSourceSetProducer = typeof import('../semantic/record-source-set.ts');
export type RecordSourceSetCommitment = import('../semantic/record-source-set.ts').SemanticRecordSourceSetSnapshot;

export class RecordSourceSetUnavailableError extends Error {
  readonly code = 'record_history_native_source_set_unavailable';
  constructor() {
    super('record_history_native_source_set_unavailable');
    this.name = 'RecordSourceSetUnavailableError';
  }
}

// A declaration file is not a native implementation. Import errors from an existing owner
// module propagate. Loading once permits synchronous, source-owned same-command validation.
const producer = (await Bun.file(new URL('../semantic/record-source-set.ts', import.meta.url)).exists())
  ? await import('../semantic/record-source-set.ts')
  : null;

export function nativeRecordSourceSetProducer(): RecordSourceSetProducer {
  if (!producer) throw new RecordSourceSetUnavailableError();
  return producer;
}

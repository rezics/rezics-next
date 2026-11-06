import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

export type {
  SemanticRecordSourceSet,
  SemanticRecordSourceSetLocator,
  SemanticRecordSourceSetSnapshot,
} from '../../semantic/record-source-set.ts';

/** Exact owner module, including its original opaque type; History defines no producer API. */
export type RecordSourceSetProducer = typeof import('../../semantic/record-source-set.ts');
export type RecordSourceSetCommitment = import('../../semantic/record-source-set.ts').SemanticRecordSourceSetSnapshot;

export class RecordSourceSetUnavailableError extends Error {
  readonly code = 'record_history_native_source_set_unavailable';
  constructor() {
    super('record_history_native_source_set_unavailable');
    this.name = 'RecordSourceSetUnavailableError';
  }
}

// Load the exact owner only on first use. A top-level dynamic import would deadlock if
// Source imports History's declaration port while History is awaiting that import.
// A declaration file alone is unavailable; failures in an existing module propagate.
const requireNative = createRequire(import.meta.url);
const ownerModule = new URL('../../semantic/record-source-set.ts', import.meta.url);
let producer: RecordSourceSetProducer | undefined;

export function nativeRecordSourceSetProducer(): RecordSourceSetProducer {
  if (producer) return producer;
  if (!existsSync(fileURLToPath(ownerModule))) throw new RecordSourceSetUnavailableError();
  const native: RecordSourceSetProducer = requireNative(fileURLToPath(ownerModule));
  producer = native;
  return native;
}

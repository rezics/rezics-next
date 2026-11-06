import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

import type {
  SemanticRecordSourceSet,
  SemanticRecordSourceSetLocator,
  SemanticRecordSourceSetSnapshot,
} from '../../semantic/record-source-set.ts';

export type { SemanticRecordSourceSet, SemanticRecordSourceSetLocator, SemanticRecordSourceSetSnapshot };

/** Exact owner module, including its original opaque type; History defines no producer API. */
export type RecordSourceSetProducer = typeof import('../../semantic/record-source-set.ts');
export type RecordSourceSetCommitment = SemanticRecordSourceSetSnapshot;

export class RecordSourceSetUnavailableError extends Error {
  readonly code = 'record_history_native_source_set_unavailable';
  constructor() {
    super('record_history_native_source_set_unavailable');
    this.name = 'RecordSourceSetUnavailableError';
  }
}

// A top-level dynamic import of the owner from this adapter deadlocks: Source already imports
// History's declaration port. The live ESM module binds itself after it finishes evaluating.
// A CJS require of the same path is a second instance with empty command maps, so catalogue
// create cannot locate the set that writeSubject just began. Require remains only for a tree
// that never loaded the owner.
const ownerModule = '../../semantic/record-source-set.ts';
const requireNative = createRequire(import.meta.url);
let producer: RecordSourceSetProducer | undefined;

export function bindNativeRecordSourceSetProducer(native: RecordSourceSetProducer): void {
  producer = native;
}

export function nativeRecordSourceSetProducer(): RecordSourceSetProducer {
  if (producer) return producer;
  if (!existsSync(fileURLToPath(new URL(ownerModule, import.meta.url))))
    throw new RecordSourceSetUnavailableError();
  const native: RecordSourceSetProducer = requireNative(ownerModule);
  producer = native;
  return native;
}

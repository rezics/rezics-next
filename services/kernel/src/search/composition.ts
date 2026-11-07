import { chooseTexts, pendingFacts, validateHitOptions } from './hits.ts';
import type { IndexedSubject } from './source.ts';
import { WORK_CONTEXT_LIMITS, workContextBytes, workContextKind } from './work-context.ts';
import type { CopyWorkSearchEvidencePort } from '../semantic/index.ts';
import type { SearchNativePorts } from './native-ports.ts';
import { bindSearchNativePorts } from './native-bindings.ts';
import { bindSearchSemanticSourcePort } from './source-publication-application.ts';
export { createSearchSourceBindingAdapter } from './source-binding-adapter.ts';

/** Search's consumer-facing evidence adapter for Semantic reading applications. */
export function createSemanticCopyWorkEvidencePort(): CopyWorkSearchEvidencePort {
  return Object.freeze({
    validateHitOptions,
    chooseTexts,
    pendingFacts(subject, properties) {
      return pendingFacts(subject as unknown as Pick<IndexedSubject, 'statements'>, properties) as ReturnType<
        CopyWorkSearchEvidencePort['pendingFacts']
      >;
    },
    workContext: Object.freeze({
      limits: WORK_CONTEXT_LIMITS,
      bytes: workContextBytes,
      kind: workContextKind,
    }),
  });
}

/** Composition-only entry for binding Search-owned application ports. */
export { bindSearchSemanticSourcePort, bindSearchNativePorts };
export type { SearchSemanticSourcePort } from './semantic-source-port.ts';
export type { SearchNativePorts } from './native-ports.ts';

/** Install the complete producer object for legacy live bindings and publication consumers. */
export function bindSearchNativeCapabilities(port: SearchNativePorts): SearchNativePorts {
  const installed = bindSearchNativePorts(port);
  bindSearchSemanticSourcePort(installed);
  return installed;
}

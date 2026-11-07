import { createSemanticCopyWorkEvidencePort } from '../search/composition.ts';
import { createNativeSemanticCopyWorkReaderPort } from '../semantic/adapters/index.ts';
import { bindSemanticCopyWorkApplication, createSemanticCopyWorkApplication } from '../semantic/index.ts';

/** Install the Semantic read application with its native producers and Search-owned evidence adapter. */
export function installSemanticCopyWork(): void {
  const evidence = createSemanticCopyWorkEvidencePort();
  bindSemanticCopyWorkApplication(createSemanticCopyWorkApplication(createNativeSemanticCopyWorkReaderPort(evidence)));
}

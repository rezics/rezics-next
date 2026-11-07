import { composeAccessApplication } from './access.ts';
import { installNativeHistory } from './history.ts';
import { composeSemanticAdapters } from './semantic.ts';

/** Test and command preloads use the same Access, History and Semantic adapters as server and worker. */
export function installNativeHistoryPreload(): void {
  composeAccessApplication();
  installNativeHistory();
  composeSemanticAdapters();
}

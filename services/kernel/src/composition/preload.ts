import { installNativeHistory } from './history.ts';
import { composeContentReading } from './content.ts';
import { composeAccessApplication } from './access.ts';
import { composeZoneCollection } from './zones.ts';
import { composeSemanticAdapters } from './semantic.ts';

/** Test and command preloads use the same adapters as server and worker; History composition installs its Semantic producer before use. */
export function installNativeHistoryPreload(): void {
  composeAccessApplication();
  composeContentReading();
  installNativeHistory();
  composeZoneCollection();
  composeSemanticAdapters();
}

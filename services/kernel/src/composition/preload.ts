import { installNativeHistory } from './history.ts';
import { composeContentReading } from './content.ts';
import { composeAccessApplication } from './access.ts';
import { composeZones } from './zones.ts';
import { composeSemanticAdapters } from './semantic.ts';

/** Test and command preloads use the same Access, Content reading, History, Zone Collection, Zone resource and Semantic adapters as server and worker. */
export function installNativeHistoryPreload(): void {
  composeAccessApplication();
  composeContentReading();
  installNativeHistory();
  composeZones();
  composeSemanticAdapters();
}

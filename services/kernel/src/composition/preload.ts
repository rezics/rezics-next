import { composeCommunityDomainPorts } from './community-domain-ports.ts';
import { composeLibraryPresentation } from './library.ts';
import { installNativeHistory } from './history.ts';
import { composeContentReading } from './content.ts';
import { composeAccessApplication } from './access.ts';
import { composeZones } from './zones.ts';
import { composeSemanticAdapters } from './semantic.ts';
import { composePresentationApplication } from './presentation.ts';

/**
 * Test and command preloads use the same Access, Content reading, History, Zone Collection, Zone resource and Semantic
 * adapters as server and worker; History composition installs its Semantic producer before use.
 */
export function installNativeHistoryPreload(): void {
  composeCommunityDomainPorts();
  composeAccessApplication();
  composeContentReading();
  installNativeHistory();
  composeZones();
  composeSemanticAdapters();
  composePresentationApplication();
  composeLibraryPresentation();
}

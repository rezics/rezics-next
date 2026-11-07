import { composeRatingDependencies } from './rating.ts';
import { composeCommunityDomainPorts } from './community-domain-ports.ts';
import { composeLibraryPresentation } from './library.ts';
import { installNativeHistory } from './history.ts';
import { composeContentReading } from './content.ts';
import { composeAccessApplication } from './access.ts';
import { composeZones } from './zones.ts';
import { composeSemanticAdapters } from './semantic.ts';
import { composeSearchNativePorts } from './search-native.ts';
import { composePresentationApplication } from './presentation.ts';

/**
 * Test and command preloads use the same Rating, Access, Content reading, History, Zone Collection, Zone resource and
 * Semantic adapters as server, worker and the shared runtime defaults; History composition installs its Semantic
 * producer before use. This module loads native SQL: database provisioning entries must defer its import until
 * their database environment and Reylo analysis are installed, then call this hook before any native consumer.
 */
export function installNativeHistoryPreload(): void {
  composeRatingDependencies();
  composeCommunityDomainPorts();
  composeAccessApplication();
  composeContentReading();
  installNativeHistory();
  composeZones();
  composeSemanticAdapters();
  composeSearchNativePorts();
  composePresentationApplication();
  composeLibraryPresentation();
}

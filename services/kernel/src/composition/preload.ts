import { composeRatingDependencies } from './rating.ts';
import { composeCommunityApplication } from './community.ts';
import { composeLibraryPresentation } from './library.ts';
import { installNativeHistory } from './history.ts';
import { composeContentReading } from './content.ts';
import { composeAccessApplication } from './access.ts';
import { composeZones } from './zones.ts';
import { composeSemanticAdapters } from './semantic.ts';
import { composeSearchNativePorts } from './search-native.ts';
import { composePresentationApplication } from './presentation.ts';
import { installSemanticCopyWork } from './semantic-copy-work.ts';

/**
 * Test and command preloads use the same Rating, Access, Content reading, History, Zone Collection, Zone resource,
 * Community and Semantic adapters as server, worker and the shared runtime defaults; Community composition binds
 * Content-owned schemas before route construction. History composition installs its Semantic producer before use,
 * and Search installs its complete consumer port set here. This module loads native SQL:
 * database provisioning entries must defer its import until their database environment and Reylo analysis are
 * installed, then call this hook before any native consumer.
 */
export function installNativeHistoryPreload(): void {
  composeRatingDependencies();
  composeCommunityApplication();
  composeAccessApplication();
  composeContentReading();
  installNativeHistory();
  composeZones();
  composeSemanticAdapters();
  composeSearchNativePorts();
  installSemanticCopyWork();
  composePresentationApplication();
  composeLibraryPresentation();
}

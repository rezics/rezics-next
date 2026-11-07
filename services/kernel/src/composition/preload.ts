import { installRatingVoteSemantic } from './rating-votes.ts';
import { installNativeHistory } from './history.ts';
import { composeContentReading } from './content.ts';
import { composeAccessApplication } from './access.ts';
import { installIdentityRatingRepairProducer } from './identity-rating-repair.ts';
import { composeZoneCollection } from './zones.ts';

/** Test and command preloads use the same Access, History, Zone Collection and Rating repair composition as server and worker. */
export function installNativeHistoryPreload(): void {
  composeAccessApplication();
  composeContentReading();
  installNativeHistory();
  composeZoneCollection();
  installIdentityRatingRepairProducer();
  installRatingVoteSemantic();
}

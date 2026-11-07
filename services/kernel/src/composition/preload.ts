import { installRatingVoteSemantic } from './rating-votes.ts';
import { installNativeHistory } from './history.ts';
import { composeAccessApplication } from './access.ts';
import { installIdentityRatingRepairProducer } from './identity-rating-repair.ts';

/** Test and command preloads use the same Access, History and Rating repair composition as server and worker. */
export function installNativeHistoryPreload(): void {
  composeAccessApplication();
  installNativeHistory();
  installIdentityRatingRepairProducer();
  installRatingVoteSemantic();
}

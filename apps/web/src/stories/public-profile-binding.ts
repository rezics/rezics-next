import { bindAccountProfilePage, type ContributionActionCapabilities } from '../accounts/public-profile/page-binding';
import { reportContributionActions } from '../report';
import { threadContributionActions } from '../threads';

const liveContributionActions: ContributionActionCapabilities = {
  Watch: threadContributionActions.Watch,
  Reaction: threadContributionActions.Reaction,
  Reply: threadContributionActions.Reply,
  Report: reportContributionActions.Report,
};

/** Stories install the same Threads/Report engines as the ordinary public-profile route. */
export const storyAccountProfileBinding = bindAccountProfilePage(liveContributionActions);

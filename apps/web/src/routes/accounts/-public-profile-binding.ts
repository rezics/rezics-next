import {
  bindAccountProfilePage,
  type ContributionActionCapabilities,
} from '../../accounts/public-profile/page-binding';
import { reportContributionActions } from '../../report';
import { threadContributionActions } from '../../threads';

const liveContributionActions: ContributionActionCapabilities = {
  Watch: threadContributionActions.Watch,
  Reaction: threadContributionActions.Reaction,
  Reply: threadContributionActions.Reply,
  Report: reportContributionActions.Report,
};

/** Ordinary public-profile composition: Threads and Report engines, session lifetime, Accounts host. */
export const publicAccountProfileBinding = bindAccountProfilePage(liveContributionActions);

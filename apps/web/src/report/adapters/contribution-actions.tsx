import { PostActions } from '../content-actions';
import type { ContributionReportMount, ReportContributionActions } from '../contract/contribution-actions';
import type { OperationLease } from '../../session';

/** Existing report overflow owner, bound for the profile action host. */
export function ReportActionAdapter(props: ContributionReportMount) {
  return (
    <PostActions
      target={props.target}
      {...(props.revisionId ? { revisionId: props.revisionId } : {})}
      canonicalHref={props.canonicalHref}
      verification={props.verification}
      commandLease={props.commandLease as OperationLease<'report'>}
      canStartReport={props.canStartReport}
    />
  );
}

export const reportContributionActions: ReportContributionActions = {
  Report: ReportActionAdapter,
};

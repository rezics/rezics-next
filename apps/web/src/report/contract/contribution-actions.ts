import type { ComponentType } from 'react';

export type VerificationConfig = { sitekey: string; scriptUrl: string };

export type ContributionReportLease = {
  reader: string;
  operation: 'report';
  current: () => boolean;
  credential: () => string | null;
};

/** One admitted report visit. PostActions retains private report text and exact retry operands. */
export type ContributionReportMount = {
  target: { kind: 'thread' | 'post'; id: string };
  revisionId?: string;
  canonicalHref: string;
  verification: VerificationConfig;
  commandLease: ContributionReportLease;
  canStartReport: boolean;
};

export type ReportContributionActions = {
  Report: ComponentType<ContributionReportMount>;
};

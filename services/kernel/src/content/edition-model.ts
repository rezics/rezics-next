import type { ContentEditionBenefit } from '../access/authenticated-benefit.ts';

export type { ContentEditionBenefit } from '../access/authenticated-benefit.ts';

/** Closed owner declaration; the native Content producer supplies these facts. */
export type ContentEditionSaleAuthority = Readonly<{
  benefit: ContentEditionBenefit;
  creatorAccountId: string;
  targetSubjectId: string;
  licence: string;
  source: Readonly<{ threadId: string; postId: string; revisionId: string; sha256: string }>;
  editionRevision: string;
}>;

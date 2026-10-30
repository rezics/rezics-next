import type { DocumentSnapshot } from '@rezics/document';
import type { ContentEditionBenefit } from '../access/authenticated-benefit.ts';
export type { ContentEditionBenefit } from '../access/authenticated-benefit.ts';

export type ContentEditionSaleAuthority = Readonly<{
  benefit: ContentEditionBenefit;
  targetSubjectId: string;
  creatorAccountId: string;
  licence: string;
  source: Readonly<{ threadId: string; postId: string; revisionId: string; sha256: string }>;
  editionRevision: string;
}>;

/** Immutable native binding. No body or source URL is stored on the edition. */
export type ContentEditionSource = Readonly<{
  targetSubjectId: string;
  threadId: string;
  postId: string;
  revisionId: string;
  sha256: string;
  licence: string;
  creatorAccountId: string;
}>;
export type ContentEditionView = Readonly<{
  editionId: string;
  editionRevision: string;
  state: 'draft' | 'published' | 'withdrawn';
  targetSubjectId: string;
  creatorAccountId: string;
  revisionId: string;
  sha256: string;
  licence: string;
}>;
export type ContentEditionRevisionView = Readonly<{
  editionId: string;
  revisionId: string;
  sha256: string;
  licence: string;
  body: DocumentSnapshot;
}>;

import type { SubjectRead } from '@rezics/client';

type SubjectSummary = NonNullable<SubjectRead['summary']>;

/** Closed native list-preview declaration, pending inclusion in the generated client. */
export type CollectionPreview = {
  previewMembers: { subjectId: string; subject: SubjectSummary }[];
  previewStatus: 'ready' | 'pending';
};

/** Opt-in preview lists share the native 100-raw-key budget across at most 20 parents. */
export const COLLECTION_PREVIEW_PAGE_LIMIT = 20;

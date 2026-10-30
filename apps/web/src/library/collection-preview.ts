import type { KernelClient } from '@rezics/client';

type MemberPage = NonNullable<Awaited<ReturnType<ReturnType<KernelClient['collections']>['members']['get']>>['data']>;
type SubjectSummary = NonNullable<MemberPage['members'][number]['subject']>;

/** Closed native list-preview declaration, pending inclusion in the generated client. */
export type CollectionPreview = {
  previewMembers: { subjectId: string; subject: SubjectSummary }[];
  previewStatus: 'ready' | 'pending';
};

/** Opt-in preview lists share the native 100-raw-key budget across at most 20 parents. */
export const COLLECTION_PREVIEW_PAGE_LIMIT = 20;

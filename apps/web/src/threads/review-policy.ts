export type ReviewBoardPurpose = 'discussion' | 'reviews';

/** A review needs one subject; an ordinary discussion has no subject requirement. */
export function canSubmitThread(purpose: ReviewBoardPurpose, subjectId: string | null | undefined): boolean {
  return purpose !== 'reviews' || Boolean(subjectId);
}

/** EntityPicker is single-select. Preserve that boundary even if a caller supplies several results. */
export function selectedReviewSubject(items: readonly { id: string }[]): string | null {
  return items[0]?.id ?? null;
}

export function reviewThreadHref(locale: string, boardId: string, subjectId: string, subjectTitle: string): string {
  return `/${locale}/boards/${encodeURIComponent(boardId)}/new?subject=${encodeURIComponent(subjectId)}&subjectTitle=${encodeURIComponent(subjectTitle)}`;
}

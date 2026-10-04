export const ratingQuestionPresentationActions = [
  'rating.question-presentation.change',
  'rating.question-presentation.review',
] as const;
export function ratingQuestionPresentationAction(action: string): boolean {
  return (ratingQuestionPresentationActions as readonly string[]).includes(action);
}

export function ratingQuestionPresentationPermission(action: string) {
  return action === ratingQuestionPresentationActions[1]
    ? ratingQuestionPresentationActions[1]
    : 'rating.configure';
}

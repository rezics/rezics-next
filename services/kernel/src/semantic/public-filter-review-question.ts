/** Native selection identity for the request bridge. This key alone grants no
 * population coverage, retention, budget or authority to a Source. */
export type PublicFilterReviewQuestionKey = Readonly<{
  kind: 'reviewQuestion';
  question: string;
  revision: string;
}>;

export function publicFilterReviewQuestionKey(question: string, revision: number): PublicFilterReviewQuestionKey {
  if (!Number.isSafeInteger(revision) || revision < 1) throw new RangeError('Invalid question revision');
  return Object.freeze({ kind: 'reviewQuestion', question, revision: String(revision) });
}

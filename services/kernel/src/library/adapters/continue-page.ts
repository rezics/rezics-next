import { memoizedValue } from '../../memoized.ts';
import { SubjectSummarySchema, type SubjectSummary } from '../../semantic/contract/index.ts';
import { continuePageSchema as createContinuePageSchema } from '../contract/index.ts';
import { createContinueReads } from '../continue-reads.ts';
import type { ContinuePage, ContinueReads, ContinueSubject } from '../contract/index.ts';

export type { ContinuePage, ContinueReads, ContinueSession, ContinueSubject } from '../contract/index.ts';
export type DisclosedContinueSubject = ContinueSubject<SubjectSummary>;
export type DisclosedContinuePage = ContinuePage<SubjectSummary>;

/** Native transport compatibility: composition of the two owners' pure schemas. */
export function continuePageSchema() {
  return memoizedValue(continuePageSchema, () => createContinuePageSchema(SubjectSummarySchema));
}

/** Native Continue producer. Composition binds this; Content consumes the page, not Library storage. */
export function createContinuePageAdapter(
  ...args: Parameters<typeof createContinueReads>
): ContinueReads<SubjectSummary> {
  return createContinueReads(...args);
}

import { defineCases } from './types.ts';

/**
 * M7's exit clauses, each proven through the API (`tests/qa/integration/g-704-contribution-loop.test.ts`) and in a
 * browser (`apps/web/tests/g-704-contribution-loop.e2e.ts`). Each clause is a case; a test carries its IDs as a title
 * prefix. The page is the collaboration lifecycle's owner, which states the exit.
 */
export const cases = defineCases('docs/contracts/editorial-protection.md', [
  {
    id: 'CLP01',
    scenario:
      'Propose, review, revise, decide, notify and recover a catalogue correction in a content language outside the interface locales',
    requiredResult:
      'Each step is an API operation with a typed outcome and a screen with exactly the allowed actions; the inbox tells each person what concerns them; withdrawal and revert leave a record.',
  },
  {
    id: 'CLP02',
    scenario: 'An assistant proposes a wiki bundle that reviewers revise and a steward decides',
    requiredResult:
      'Nothing is published before the decision; the decision publishes the revealed wiki once; the assistant and its reviewers are notified.',
  },
  {
    id: 'CLP03',
    scenario:
      'A wiki chapter delta retracts one claim, resumes after an interrupted owner and reverts from its receipt',
    requiredResult:
      'A claim the delta omits is never deleted; a competing delta against the same base cannot also apply; the revert restores the ended claim.',
  },
  {
    id: 'CLP04',
    scenario: 'A changed candidate invalidates earlier approval',
    requiredResult:
      'An approval of an earlier revision stays visible as stale and never counts, for a correction, a bundle and a delta, in the API and on screen.',
  },
  {
    id: 'CLP05',
    scenario:
      'Historical wiki rendering and export survive renames, merges and rights changes of their dependencies',
    requiredResult:
      'A pinned revision set renders unchanged after a rename or merge; a rights restriction withholds the quote everywhere and an export made before it stops serving.',
  },
  {
    id: 'CLP06',
    scenario:
      'A replaced or revoked assistant credential keeps the artifacts it was authorized to make',
    requiredResult:
      'Proposals, receipts, claims and attribution stay readable after the credential changes hands or ends; the old bearer is refused; the replacement is no more independent of its Agent’s work.',
  },
  {
    id: 'CLP07',
    scenario:
      'Distribution, worldbuilding, developer extras, Agent mode, the document editor, Realm prose wikis and recognition stay closed in M7',
    requiredResult:
      'The public API and the site expose no operation, route, setting or navigation entry for them.',
  },
]);

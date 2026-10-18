import type { LaunchCoverage, NamedProof } from './launch-coverage.ts';

export type VerticalJourney = { kind: Exclude<LaunchCoverage['kind'], 'catalogue'> } & (NamedProof | { missing: string });

/** One existing signed-in main path per vertical. Keep gaps explicit rather than running a whole file. */
export const verticalJourneys: readonly VerticalJourney[] = [
  { kind: 'books', file: 'apps/web/tests/library-loans.e2e.ts',
    test: 'a reader owns a copy, lends it overdue, extends it and returns it' },
  { kind: 'recipes', missing: 'Neither signed-in browser proof passes on the clean QA profile: recipe-authoring expects a missing “As written” reader radio; recipe-exchange expects ASCII fractions but the editor displays ½ and ⅓. The catalogue proofs only read.' },
  { kind: 'visual-novels', file: 'apps/web/tests/partless-progress.e2e.ts',
    test: 'a visual novel with no parts is marked on one phone and seen on the other' },
  { kind: 'anime', file: 'apps/web/tests/tracking-media.e2e.ts',
    test: 'identified anime watched progress resumes across devices and rejects stale updates' },
  { kind: 'manga', file: 'apps/web/tests/tracking-media.e2e.ts',
    test: 'identified manga chapter progress resumes across volumes and devices' },
  { kind: 'games', file: 'apps/web/tests/tracking-media.e2e.ts',
    test: 'game progress resumes across required and extra routes and a partless game on another device' },
  { kind: 'realm', file: 'apps/web/tests/realm-create.e2e.ts',
    test: 'Each privacy choice opens a Realm that reads as chosen, with an empty discussion list for its founder' },
  // Site publication currently returns 400; the steward's attachment lifecycle exercises a separate signed-in main path.
  { kind: 'zone', file: 'apps/web/tests/zone-realm-attachment.e2e.ts',
    test: 'a Realm steward can attach, list, and withdraw a Zone' },
];

/** Playwright prefixes titles with project/file context; the title itself must match exactly. */
export function verticalJourneyFilter(tests: readonly string[]): string {
  if (!tests.length) throw new Error('A nightly browser batch needs a named journey');
  return `(?:^|\\s)(?:${tests.map(title => title.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|')})$`;
}

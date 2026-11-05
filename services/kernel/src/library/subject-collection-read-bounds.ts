import { declareBound, repeatBound, sumBounds, type Bound } from '@rezics/bounds';
import page from './listing-page.sql';

// listing.ts has already admitted a numeric helper limit; PostgreSQL's generic
// LIMIT bind also accepts string/bigint, which are not this caller's contract.
type PageInput = Omit<Parameters<typeof page.run>[1], 'limit'> & { limit: number };

/** A native pair-seek leaf; Subject admission and FULL disclosure are enclosing work. */
export type SubjectCollectionPairPlan = Readonly<{
  kind: 'subject.collections.pairs';
  input: Readonly<PageInput>;
  total: Bound;
}>;

// UUIDs are 36 characters, route/multiplicity are PostgreSQL int4, and the
// timestamp projection allows PostgreSQL's full range, zone and BC suffix.
// Escaped JSON also bounds the positional SQL response payload.
const projectedPairBytes = Buffer.byteLength(JSON.stringify({
  collectionId: 'f'.repeat(36),
  collectionRoute: -2147483648,
  multiplicity: -2147483648,
  updatedAt: '\0'.repeat(64),
  transactionId: 'f'.repeat(36),
})) + 1;

const bytes = (value: number): Bound => declareBound({
  candidateKeys: 0, nativeRows: 0, identityMetadataRows: 0, nativePoints: 0,
  witnessKeys: 0, statements: 0, bytes: value, emptySeeks: 0, engineRequests: 0,
});

/** Keep the caller's original seek and sentinel, independently of rows returned. */
export function subjectCollectionPairPlan(input: PageInput): SubjectCollectionPairPlan {
  const original = Object.freeze({ ...input });
  return Object.freeze({
    kind: 'subject.collections.pairs',
    input: original,
    total: sumBounds(
      declareBound({
        candidateKeys: input.limit,
        // The subject-leading positive-pair index feeds one LIMIT node.
        nativeRows: 2 * input.limit,
        identityMetadataRows: 0,
        nativePoints: 1,
        witnessKeys: 0,
        statements: 1,
        bytes: 0,
        emptySeeks: 1,
        // This leaf dispatches only listing-page.sql, never Search.
        engineRequests: 0,
      }),
      bytes(Buffer.byteLength(page.sql) + Buffer.byteLength(JSON.stringify(original)) + 2),
      repeatBound(bytes(projectedPairBytes), input.limit),
    ),
  });
}

/** Dispatch exactly the frozen operands on the connection owned by listing.ts. */
export function executeSubjectCollectionPairs(
  client: Parameters<typeof page.run>[0],
  plan: SubjectCollectionPairPlan,
): ReturnType<typeof page.run> {
  return page.run(client, plan.input);
}

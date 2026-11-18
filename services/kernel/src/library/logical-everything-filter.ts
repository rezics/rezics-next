import { createHash } from 'node:crypto';
import canonicalize from 'canonicalize';
import type { AuthoritativeTime } from '../command/command.ts';
import { readCataloguePointEvidence } from '../semantic/scope-leaf-evidence.ts';
import { ProblemError } from '../http/problem-error.ts';
import { matchOwnerFilterCatalogue, type CollectionMemberAdmission } from './owner-filter.ts';
import type { PresentationDependencies } from './collection-presentation.ts';
import type { AccountActor } from '../request/access.ts';

const digest = (value: unknown) => createHash('sha256').update(canonicalize(value)!).digest('hex');
// Each of at most two entry windows admits one scalar selection and its real Subject authority per original.
// The Access-key ceiling also covers the native account membership-inverse lookup, independently of statement keys.
const rangeWork = Object.freeze({
  keys: 32,
  witnesses: 16,
  points: 256,
  rows: 2048,
  emptySeeks: 128,
  bytes: 64 * 1024,
});
const authorityWork = Object.freeze({
  keys: 4096,
  witnesses: 100,
  points: 4096,
  rows: 65536,
  emptySeeks: 256,
  bytes: 1024 * 1024,
});

type CatalogueLeaf = Extract<NonNullable<CollectionMemberAdmission['plan']>['leaves'][number], { kind: 'catalogue' }>;

/** Original native complete selection, including a negative and its ordered witnesses. The caller
 * must admit every SQL literal on the page ledger; a partially selected positive is unavailable. */
export async function readEverythingFilterTuple(
  deps: PresentationDependencies & { actor: AccountActor; routeKey: Uint8Array; deadline: number },
  at: AuthoritativeTime,
  id: string,
  leaf: CatalogueLeaf,
  report?: (reason: string) => void,
) {
  const { evidence, readinessReason } = await readCataloguePointEvidence(
    deps.pool,
    {
      subject: id,
      leaf: leaf.clause,
      after: null,
      revalidate: null,
      budget: rangeWork,
    },
    { ...deps, nativeT: at },
    authorityWork,
  );
  if (evidence.state !== 'current') {
    report?.(readinessReason ?? evidence.state);
    throw new ProblemError('semantic_not_ready');
  }
  if (evidence.progress || evidence.coverage?.basis !== evidence.basis) throw new ProblemError('semantic_not_ready');
  const matches = matchOwnerFilterCatalogue(leaf, evidence);
  if (typeof matches !== 'boolean') throw new ProblemError('semantic_not_ready');
  return { id, visible: true, matches, evidence: digest([evidence.basis, evidence.facts]) };
}

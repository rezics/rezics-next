import { MAX_SUMMARY_BATCH } from '../media/summary.ts';
import type { WorkActivationEnvironment } from '../work/activate.ts';
import { targetRead, targetSummaries } from './resolve.ts';

/** The caller's authority: the same principal, Access registry and acting subject a target read takes. */
export type ReferenceAuthority = Parameters<typeof targetRead>[1];

/** Which of `references` the caller may read after the target reader and then `canRead` (the semantic reader). */
export type ReferenceDisclosure = (references: readonly string[]) => Promise<ReadonlySet<string>>;

export const DISCLOSED_REFERENCE_COST = { targetReads: 1, summaryBatch: MAX_SUMMARY_BATCH,
  /** Distinct references beyond one summary batch each add one page inside the same target read: a relation write
   * names at most 64 participants, 16 roles of 8 members and 8 applicability coordinates. */
  maxPages: 4 } as const;

/**
 * One rule for every reference a typed coordinate may name: Structure positions, releases, classification
 * Concepts, Works and semantic Resources. The target reader owns what each type discloses, so it resolves them
 * in one batch. What it does not disclose is not thereby readable, and not thereby hidden: the semantic reader
 * still decides it. A hidden and a missing reference look the same to the target reader.
 * Cost: one target read of at most ceil(distinct/64) summary pages (at most four); never one per reference.
 */
export async function targetDisclosed(env: WorkActivationEnvironment, authority: ReferenceAuthority,
  references: readonly string[]): Promise<ReadonlySet<string>> {
  const distinct = [...new Set(references)];
  if (!distinct.length) return new Set();
  if (distinct.length > DISCLOSED_REFERENCE_COST.summaryBatch * DISCLOSED_REFERENCE_COST.maxPages) {
    throw new RangeError('reference disclosure batch exceeds its bound');
  }
  return targetRead(env, authority, async session => {
    const disclosed = new Set<string>();
    for (let offset = 0; offset < distinct.length; offset += DISCLOSED_REFERENCE_COST.summaryBatch) {
      const page = await targetSummaries(session, distinct.slice(offset, offset + DISCLOSED_REFERENCE_COST.summaryBatch));
      for (const summary of page.summaries) if (summary.status === 'available') disclosed.add(summary.reference);
    }
    return disclosed;
  });
}

/** Writer side: the references the target reader did not disclose, for the semantic and Work readers' refusal,
 * which is the one indistinct outcome a hidden or missing reference gets. Order and duplicates follow the input. */
export async function undisclosedReferences(env: WorkActivationEnvironment, authority: ReferenceAuthority,
  references: readonly string[]): Promise<string[]> {
  const disclosed = await targetDisclosed(env, authority, references);
  return references.filter(ref => !disclosed.has(ref));
}

/** Reader side: the references readable through the target reader or, failing that, `canRead`. */
export function referenceDisclosure(env: WorkActivationEnvironment, authority: ReferenceAuthority,
  canRead: (ref: string) => Promise<boolean>): ReferenceDisclosure {
  return async references => {
    const distinct = [...new Set(references)];
    const disclosed = new Set(await targetDisclosed(env, authority, distinct));
    for (const ref of await readableReferences(distinct.filter(ref => !disclosed.has(ref)), canRead)) disclosed.add(ref);
    return disclosed;
  };
}

/** The references `canRead` admits, or the caller's shared disclosure when it supplies one. A reader without
 * target authority keeps the semantic reader's own decision. */
export async function readableReferences(references: readonly string[], canRead: (ref: string) => Promise<boolean>,
  disclose?: ReferenceDisclosure): Promise<ReadonlySet<string>> {
  if (disclose) return disclose(references);
  const checked = await Promise.all([...new Set(references)].map(async ref => await canRead(ref) ? ref : null));
  return new Set(checked.filter((ref): ref is string => ref !== null));
}

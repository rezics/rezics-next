import { readWorkClassificationBatch, WORK_CLASSIFICATION_BATCH_COST } from '../work/read-classifications.ts';
import { visibleConcept } from '../discovery/concepts.ts';
import { iri } from '../work/activate.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

interface PublicTarget { work: string; mainVersion: string }

/** General summaries name resources; Concept search owns public topic eligibility. */
export async function readVisibleOnboardingConcepts(session: WorkReadSession, concepts: readonly string[]) {
  const unique = [...new Set(concepts)];
  if (!unique.length) return new Set<string>();
  const rows = await session.query(`SELECT DISTINCT ?concept WHERE {
    VALUES ?concept { ${unique.map(iri).join(' ')} }
    ${visibleConcept('?concept')}
  } LIMIT ${unique.length + 1}`, unique.length);
  if (rows.some(row => !row.concept || !unique.includes(row.concept.value))) {
    throw new WorkReadUnavailable('Onboarding Concepts are ambiguous');
  }
  return new Set(rows.map(row => row.concept!.value));
}

/** Onboarding consumes the same disclosed acceptance as Work classification pages.
 * Callers supply targets from public Work reads. Consume every continuation:
 * proposals and withheld classifications can fill a page before a visible one. */
export async function readOnboardingClassifications(session: WorkReadSession, targets: readonly PublicTarget[]) {
  const unique = [...new Map(targets.map(target => [target.work, target])).values()];
  if (targets.some(target => unique.find(own => own.work === target.work)!.mainVersion !== target.mainVersion)) {
    throw new WorkReadUnavailable('Onboarding Work bases are ambiguous');
  }
  const concepts = new Map<string, Set<string>>();
  for (let start = 0; start < unique.length; start += WORK_CLASSIFICATION_BATCH_COST.works) {
    const own = unique.slice(start, start + WORK_CLASSIFICATION_BATCH_COST.works);
    const names = await session.summaries(own.map(target => target.work));
    let pending = new Map<string | undefined, PublicTarget[]>([[undefined, own.filter((target, index) =>
      names[index]?.status === 'available' && names[index]?.type === 'work' && names[index]?.disclosure === 'public')]]);
    while (pending.size) {
      const next = new Map<string | undefined, PublicTarget[]>();
      for (const [after, pageTargets] of pending) {
        const batch = await readWorkClassificationBatch(session, pageTargets, undefined, after);
        for (const target of pageTargets) {
          const page = batch.get(target.work)!;
          const visible = concepts.get(target.work) ?? new Set<string>();
          for (const item of page.items) visible.add(item.concept);
          concepts.set(target.work, visible);
          if (page.after) next.set(page.after, [...next.get(page.after) ?? [], target]);
        }
      }
      pending = next;
    }
    for (const name of await session.summaries(own.map(target => target.work))) {
      if (name.status !== 'available' || name.type !== 'work' || name.disclosure !== 'public') concepts.delete(name.reference);
    }
  }
  const visible = await readVisibleOnboardingConcepts(session, [...new Set([...concepts.values()].flatMap(values => [...values]))]);
  for (const values of concepts.values()) {
    for (const concept of values) if (!visible.has(concept)) values.delete(concept);
  }
  return concepts;
}

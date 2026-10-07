import { readWorkClassificationBatch, WORK_CLASSIFICATION_BATCH_COST } from '../work/read-classifications.ts';
import { WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';

interface PublicTarget { work: string; mainVersion: string }

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
  return concepts;
}

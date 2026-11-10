import { advanceCollectionSourceWork } from '../../../src/library/collection-source-work.ts';
import type { WorkContext } from '../../../src/work/registry.ts';

/** Complete finite fixture setup through the native owner, without manufacturing readiness or membership. */
export async function prepareCollectionSource(context: WorkContext, accountId: string, collectionId: string) {
  for (let step = 0; step < 100; step++) {
    const result = await advanceCollectionSourceWork(context, { accounts: [accountId], collectionId });
    if (result === 'ready') return;
    if (result === 'unavailable') throw new Error(`Collection fixture native Source unavailable: ${collectionId}`);
  }
  throw new Error(`Collection fixture native Source preparation did not complete: ${collectionId}`);
}

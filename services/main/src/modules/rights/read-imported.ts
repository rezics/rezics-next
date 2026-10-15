import { resourceFactMaterial, RightsInvalid, RightsUnavailable, type WikiDisplayObligations } from './store.ts';
import { WorkReadMissing, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { hash } from '../work/activate.ts';

/** Credits are delivery requirements, so they cannot disappear as an optional
 * card preview during an owner outage. Read only the selected page, in batches. */
export async function readFactObligations(session: WorkReadSession, works: readonly string[]) {
  const result = new Map<string, WikiDisplayObligations>();
  const store = session.deps.rights?.store;
  for (let start = 0; start < works.length; start += 64) {
    const ids = works.slice(start, start + 64);
    if (!store) {
      for (const work of ids) result.set(work, { status: 'unassessed' });
      continue;
    }
    const read = () => store.currentWikiDisplayObligations(ids.map(resourceFactMaterial));
    try {
      const rights = await read();
      session.observeDependency(`fact-obligations:${JSON.stringify(ids)}`, rights, read);
      ids.forEach((work, index) => result.set(work, rights[index] ?? { status: 'unassessed' }));
    } catch (error) {
      if (error instanceof RightsInvalid || error instanceof RightsUnavailable)
        throw new WorkReadUnavailable('Source attribution is unavailable', { cause: error });
      throw error;
    }
  }
  return result;
}

/** Recipe exports include the Work's imported ingredients and instructions.
 * Preserve the export-use basis, and close it at the session's delivery cut. */
export async function readImportedExportBases(session: WorkReadSession, work: string, revision: string) {
  const store = session.deps.rights?.store;
  if (!store) throw new WorkReadUnavailable('Export rights are unavailable');
  const read = () => store.exportScope([{ sourceOwner: 'graph', sourceNamespace: 'product', sourceGrain: 'work',
    exactRef: revision, contentRevisionId: null, refDigest: hash(revision),
    ownerDataEpoch: session.position.dataEpoch, ownerSequence: session.position.sequence, sourcePosition: null,
    targetGrain: 'work', mapping: 'exact', data: { rightsIdentity: { material: resourceFactMaterial(work),
      target: { owner: 'graph', resource: work, component: 'record', revision } } } }], 'full');
  const bases = await read();
  if (bases.some(basis => basis.result === 'prohibited')) throw new WorkReadMissing('Recipe export is unavailable');
  session.observeDependency(`imported-export-rights:${work}:${revision}`, bases, read);
  return bases;
}

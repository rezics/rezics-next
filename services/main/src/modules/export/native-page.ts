import type { WorkReadSession } from '../work/read-session.ts';
import { readCompositionHeader, CompositionUnavailable } from '../structure/graph.ts';
import { readCompositionPage, readStructureMeasures } from '../structure/read.ts';
import { structureProfileFor } from '../structure/profiles.ts';
import { compositionTargetBatchReader } from '../composition/disclosure-read.ts';
import { readImportedExportBases } from '../rights/read-imported.ts';
import { isExactNativeSelection, readNativeSelections, type NativeSelection } from './selections.ts';

export const NATIVE_EXPORT_PAGE_SIZE = 64;

/** Exact sibling cuts share the Structure owner's order and disclosure. A
 * selected document gets its own page to preserve Content's response bound. */
export async function readNativeExportPage(session: WorkReadSession, input: {
  structure: string; revision: string; work: string; actingSubject: string; parent?: string; after?: string;
}, hydrate?: (records: readonly import('../structure/format.ts').OccurrenceRecord[]) => Promise<NativeSelection[]>) {
  const { structure, revision } = input;
  const header = await readCompositionHeader(session.deps.environment, structure);
  if (!header) throw new CompositionUnavailable('Composition is unavailable');
  const profile = structureProfileFor(header.profile);
  const parent = input.parent ?? structure;
  const canReadTargets = compositionTargetBatchReader(session, profile);
  const read = (limit: number) => readCompositionPage(session.deps.environment, {
    structure, revision, parent, after: input.after, limit, canReadTargets,
    canReadTarget: async target => (await canReadTargets([target])).has(target),
    canReadOccurrence: record => Promise.resolve(isExactNativeSelection(record)),
  });
  let page = await read(NATIVE_EXPORT_PAGE_SIZE);
  if (page.occurrences.some(isExactNativeSelection)) page = await read(1);
  const selections = await (hydrate ? hydrate(page.occurrences) : readNativeSelections(session,page.occurrences));
  const contents = [...new Map(selections.flatMap(item => item.document || item.text !== undefined
    ? [[JSON.stringify(item.reference), { reference: item.reference,
      ...(item.document ? { document: item.document } : { body: item.text }) }] as const] : [])).values()];
  return { profile: 'native-export-page-v1' as const, structure, revision, parent, next: page.next ?? null,
    occurrences: page.occurrences, selections, contents,
    containers: page.occurrences.filter(record => (profile.containerRoles ?? ['group']).includes(record.role))
      .map(record => record.occurrence),
    measures: (await readStructureMeasures(session.deps.environment, { structure, revision })).measures,
    rights: [...await readImportedExportBases(session, input.work, revision)],
    cost: { pagesRead: page.cost.pagesRead, occurrences: page.occurrences.length } };
}

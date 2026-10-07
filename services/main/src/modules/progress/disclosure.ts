import { ObjectIntegrityError, ObjectUnavailable, type ImmutableObjects } from '../../infrastructure/immutable-objects.ts';
import { collectionTargetBatchReader } from '../composition/visible-targets.ts';
import { compositionSummaryReader, compositionTargetReader } from '../composition/disclosure-read.ts';
import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { readResourceSummaries, SummaryGraphMoved } from '../media/summary.ts';
import { recordTree, structureObjects } from '../structure/change.ts';
import { checkOccurrenceRecord, checkStructureManifest, InvalidStructureObject, STRUCTURE_LIMITS,
  type OccurrenceRecord } from '../structure/format.ts';
import { type CompositionHeader } from '../structure/graph.ts';
import { isCatalogTarget, structureProfileFor, type StructureProfileRegistration } from '../structure/profiles.ts';
import { newCost, StructureObjectCorrupt, StructureObjectUnavailable } from '../structure/tree.ts';
import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadInvalid, WorkReadMoved, WorkReadUnavailable, type WorkReadSession } from '../work/read-session.ts';
import { STRUCTURE_PROGRESS_COST, type StructureProgress } from './store.ts';

export const PROGRESS_DISCLOSURE_COST = {
  rows: STRUCTURE_PROGRESS_COST.pageRows - 1,
  pages: 2 + (STRUCTURE_PROGRESS_COST.pageRows - 1) * (STRUCTURE_LIMITS.treeLevels - 1),
  bytes: 16 * 1024 * 1024,
} as const;

function boundedObjects(session: WorkReadSession): ImmutableObjects {
  const source = structureObjects(session.deps.environment);
  const pages = new Map<string, Promise<Uint8Array>>();
  let bytesLeft = PROGRESS_DISCLOSURE_COST.bytes;
  return {
    put: async () => { throw new WorkReadUnavailable('Progress disclosure is read only'); },
    get: async digest => {
      session.checkDeadline();
      if (!pages.has(digest)) {
        if (pages.size >= PROGRESS_DISCLOSURE_COST.pages) throw new WorkReadUnavailable('Progress disclosure page budget exceeded');
        pages.set(digest, (async () => {
          try {
            const bytes = await source.get(digest);
            session.checkDeadline();
            bytesLeft -= bytes.length;
            if (bytesLeft < 0) throw new WorkReadUnavailable('Progress disclosure byte budget exceeded');
            return bytes;
          } catch (error) {
            if (error instanceof ObjectUnavailable) throw new StructureObjectUnavailable(error.message);
            if (error instanceof ObjectIntegrityError) throw new StructureObjectCorrupt(error.message);
            throw error;
          }
        })());
      }
      return pages.get(digest)!;
    },
  };
}

async function visibleTargets(session: WorkReadSession, profile: StructureProfileRegistration, targets: string[]) {
  if (!targets.length) return new Set<string>();
  if (profile.id === 'work-composition' || profile.id === 'collection-membership') {
    return collectionTargetBatchReader(session)(targets);
  }
  if (profile.id === 'book-composition') {
    try {
      const result = await readResourceSummaries(session.deps.environment, session.deps.media?.store,
        compositionSummaryReader(session), { resources: targets, context: DEFAULT_MEDIA_CONTEXT,
          language: null, languages: session.displayLanguages, includeCollections: true });
      if (result.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
        throw new WorkReadMoved('Progress targets changed during disclosure');
      }
      return new Set(result.summaries.filter(summary => summary.status === 'available').map(summary => summary.reference));
    } catch (error) {
      if (error instanceof SummaryGraphMoved) throw new WorkReadMoved(error.message);
      throw error;
    }
  }
  const read = compositionTargetReader(session, profile), visible = new Set<string>();
  for (const target of targets) if (await read(target)) visible.add(target);
  return visible;
}

/** Match exact current public eligibility, including fixed pins. An immutable
 * occurrence's pin alone does not authorize a withdrawn or erased revision. */
export async function publishedProgressSelections(session: WorkReadSession,
  selections: readonly { target: string; revision: string }[]): Promise<ReadonlySet<string>> {
  if (selections.length > PROGRESS_DISCLOSURE_COST.rows) throw new WorkReadInvalid('Progress selection batch is invalid');
  const wanted = new Map(selections.map(pair => [`${pair.target}\0${pair.revision}`, pair]));
  const published = new Set<string>();
  if (!wanted.size) return published;
  const pairs = [...wanted.values()];
  const pins = await session.query(`# progress:published-selections
    SELECT DISTINCT ?target ?revision WHERE {
      VALUES (?target ?revision) { ${pairs.map(pair => `(${iri(pair.target)} ${iri(pair.revision)})`).join(' ')} }
      GRAPH ${iri(GRAPHS.current)} { ?variant a rv:ContentVariant ; rv:resource ?target ;
        rv:contentPublicationHead ?decision ; rv:publicSearchEligibilityHead ?eligibility . }
      GRAPH ${iri(GRAPHS.revisions)} { ?decision rv:contentRevision ?revision .
        ?eligibility a rv:ContentSearchEligibilityDecision ; rv:publicationDecision ?decision ; rv:disclosure rv:Public . }
      FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
    } LIMIT ${pairs.length + 1}`, pairs.length);
  for (const pin of pins) {
    const key = `${pin.target?.value}\0${pin.revision?.value}`;
    if (!wanted.has(key)) throw new WorkReadUnavailable('Progress publication selection is unavailable');
    published.add(key);
  }
  return published;
}

/** Only rows passing current occurrence and selection disclosure leave the
 * owner read. One bulk immutable lookup shares each ancestor page; inventory
 * size, ordinals and whole-composition reads never enter this check. */
export async function disclosedCompletedProgress(session: WorkReadSession, header: CompositionHeader,
  rows: readonly StructureProgress[], authorize: typeof visibleTargets = visibleTargets): Promise<StructureProgress[]> {
  if (rows.length > PROGRESS_DISCLOSURE_COST.rows || rows.some(row => row.structure !== header.structure)) {
    throw new WorkReadInvalid('Progress disclosure batch is invalid');
  }
  if (!rows.length) return [];
  const objects = boundedObjects(session), profile = structureProfileFor(header.profile);
  let manifest;
  try { manifest = checkStructureManifest(await objects.get(header.manifest.slice(-64))); }
  catch (error) {
    if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
    throw error;
  }
  if (manifest.structure !== header.structure || manifest.structureOf !== header.component
    || manifest.profile !== header.profile || manifest.generation !== header.generation
    || manifest.placementCount !== header.placementCount) {
    throw new StructureObjectCorrupt('Progress occurrence manifest differs from selected generation');
  }
  const found = await recordTree(objects).lookup(manifest.records,
    [...new Set(rows.map(row => row.occurrence))], newCost());
  const records = new Map<string, OccurrenceRecord>();
  for (const row of rows) {
    session.checkDeadline();
    const record = found.get(row.occurrence);
    if (!record) continue;
    try { checkOccurrenceRecord(record, header.profile, profile.catalogTargetTypes,
      profile.selectionRequiredRoles ?? profile.targetRoles, profile.selectionOptionalRoles); }
    catch (error) {
      if (error instanceof InvalidStructureObject) throw new StructureObjectCorrupt(error.message);
      throw error;
    }
    if (profile.targetRoles.includes(record.role) && record.target) records.set(record.occurrence, record);
  }
  const targets = [...new Set([...records.values()].flatMap(record => record.target
    && !isCatalogTarget(profile, record.target) ? [record.target] : []))];
  const readable = await authorize(session, profile, targets);
  const disclosed = new Map([...records].filter(([, record]) => isCatalogTarget(profile, record.target!) || readable.has(record.target!)));
  const selections = new Map<string, { target: string; revision: string }>();
  for (const row of rows) {
    const record = disclosed.get(row.occurrence);
    if (row.selectedRevision && (record?.selection?.mode === 'follow-context'
      || record?.selection?.mode === 'fixed-revision' && record.selection.revision === row.selectedRevision)) {
      selections.set(`${record.target}\0${row.selectedRevision}`, { target: record.target!, revision: row.selectedRevision });
    }
  }
  const published = await publishedProgressSelections(session, [...selections.values()]);
  return rows.filter(row => {
    const record = disclosed.get(row.occurrence);
    if (!record) return false;
    if (!row.selectedRevision) return true;
    const selected = record.selection?.mode === 'follow-context'
      || record.selection?.mode === 'fixed-revision' && record.selection.revision === row.selectedRevision;
    return selected && published.has(`${record.target}\0${row.selectedRevision}`);
  });
}

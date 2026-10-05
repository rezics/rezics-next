import { GRAPHS, iri } from '../work/activate.ts';
import { WorkReadMoved } from '../work/read-session.ts';
import { targetSummaries, type TargetReadSession } from '../target/resolve.ts';
import { MAX_PAGE, type ProjectionView } from './schema.ts';
import type { ProjectionStore } from './store.ts';
import { resolveProjection } from './validate.ts';

/** The visible projections among ids, in input order. A projection is visible when the reader can read its subject
 * and every frame (its summary is available), and its disclosure is the most restrictive of them. One summary
 * batch (with its part pages) and one exact-head query, independent of how much exists about any of them. */
export async function readProjectionViews(session: TargetReadSession, ids: readonly string[]): Promise<ProjectionView[]> {
  if (!ids.length) return [];
  const batch = await targetSummaries(session, ids);
  if (batch.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
    throw new WorkReadMoved('Graph changed during projection hydration');
  }
  const available = batch.summaries.flatMap(summary =>
    summary.status === 'available' && summary.type === 'projection' && summary.parts ? [summary] : []);
  if (!available.length) return [];
  const rows = await session.query(`SELECT ?p ?revision WHERE {
    VALUES ?p { ${available.map(summary => iri(summary.reference)).join(' ')} }
    GRAPH ${iri(GRAPHS.current)} { ?p a rv:Projection ; rv:projectionHead ?revision }
    GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ProjectionRevision ; rv:component ?p }
    FILTER NOT EXISTS { GRAPH ${iri(GRAPHS.revisions)} { ?revision a rv:ErasedRevision } }
  } LIMIT ${available.length + 1}`, available.length);
  const heads = new Map(rows.flatMap(row => row.p && row.revision ? [[row.p.value, row.revision.value] as const] : []));
  return available.flatMap(summary => {
    const revision = heads.get(summary.reference);
    return revision && summary.parts ? [{ id: summary.reference, subject: summary.parts.subject.reference,
      frames: summary.parts.frames.map(frame => frame.reference), revision, disclosure: summary.disclosure }] : [];
  });
}

/** The one projection of a subject in exactly these frames, without creating it. A request the reader could not
 * have created (unreadable, not a frame) finds nothing, so it reveals nothing about private subjects. */
export async function lookupProjection(session: TargetReadSession, store: Pick<ProjectionStore, 'lookup'>,
  input: { subject: string; frames: readonly string[] }): Promise<ProjectionView | null> {
  let key;
  try { key = await resolveProjection(session, input); }
  catch (error) { if (error instanceof Error && 'refusal' in error) return null; throw error; }
  const id = await store.lookup(key.key);
  return id ? (await readProjectionViews(session, [id]))[0] ?? null : null;
}

/** One page of visible projections, oldest first. Check selectors before probing their identity inventory.
 * Seek through P+1 owner batches under the read session's graph/deadline budgets; only a disclosed
 * lookahead can establish continuation, and only a delivered identity can be its cursor. */
export async function listProjections(session: TargetReadSession, store: Pick<ProjectionStore, 'list' | 'listByFrame'>,
  input: { subject?: string; frame?: string; cursor: string | null; limit: number }): Promise<{ items: ProjectionView[]; nextCursor: string | null }> {
  const selectors = [input.subject, input.frame].filter((ref): ref is string => ref !== undefined);
  if (!selectors.length) throw new Error('Projection listing requires a subject or frame');
  const selected = await targetSummaries(session, selectors);
  if (selected.generation.graph !== `${session.position.dataEpoch}:${session.position.sequence}`) {
    throw new WorkReadMoved('Graph changed during projection selector hydration');
  }
  if (selectors.some(ref => !selected.summaries.some(summary => summary.reference === ref && summary.status === 'available'))) {
    return { items: [], nextCursor: null };
  }
  const limit = Math.min(Math.max(input.limit, 1), MAX_PAGE);
  const batchSize = limit + 1;
  const visible: ProjectionView[] = [];
  let after = input.cursor;
  while (visible.length <= limit) {
    session.checkDeadline();
    const ids = input.frame !== undefined
      ? await store.listByFrame(input.frame, input.subject, after, batchSize)
      : await store.list(input.subject!, after, batchSize);
    visible.push(...(await readProjectionViews(session, ids)).filter(view =>
      (input.subject === undefined || view.subject === input.subject)
      && (input.frame === undefined || view.frames.includes(input.frame))));
    if (ids.length < batchSize || visible.length > limit) break;
    after = ids.at(-1)!.slice(-36);
  }
  const items = visible.slice(0, limit);
  return { items, nextCursor: visible.length > limit ? items.at(-1)!.id.slice(-36) : null };
}

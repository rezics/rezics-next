import { DEFAULT_MEDIA_CONTEXT } from '../media/store.ts';
import { readResourceSummaries } from '../media/summary.ts';
import { resolveTargets, targetSummaryReader, TargetNotBound, TargetUnavailable,
  type TargetReadSession } from '../target/resolve.ts';
import { coordinateOf } from './dimension.ts';
import { MAX_FRAMES, ProjectionRefused, projectionKey, type ProjectionKey } from './schema.ts';

export interface ResolvedProjection extends ProjectionKey {
  /** Public only when the subject and every frame are public. */
  disclosure: 'public' | 'restricted';
}

/** The canonical subject of a request: readable to this reader, a Resource and never a Projection.
 * A merged identity names its survivor, so a new projection attaches to the identity that remains. */
export async function resolveSubject(session: TargetReadSession, subject: string) {
  const [summary] = (await readResourceSummaries(session.deps.environment, session.deps.media?.store,
    targetSummaryReader(session), { resources: [subject], context: DEFAULT_MEDIA_CONTEXT, includeCollections: true,
      language: session.options.language?.toLowerCase() ?? null, languages: session.displayLanguages })).summaries;
  if (summary?.status !== 'available') throw new ProjectionRefused('subject-unavailable', 'Subject is unavailable');
  if (summary.type === 'projection') throw new ProjectionRefused('subject-is-projection', 'A projection of a projection does not exist');
  return { subject: summary.resolution?.survivor ?? summary.reference, disclosure: summary.disclosure };
}

/** Validate "subject within frames" for one reader and fix its identity key. Each frame resolves through the
 * shared target resolver to a grain or type with a dimension, at most one frame per dimension. The cost is one
 * subject summary and one target batch of at most MAX_FRAMES, independent of what exists about either. */
export async function resolveProjection(session: TargetReadSession,
  input: { subject: string; frames: readonly string[] }): Promise<ResolvedProjection> {
  // Structure first, so a malformed request never reaches the graph.
  projectionKey(input.subject, input.frames);
  const subject = await resolveSubject(session, input.subject);
  let targets;
  try { targets = await resolveTargets(session, input.frames, 'report'); }
  catch (error) {
    if (error instanceof TargetUnavailable) throw new ProjectionRefused('frame-unavailable', 'A frame is unavailable');
    if (error instanceof TargetNotBound) throw new ProjectionRefused('frame-not-coordinate', 'A frame has no dimension');
    throw error;
  }
  const dimensions = new Set<string>();
  for (const target of targets) {
    const coordinate = coordinateOf(target);
    if (!coordinate) throw new ProjectionRefused('frame-not-coordinate', 'A frame has no dimension');
    if (dimensions.has(coordinate.dimension)) {
      throw new ProjectionRefused('frame-dimension-repeated', 'A frame set has at most one frame per dimension');
    }
    dimensions.add(coordinate.dimension);
  }
  if (targets.length > MAX_FRAMES) throw new ProjectionRefused('invalid', 'Too many frames');
  return { ...projectionKey(subject.subject, targets.map(target => target.resource)),
    disclosure: subject.disclosure === 'public' && targets.every(target => target.disclosure === 'public')
      ? 'public' : 'restricted' };
}

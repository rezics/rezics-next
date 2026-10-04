import { resolveTargets, targetSummaries, TargetNotBound, TargetUnavailable,
  type TargetReadSession } from '../target/resolve.ts';
import { coordinateOf, FrameRefused, normalizeFrame, type Coordinate } from './dimension.ts';
import { MAX_FRAMES, ProjectionRefused, projectionKey, type ProjectionKey } from './schema.ts';

export interface ResolvedProjection extends ProjectionKey {
  /** Public only when the subject and every frame are public. */
  disclosure: 'public' | 'restricted';
}

/** The canonical subject of a request: readable to this reader, a Resource and never a Projection.
 * A merged identity names its survivor, so a new projection attaches to the identity that remains. */
async function resolveSubject(session: TargetReadSession, subject: string) {
  const [summary] = (await targetSummaries(session, [subject], { resolveMerges: true, includeCollections: true })).summaries;
  if (summary?.status !== 'available') throw new ProjectionRefused('subject-unavailable', 'Subject is unavailable');
  if (summary.type === 'projection') throw new ProjectionRefused('subject-is-projection', 'A projection of a projection does not exist');
  return { subject: summary.resolution?.survivor ?? summary.reference, disclosure: summary.disclosure };
}

/** Validate "subject within frames" for one reader and fix its identity key. Each frame resolves through the
 * shared target resolver to a grain or type with a dimension. The frames are normalized to one coordinate per
 * slot, all in one Work (`normalizeFrame`), so one "subject in F" has one key however a caller spells F. The cost is
 * one subject summary and one target batch of at most MAX_FRAMES, independent of what exists about either. */
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
  const coordinates = targets.map(target => {
    const coordinate = coordinateOf(target);
    if (!coordinate) throw new ProjectionRefused('frame-not-coordinate', 'A frame has no dimension');
    return coordinate;
  });
  let normalized: Coordinate[];
  try { normalized = normalizeFrame(coordinates); }
  catch (error) {
    if (!(error instanceof FrameRefused)) throw error;
    throw error.reason === 'slot-repeated'
      ? new ProjectionRefused('frame-slot-repeated', 'A frame set has at most one frame per slot')
      : new ProjectionRefused('frame-work-mismatch', 'The frames of one projection lie in one Work');
  }
  const kept = new Set(normalized.map(coordinate => coordinate.iri));
  const named = targets.filter(target => kept.has(target.resource));
  if (targets.length > MAX_FRAMES) throw new ProjectionRefused('invalid', 'Too many frames');
  return { ...projectionKey(subject.subject, named.map(target => target.resource)),
    disclosure: subject.disclosure === 'public' && named.every(target => target.disclosure === 'public')
      ? 'public' : 'restricted' };
}

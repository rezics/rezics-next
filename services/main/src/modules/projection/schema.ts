import { createHash } from 'node:crypto';
import { t } from 'elysia';
import type { Static } from 'typebox';
import { sourcePosition } from '../../api-contract.ts';
import { readId, readLanguage, readPosition, readUuid } from '../work/read-contract.ts';

export const PROJECTION_PROFILE = 'https://rezics.com/definition/projection-v1';
export const PROJECTION_ACTION = 'projection.create';
export const PROJECTION_FAMILY = 'projection-create-v1';
/** One gate for every creation, as for Work and Space: any admitted Person may create a projection. */
export const PROJECTION_SCOPE = 'projection:create:root';
/** A projection exists to be rated, reviewed or discussed, so its creation asks for the coarsest of those consents. */
export const PROJECTION_WRITE_SCOPE = 'rating:submit';
export const MAX_FRAMES = 8;
export const MAX_PAGE = 20;

/** Output and owner-batch ceilings, independent of the total inventory. A list batch includes one
 * lookahead: at most 21 * 9 = 189 parts, or three summary pages of 64. Hidden candidates can require
 * additional batches; the read session's graph, byte and deadline budgets bound the whole request. */
export const PROJECTION_COST = {
  /** Subject summary, one target batch for the frames, one admission probe, one identity lookup and one
   * projection summary (itself one page of parts). */
  existingReads: { summaries: 2, targetBatches: 1, admissionProbes: 1, identityLookups: 1 },
  /** Admission register, claim and seal, one identity insert and one guarded graph command. */
  creationWrites: { admissionTransactions: 3, identityInserts: 1, graphCommands: 1 },
  listPage: MAX_PAGE, listLookahead: 1, partsPerProjection: MAX_FRAMES + 1,
  listSelectors: 2, identityReadsPerBatch: 1, frameMembershipsPerIdentity: MAX_FRAMES,
  partPagesPerListPage: Math.ceil((MAX_PAGE + 1) * (MAX_FRAMES + 1) / 64),
} as const;

const nativeId = /^https:\/\/rezics\.com\/id\/[0-9a-f-]{36}$/;

export type ProjectionRefusal = 'invalid' | 'subject-unavailable' | 'subject-is-projection'
  | 'frame-unavailable' | 'frame-not-coordinate' | 'frame-slot-repeated' | 'frame-work-mismatch';
const refusals: Record<ProjectionRefusal, { status: 400 | 404 | 422; code: string }> = {
  invalid: { status: 400, code: 'invalid_projection' },
  'subject-unavailable': { status: 404, code: 'projection_subject_unavailable' },
  'subject-is-projection': { status: 422, code: 'projection_of_projection' },
  'frame-unavailable': { status: 404, code: 'projection_frame_unavailable' },
  'frame-not-coordinate': { status: 422, code: 'projection_frame_not_coordinate' },
  'frame-slot-repeated': { status: 422, code: 'projection_frame_slot_repeated' },
  'frame-work-mismatch': { status: 422, code: 'projection_frame_work_mismatch' },
};
/** A refused request; an unreadable and an absent subject or frame are indistinguishable. */
export class ProjectionRefused extends Error {
  readonly status: 400 | 404 | 422;
  readonly code: string;
  constructor(readonly refusal: ProjectionRefusal, message: string) {
    super(message);
    this.status = refusals[refusal].status;
    this.code = refusals[refusal].code;
  }
}
export class ProjectionUnavailable extends Error {}

export interface ProjectionKey { subject: string; frames: string[]; key: string }

/** The identity of "subject within frames": frames sorted and distinct, hashed with the subject.
 * The Access `projection_identity` table checks the same hash, so a key cannot name another set. */
export function projectionKey(subject: string, frames: readonly string[]): ProjectionKey {
  const sorted = [...frames].sort();
  if (!nativeId.test(subject) || !sorted.length || sorted.length > MAX_FRAMES
    || sorted.some(frame => !nativeId.test(frame)) || new Set(sorted).size !== sorted.length
    || sorted.includes(subject)) {
    throw new ProjectionRefused('invalid', 'A projection names one subject and one to eight distinct frames other than it');
  }
  const key = createHash('sha256').update(`${subject}\n${sorted.join('\n')}`).digest('hex');
  return { subject, frames: sorted, key };
}

/** The retained intent of one creation; the same key and frames bind the same admission digest. */
export function projectionDigest(key: ProjectionKey, actingSubject: string): string {
  return createHash('sha256').update(JSON.stringify([PROJECTION_FAMILY, key.key, actingSubject])).digest('hex');
}

const projectionDisclosure = t.Union([t.Literal('public'), t.Literal('restricted')]);
/** Disclosure is the most restrictive of the subject and every frame. */
export const projectionView = t.Object({ id: readId, subject: readId,
  frames: t.Array(readId, { minItems: 1, maxItems: MAX_FRAMES }), revision: readId,
  disclosure: projectionDisclosure }, { additionalProperties: false });
export type ProjectionView = Static<typeof projectionView>;

export const projectionRequest = t.Object({ subject: readId,
  frames: t.Array(readId, { minItems: 1, maxItems: MAX_FRAMES }), actingSubject: readId },
{ additionalProperties: false });
/** `frame` selects membership; `frames` is the exact-set lookup and requires a subject.
 * A list always has a subject, a frame, or both, never the global identity inventory. */
export const projectionQuery = t.Object({ subject: t.Optional(readId), frame: t.Optional(readId),
  frames: t.Optional(t.Array(readId, { minItems: 1, maxItems: MAX_FRAMES })),
  limit: t.Optional(t.Integer({ minimum: 1, maximum: MAX_PAGE })), cursor: t.Optional(readUuid),
  language: t.Optional(readLanguage), actingSubject: t.Optional(readId) }, { additionalProperties: false });
export const projectionWriteResponse = t.Object({ projection: projectionView, created: t.Boolean(),
  replayed: t.Boolean(), sourcePosition }, { additionalProperties: false });
export const projectionPage = t.Object({ items: t.Array(projectionView, { maxItems: MAX_PAGE }),
  nextCursor: t.Nullable(t.String()), sourcePosition: readPosition },
{ additionalProperties: false });

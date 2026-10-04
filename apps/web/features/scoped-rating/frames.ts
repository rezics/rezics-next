import type { CanonicalAddress } from '@rezics/model/address';
import type { UiLocale } from '../../i18n/define.ts';
import { canonicalHref } from '../address/path.ts';
import type { AvailableSummary, ProjectionView, ResourceSummary } from './types.ts';

// A frame is a coordinate of the subject the rating is about: which episode, match, map or continuity. Main decides
// what may be one (`projection/dimension.ts`); this file only keeps a chosen set honest the way Main will check it.

/** The dimensions Main accepts as frames, in the order a person thinks of them: where in the story, then which telling. */
export const frameDimensions = ['position', 'event', 'continuity', 'work', 'release', 'realization'] as const;
export type FrameDimension = (typeof frameDimensions)[number];

/** Main takes at most eight frames, one per dimension (`MAX_FRAMES`). */
export const MAX_FRAMES = 8;

/** A resource a person can choose as a frame, with the dimension it occupies. */
export interface FrameCandidate {
  iri: string;
  dimension: FrameDimension;
  name: { value: string; language: string; direction: 'ltr' | 'rtl' };
}

/**
 * The chosen frames with `candidate` set in: one coordinate per dimension, so choosing another episode replaces the
 * episode instead of asking Main for a frame set it refuses (`projection_frame_dimension_repeated`).
 */
export function withFrame(frames: readonly FrameCandidate[], candidate: FrameCandidate): FrameCandidate[] {
  const kept = frames.filter(frame => frame.dimension !== candidate.dimension && frame.iri !== candidate.iri);
  return [...kept, candidate].slice(-MAX_FRAMES);
}

export const withoutFrame = (frames: readonly FrameCandidate[], iri: string) => frames.filter(frame => frame.iri !== iri);

/** What a frame is, as far as a summary says: enough to pick an icon, never to name a model word to the reader. */
export type FrameKind = 'work' | 'release' | 'edition' | 'part' | 'other';

export interface FrameChip {
  iri: string;
  kind: FrameKind;
  name: AvailableSummary['name'];
  href: string;
}

function kindOf(type: AvailableSummary['type']): FrameKind {
  return type === 'work' ? 'work' : type === 'release' ? 'release' : type === 'realization' ? 'edition'
    : type === 'occurrence' ? 'part' : 'other';
}

/**
 * The frames of a projection, from the parts of its summary in frame order. Main joins no labels, so each chip is one
 * frame's own name in its own language, linked to its page; the header says what they are for.
 */
export function frameChips(summary: ResourceSummary | undefined, locale: UiLocale): FrameChip[] {
  if (summary?.status !== 'available' || !summary.parts) return [];
  return summary.parts.frames.map(part => ({ iri: part.reference, kind: kindOf(part.type), name: part.name,
    href: canonicalHref(part.address as CanonicalAddress, locale, part.name.value) }));
}

/** The subject of a projection summary, or null where the summary says nothing (unavailable, or not a projection). */
export function subjectOf(summary: ResourceSummary | undefined, locale: UiLocale):
  { iri: string; name: AvailableSummary['name']; href: string; avatar: AvailableSummary['avatar'] } | null {
  if (summary?.status !== 'available' || !summary.parts) return null;
  const { subject } = summary.parts;
  return { iri: subject.reference, name: subject.name, avatar: subject.avatar,
    href: canonicalHref(subject.address as CanonicalAddress, locale, subject.name.value) };
}

/** The projection a Main answer names, keyed by what it is "of": the same subject within the same frames is one. */
export function sameProjection(a: Pick<ProjectionView, 'subject' | 'frames'>, b: Pick<ProjectionView, 'subject' | 'frames'>) {
  const second = [...b.frames].sort();
  return a.subject === b.subject && a.frames.length === second.length
    && [...a.frames].sort().every((frame, index) => frame === second[index]);
}

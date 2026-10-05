import type { CanonicalAddress } from '@rezics/model/address';
import type { UiLocale } from '../../i18n/define.ts';
import { canonicalHref } from '../address/path.ts';
import type { AvailableSummary, ProjectionView, ResourceSummary } from './types.ts';

// A frame is a coordinate of the subject the rating is about: which episode, match, map or continuity. Main decides
// what may be one (`projection/dimension.ts`); this file only keeps a chosen set honest the way Main will check it.

/** The dimensions Main accepts as frames, in the order a person thinks of them: where in the story, then which telling. */
export const frameDimensions = ['position', 'event', 'continuity', 'work', 'release', 'realization'] as const;
export type FrameDimension = (typeof frameDimensions)[number];

/** Main takes at most eight frames (`MAX_FRAMES`), one per slot and all in one Work. */
export const MAX_FRAMES = 8;

/** A resource a person can choose as a frame, with the dimension it occupies. */
export interface FrameCandidate {
  iri: string;
  dimension: FrameDimension;
  /** The Work an episode, chapter, release or edition lies in (a Work's own is itself); absent for a continuity or an event. */
  work?: string;
  name: { value: string; language: string; direction: 'ltr' | 'rtl' };
}

/**
 * What one coordinate of a place holds, as Main counts them (`projection/dimension.ts`): a Work and an episode or chapter
 * share a slot, a release and an edition share another, and every other dimension has its own.
 */
export type FrameSlot = 'structure' | 'edition' | Exclude<FrameDimension, 'work' | 'position' | 'release' | 'realization'>;

export const slotOf = (dimension: FrameDimension): FrameSlot =>
  dimension === 'work' || dimension === 'position' ? 'structure' : dimension === 'release' || dimension === 'realization' ? 'edition' : dimension;

/** The Work a coordinate lies in, where it is known: a Work is its own. */
const workOf = (frame: FrameCandidate) => frame.dimension === 'work' ? frame.iri : frame.work;

/**
 * The chosen frames with `candidate` set in, as Main will accept them: choosing another coordinate of the same slot
 * replaces it, a Work may stay beside one of its own episodes or chapters, and a coordinate in another Work replaces
 * those in the first, so the picker never builds a place Main refuses (`projection_frame_slot_repeated`,
 * `projection_frame_work_mismatch`).
 */
export function withFrame(frames: readonly FrameCandidate[], candidate: FrameCandidate): FrameCandidate[] {
  const work = workOf(candidate);
  const slot = slotOf(candidate.dimension);
  const kept = frames.filter(frame => {
    if (frame.iri === candidate.iri) return false;
    const there = workOf(frame);
    if (work && there && work !== there) return false;
    if (slotOf(frame.dimension) !== slot) return true;
    // A Work and a position of it are the one pair a slot holds.
    return frame.dimension !== candidate.dimension && (frame.dimension === 'work' || candidate.dimension === 'work');
  });
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
  // An episode is named by its label but addressed as Main addresses it, after its Work, so the link needs no redirect.
  return summary.parts.frames.map(part => ({ iri: part.reference, kind: kindOf(part.type), name: part.name,
    href: canonicalHref(part.address as CanonicalAddress, locale, part.type === 'occurrence' ? undefined : part.name.value) }));
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

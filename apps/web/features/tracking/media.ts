// Which progress control a Work gets, and where a reader resumes in it. The kind is the registry
// presentation Main serves for the Work's types; the shape is the Structure the Work actually has.
// A chapter lives on its volume's book, so a series and an omnibus that both place that volume
// mark and resume the same occurrence.

export type Medium = 'episodes' | 'chapters' | 'game';

/** The registry presentation, or null when the registry has not named the Work. */
export function mediumOf(presentation: string | null, structure: { volumes: boolean; chapters: boolean }): Medium {
  if (presentation === 'game') return 'game';
  if (presentation === 'media') return 'episodes';
  if (presentation === 'book' || structure.volumes || structure.chapters) return 'chapters';
  return 'episodes';
}

/** A chapter the positions read already named. Its label is the one Main returned. */
export interface Place {
  structure: string;
  occurrence: string;
  label: string;
}

export interface ChapterRef {
  structure: string;
  occurrence: string;
  /** Its place among the chapters of its volume, or of the book when there is no volume. Counted from 1. */
  number: number;
  label: string | null;
  /** Set when the Work places volumes. `label` is the volume's own name when it has one besides its number. */
  volume: { number: number; label: string | null } | null;
}

/** Chapters in reading order: each volume's chapters, then the next volume. */
export function flattenChapters(volumes: { number: number; label: string | null;
  chapters: { structure: string; occurrence: string; number: number; label: string | null }[] }[]): ChapterRef[] {
  return volumes.flatMap(volume => volume.chapters.map(chapter => ({ ...chapter, volume: volume.number
    ? { number: volume.number, label: volume.label } : null })));
}

/**
 * The chapter the reader resumes at, and the one after it. `furthest` is the occurrence the resume
 * read names; when it names none, the last completed chapter in reading order stands in.
 */
export function resumeAt(chapters: readonly ChapterRef[], furthest: string | null,
  completed: ReadonlySet<string>): { last: ChapterRef | null; next: ChapterRef | null } {
  const named = furthest ? chapters.findIndex(chapter => chapter.occurrence === furthest) : -1;
  let index = named;
  if (index < 0) {
    index = -1;
    chapters.forEach((chapter, at) => { if (completed.has(chapter.occurrence)) index = at; });
  }
  if (index < 0) return { last: null, next: chapters[0] ?? null };
  return { last: chapters[index] ?? null, next: chapters[index + 1] ?? null };
}

export const chapterPosition = (chapter: Pick<ChapterRef, 'number' | 'volume'>) =>
  `chapter:${chapter.volume?.number ?? 0}:${chapter.number}`;

export interface RouteRef {
  structure: string;
  occurrence: string;
  label: string;
  /** Required parts are the game itself. Optional and extra parts are routes beside it. */
  required: boolean;
}

/**
 * Played once any part the read already shows has been started; completed once every part that
 * gates the game is completed. A page that does not cover the parts leaves the game unknown:
 * a part the read did not return is not "not played".
 */
export function gameStatus(routes: readonly { required: boolean; completed: boolean | null; started?: boolean }[],
  exhaustive = true): 'none' | 'played' | 'completed' | 'unknown' {
  if (!routes.length) return 'none';
  const gate = routes.some(route => route.required) ? routes.filter(route => route.required) : routes;
  if (exhaustive && gate.every(route => route.completed === true)) return 'completed';
  if (routes.some(route => route.completed === true || route.started)) return 'played';
  if (!exhaustive || routes.some(route => route.completed === null)) return 'unknown';
  return 'none';
}

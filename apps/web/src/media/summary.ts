import type { CoverSubject, CoverSummary } from '@rezics/ui/cover';

/** The subject summary the kernel embeds in a read; a summary the reader cannot see, or none yet, is null. */
export type SubjectSummary = {
  id: string;
  type: string;
  types?: readonly string[];
  label?: { value: string; language: string } | string | null;
  cover?: CoverSummary | null;
} | null;

/**
 * What `Cover` needs for one subject. The types come from the summary, which carries the structural bases the frame
 * ratio resolves through; a read without a summary falls back to the one type it does carry.
 */
export function coverSubject(
  id: string,
  title: string,
  summary: SubjectSummary | undefined,
  type?: string,
): CoverSubject {
  const types = summary?.types?.length ? summary.types : summary?.type ? [summary.type] : type ? [type] : [];
  return { id, title, types };
}

/** The cover summary of a read that returned one, or null so `Cover` draws its placeholder. */
export function coverOf(summary: SubjectSummary | undefined): CoverSummary | null {
  return summary?.cover ?? null;
}

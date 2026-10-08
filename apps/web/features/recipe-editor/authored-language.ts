import { canonicalLanguage } from '../studio/types.ts';

/**
 * The language a recipe is written in.
 *
 * The Work's label carries the language it was created in. The header title is that
 * label only until metadata records a title; after that the header title is chosen
 * for the reader (requested language, else English, else the first row). A display
 * title never becomes the language new ingredient and step text are tagged with.
 */
export function recipeLanguage(input: {
  /** Language of the Work label, from its resource summary. Null when that read has no name. */
  labelLanguage: string | null;
  /** True when metadata already has a title, so the header title is a display choice. */
  metadataTitles: boolean;
  /** Header title language. Used only while metadata has no title, when that title is the label. */
  headerTitleLanguage: string | null;
}): string | null {
  if (input.labelLanguage) return canonicalLanguage(input.labelLanguage);
  if (!input.metadataTitles && input.headerTitleLanguage) return canonicalLanguage(input.headerTitleLanguage);
  return null;
}

/** The Work label on a resource summary, or null when the summary does not carry one. */
export function labelFromSummary(summary: { status?: string; name?: { value?: string; language?: string } | null } | null | undefined):
  { value: string; language: string } | null {
  if (!summary || summary.status === 'unavailable') return null;
  const value = summary.name?.value?.trim();
  const language = summary.name?.language;
  if (!value || !language) return null;
  return { value, language };
}

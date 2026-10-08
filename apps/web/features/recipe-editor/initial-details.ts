import { detailsValues } from '../studio/details-api.ts';
import type { DetailsValues } from '../studio/details-form.tsx';
import { canonicalLanguage, type WorkMetadata } from '../studio/types.ts';

/** What the loaded Work already holds, beside the metadata rows the form edits. */
export interface RecipeWorkFields {
  /** The Work's own label. A new Work stores its title here and has no metadata row yet. */
  label: { value: string; language: string };
  description: { value: string; language: string } | null;
  tagline: { value: string; language: string } | null;
  originalTitle: { value: string; language: string } | null;
  completionStatus: 'ongoing' | 'completed' | 'hiatus' | null;
  mainVersionLabel: { value: string; language: string } | null;
}

type MetadataLike = {
  localized?: readonly { language: string; title?: string | null; description?: string | null;
    tagline?: string | null; mainVersionLabel?: string | null }[];
  originalTitle?: { value: string; language: string } | null;
  completionStatus?: 'ongoing' | 'completed' | 'hiatus' | null;
} | null;

/** A header field's text when it is already in the recipe's language; otherwise nothing to copy. */
function textIn(field: { value: string; language: string } | null | undefined, language: string): string {
  if (!field) return '';
  const authored = canonicalLanguage(language).toLowerCase();
  return canonicalLanguage(field.language).toLowerCase() === authored ? field.value : '';
}

/**
 * The details the editor opens with. Metadata rows win. Where the authored language has no row yet,
 * the Work's label and the other header fields in that language fill it, so a description can be
 * saved without the cook retyping a title the Work already has. A header field in another language
 * is a display choice and is not copied in.
 */
export function initialDetails(metadata: MetadataLike, language: string, work: RecipeWorkFields): DetailsValues {
  const values = detailsValues(metadata as WorkMetadata | null, language);
  const index = values.entries.findIndex(entry => entry.language.toLowerCase() === language.toLowerCase());
  const current = index >= 0 ? values.entries[index]! : { language, title: '', description: '', tagline: '', label: null };
  const seeded = {
    ...current, language,
    title: current.title || textIn(work.label, language),
    description: current.description || textIn(work.description, language),
    tagline: current.tagline || textIn(work.tagline, language),
    label: current.label ?? (textIn(work.mainVersionLabel, language) || null),
  };
  const entries = index >= 0 ? values.entries.map((entry, at) => at === index ? seeded : entry) : [seeded, ...values.entries];
  const completion = values.completion || work.completionStatus || '';
  return {
    ...values,
    originalTitle: values.originalTitle || work.originalTitle?.value || '',
    originalLanguage: values.originalLanguage || work.originalTitle?.language || '',
    completion: completion === 'ongoing' || completion === 'completed' || completion === 'hiatus' ? completion : '',
    entries,
  };
}

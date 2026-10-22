/** Authored labels for public vocabulary terms, independent of native resource disclosure.
 * Exact identities only: unfamiliar IRIs never acquire a name from their spelling.
 * Nutrition term meanings: https://schema.org/NutritionInformation.
 * Labels are English content; a different interface language does not translate them.
 */
export interface VocabularyLabel { readonly value: string; readonly language: 'en'; readonly direction: 'ltr' }

const labels: ReadonlyMap<string, VocabularyLabel> = new Map([
  ['https://schema.org/Book', 'Book'],
  ['https://schema.org/calories', 'Calories'],
  ['https://schema.org/carbohydrateContent', 'Carbohydrates'],
  ['https://schema.org/cholesterolContent', 'Cholesterol'],
  ['https://schema.org/fatContent', 'Fat'],
  ['https://schema.org/fiberContent', 'Fiber'],
  ['https://schema.org/proteinContent', 'Protein'],
  ['https://schema.org/saturatedFatContent', 'Saturated fat'],
  ['https://schema.org/servingSize', 'Serving size'],
  ['https://schema.org/sodiumContent', 'Sodium'],
  ['https://schema.org/sugarContent', 'Sugars'],
  ['https://schema.org/transFatContent', 'Trans fat'],
  ['https://schema.org/unsaturatedFatContent', 'Unsaturated fat'],
].map(([reference, value]) => [reference!, Object.freeze({ value: value!, language: 'en' as const, direction: 'ltr' as const })]));

/** No network, URI-fragment inference, native title fallback or authority claim. */
export function publicVocabularyLabel(reference: string): VocabularyLabel | null {
  return labels.get(reference) ?? null;
}

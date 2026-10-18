import type { Static } from 'typebox';
import type { RecipeMeasure } from '../../../services/main/src/modules/structure/format.ts';
import type { ingredientLine, recipeStep } from '../../../services/main/src/routes/recipe-qualifiers.ts';
import type { RetainedPersonaRealm } from '../support/personas.ts';

export const publicDomainBaseline = '79be80d4d0e1cad1639b6a65e8f0795d6a95929a';
export const privateRecipeText = 'PRIVATE unpublished catalogue recipe annotation';
export type Rational = { numerator: number; denominator: number };
export type Measure = Static<typeof RecipeMeasure>;
export type Ingredient = Static<typeof ingredientLine>;
export type Step = Static<typeof recipeStep>;

/** A quote from frozen source bytes, independently selected before product proof.
 * Normalized quantities/relations below require review against these citations;
 * a saved API answer is never the source oracle. */
export interface SourceQuote {
  file: string;
  sha256: string;
  exact: string;
}
export interface PublicRecipe {
  work: string;
  workRevision: string;
  mainVersion: string;
  structure: string;
  revision: string;
  publisher: 'owner' | 'operator';
  source: { record: string; observation: string; author: string; url: string; license: string | null };
  title: string;
  language: string;
  /** Complete depth-first receipt order, including groups and empty groups. */
  order: string[];
  ingredients: Array<{ occurrence: string; parent: string; qualifier: Ingredient; evidence: SourceQuote }>;
  steps: Array<{ occurrence: string; parent: string; qualifier: Step; evidence: SourceQuote }>;
  measures: Array<{ value: Measure; evidence: SourceQuote }>;
  /** An explicit absence in the retained source, not an empty successful read of unknown data. */
  nutrition: 'stated' | 'absent';
  substitutions: Array<{ alternative: string; for: string; declaredBy: string; evidence: SourceQuote }>;
}
export interface RealBook {
  work: string;
  title: string;
  language: string;
  description: { value: string; language: string; evidence: SourceQuote };
  author: { agent: string; name: string; evidence: SourceQuote };
  composition: string;
  compositionRevision: string;
  /** Real native releases with exact coverage of this same retained realization. */
  releases: Array<{ id: string; revision: string; realization: string; realizationRevision: string;
    language: string; platform: string; evidence: SourceQuote }>;
  chapters: Array<{ occurrence: string; parent: string; target: string; selectedRevision: string;
    body: SourceQuote; bodyText: string }>;
}

/** Private metadata beside ONE consistent stopped owner backup. The producer uses
 * public commands and retainPersonaRealm/createCorpusBackupDriver; it is a fixture
 * prerequisite, not a replacement import or publication implementation. */
export interface PublicDomainCorpus {
  profile: 'catalogue-public-domain-corpus-v1';
  productRevision: typeof publicDomainBaseline;
  backup: string;
  preparationMs: number;
  preparationQaRun: string;
  personas: RetainedPersonaRealm;
  /** Original retained catalogue identities; no replacement UUIDs on restore. */
  importedWorks: string[];
  richRecipe: PublicRecipe;
  noNutritionRecipe: PublicRecipe;
  /** Together exercise both bases, all coverage and provenance states. */
  nutritionRecipes: PublicRecipe[];
  book: RealBook;
}

export interface RecipePage {
  profile: 'recipe-work-page-v1';
  structure: string;
  revision: string;
  occurrences: Array<{ occurrence: string; parent: string; role: string;
    qualifier?: Ingredient | Step | { type: string } }>;
  ingredients: Array<{ occurrence: string; originalText: string; amount?: Rational;
    amountUpper?: Rational; unitText?: string; scaled: boolean; reason?: string }>;
  measures: Measure[];
  next?: string;
}

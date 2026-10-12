import type { LoadCompatibility } from './compatibility.ts';

/** Retained corpus data shared with browser readers, without storage lifecycle code. */
export interface LaunchBookEdition {
  externalId: string;
  release: string;
  revision: string;
  observation: string;
  title: string;
  sourceFormat: string | null;
  /** Catalogue seeds expose their medium through release-v2.platform. */
  platform: string | null;
  format: string | null;
  language: string;
  contentLanguages: string[];
  publisher: string | null;
  publicationYear: number | null;
  realization: string | null;
  realizationRevision: string | null;
}

export interface LaunchBooksCorpus {
  recipe: 'launch-books-v2';
  id: string;
  compatibility: LoadCompatibility;
  sources: { id: string; sha256: string; reuseBasis: string }[];
  counts: { works: 1; realizations: 1; releases: 6; contentObservations: 7; librarySlice: 0; wikidataLabels: 0; covers: 0 };
  work: string;
  editions: LaunchBookEdition[];
  backup: string;
  buildMs: number;
}

export interface LaunchRecipeRecord {
  recipeId: string;
  pinId: string;
  title: string;
  language: 'en' | 'it';
  caseIds: string[];
  sourceIngredients: string[];
  sourceMethods: string[];
  work: string;
  mainVersion: string;
  structure: string;
  revision: string;
}

export interface LaunchRecipesCorpus {
  recipe: 'launch-real-recipes-v2';
  id: string;
  compatibility: LoadCompatibility;
  sources: { id: string; sha256: string; reuseBasis: string }[];
  realm: string;
  realmHandle: 'launch-recipes';
  zone: string;
  records: LaunchRecipeRecord[];
  counts: { works: 30; recipes: 30; ingredientLines: 173; fractionLines: 47; rangeLines: 2;
    englishRecipes: 20; italianRecipes: 10 };
  backup: string;
  buildMs: number;
}

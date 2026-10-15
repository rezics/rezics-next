import { browserMainApi } from '../api/browser.ts';
import type { MainClient } from '../studio/types.ts';

export interface RecipeExport {
  profile: 'recipe-schema-org-export-v1';
  structure: string;
  revision: string;
  recipe: Record<string, unknown>;
  losses?: { code: string; occurrence: string; pointer: string }[];
  [key: string]: unknown;
}
export interface NativeRecipeExport {
  format: 'native'; structure: string; revision: string;
  occurrences: unknown[]; contents: unknown[]; derivations: unknown[]; losses: unknown[];
}

export interface RecipeExportRequest {
  structure: string;
  revision: string;
  actingSubject: string;
}

export type RecipeExportFailure = 'denied' | 'too-large' | 'unavailable';

export class RecipeExportError extends Error {
  constructor(readonly failure: RecipeExportFailure, readonly detail: string | null = null) {
    super(detail ?? failure);
    this.name = 'RecipeExportError';
  }
}

export interface RecipeExportApi {
  exportRevision: (input: RecipeExportRequest) => Promise<RecipeExport>;
  exportNativeRevision?: (input: RecipeExportRequest) => Promise<NativeRecipeExport>;
}

const idOf = (iri: string) => iri.slice(-36);

function problemCode(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || !('code' in value) || typeof value.code !== 'string') return null;
  return value.code;
}

/** Main puts a typed refusal's explanation in `detail`, or in `title` when it has no separate title. */
function problemMessage(value: unknown): string | null {
  if (typeof value !== 'object' || value === null) return null;
  const problem = value as { detail?: unknown; title?: unknown };
  return typeof problem.detail === 'string' && problem.detail ? problem.detail
    : typeof problem.title === 'string' && problem.title ? problem.title : null;
}

function exportFailure(status: number, value: unknown): RecipeExportError {
  if (status === 413 && problemCode(value) === 'recipe_export_too_large') {
    return new RecipeExportError('too-large', problemMessage(value));
  }
  if (status === 401 || status === 403 || status === 404) return new RecipeExportError('denied', problemMessage(value));
  return new RecipeExportError('unavailable');
}

/** Reads exactly the selected editor revision through Main's typed Schema.org export route. */
export function mainRecipeExportApi(main: () => MainClient = browserMainApi): RecipeExportApi {
  return {
    async exportNativeRevision({ structure, revision, actingSubject }) {
      const answer = await main().v1.recipes({ id: idOf(structure) }).export.get({
        query: { ...(actingSubject ? { actingSubject } : {}), revision, format: 'native' },
      });
      if (answer.error) throw exportFailure(answer.error.status, answer.error.value);
      if (!answer.data || !('format' in answer.data) || answer.data.format !== 'native'
        || answer.data.structure !== structure || answer.data.revision !== revision) throw new RecipeExportError('unavailable');
      return answer.data as NativeRecipeExport;
    },
    async exportRevision({ structure, revision, actingSubject }) {
      try {
        const answer = await main().v1.recipes({ id: idOf(structure) }).export.get({
          query: { ...(actingSubject ? { actingSubject } : {}), revision, format: 'schema-org' },
        });
        if (answer.error) throw exportFailure(answer.error.status, answer.error.value);
        const data: unknown = answer.data;
        if (typeof data !== 'object' || data === null || !('profile' in data) || data.profile !== 'recipe-schema-org-export-v1'
          || !('revision' in data) || data.revision !== revision || !('structure' in data) || data.structure !== structure
          || !('recipe' in data)
          || typeof data.recipe !== 'object' || data.recipe === null) {
          throw new RecipeExportError('unavailable');
        }
        return data as RecipeExport;
      } catch (error) {
        if (error instanceof RecipeExportError) throw error;
        throw new RecipeExportError('unavailable');
      }
    },
  };
}

export function downloadNativeRecipeExport(exported: NativeRecipeExport): void {
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(exported, null, 2)], { type: 'application/json' }));
  link.download = `recipe-revision-${idOf(exported.revision)}.native.json`;
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

/** Keep the exported revision in the filename so downloaded recipes remain distinguishable. */
export function recipeExportFilename(revision: string): string {
  return `recipe-revision-${idOf(revision)}.schema-org.json`;
}

/** Offer the JSON response as a local download without keeping a copy in the page. */
export function downloadRecipeExport(exported: RecipeExport, language?: string, name?: string): void {
  // Main's export response is a revision envelope, while file import accepts a Recipe at the
  // document root. Provenance pointers are useful in the API response but are not Schema.org fields
  // and can contain URLs, so keep them out of a file that should be importable again.
  const recipe = JSON.parse(JSON.stringify(exported.recipe,
    (key: string, value: unknown) => key === 'sourceKey' ? undefined : value)) as Record<string, unknown>;
  if (typeof recipe.name !== 'string' && name) recipe.name = name;
  if (typeof recipe.inLanguage !== 'string' && language) recipe.inLanguage = language;
  const link = document.createElement('a');
  link.href = URL.createObjectURL(new Blob([JSON.stringify(recipe, null, 2)], { type: 'application/ld+json' }));
  link.download = recipeExportFilename(exported.revision);
  link.click();
  setTimeout(() => URL.revokeObjectURL(link.href), 10_000);
}

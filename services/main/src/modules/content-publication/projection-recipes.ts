import { join, resolve } from 'node:path';
import type { ProjectionPublication } from '../../../../content/src/core.ts';
import { summarizeJudgments, type JudgmentCounts } from '../judgment/policy.ts';
import type { ConceptHint } from '../judgment/schema.ts';
import { publicTitleProjectionRecipe } from './title-projection.ts';

/** Work metadata uses its own public title field on selected body MatchUnits. */
export const titleProjectionRecipes = [publicTitleProjectionRecipe] as const;
export const publicTitleProjection = titleProjectionRecipes[0].project;

const MAX_BODY_BYTES = 65_536;

export class ContentProjectionUnavailable extends Error {}

export type ProjectionRecipe =
  | { model: string; kind: 'skip' }
  | { model: string; kind: 'text'; extract: (body: Record<string, unknown>,
    publication: ProjectionPublication) => { text: string; language: string } };

function extractContentBody(body: Record<string, unknown>, publication: ProjectionPublication) {
  const language = publication.reference.language;
  if (language.kind !== 'tag' || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(language.tag)) {
    throw new ContentProjectionUnavailable('Content language has no admitted search tag');
  }
  const text = body.body;
  if (typeof text !== 'string' || text.length === 0 || Buffer.byteLength(text, 'utf8') > MAX_BODY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(text)) {
    throw new ContentProjectionUnavailable('Content body exceeds admitted single-unit recipe');
  }
  return { text, language: language.tag };
}

const builtIn: readonly ProjectionRecipe[] = [
  { model: 'content-shape-v1', kind: 'text', extract: extractContentBody },
  { model: 'media-set-v1', kind: 'skip' },
];

/** New owners register exact model recipes in modules/<owner>/projection-recipe.ts. */
export async function discoverProjectionRecipes(directory = join(import.meta.dir, '..')) {
  const recipes = new Map(builtIn.map(recipe => [recipe.model, recipe]));
  for (const file of [...new Bun.Glob('*/projection-recipe.ts').scanSync({ cwd: directory })].sort()) {
    const module = await import(resolve(directory, file)) as { projectionRecipes?: unknown };
    if (!Array.isArray(module.projectionRecipes) || module.projectionRecipes.length === 0) {
      throw new Error(`Projection recipe declaration is empty in ${file}`);
    }
    for (const candidate of module.projectionRecipes) {
      const recipe = candidate as Partial<ProjectionRecipe>;
      if (typeof recipe.model !== 'string' || !/^[a-z][a-z0-9-]*-v[1-9][0-9]*$/.test(recipe.model)
        || recipes.has(recipe.model) || (recipe.kind !== 'skip' && recipe.kind !== 'text')
        || (recipe.kind === 'text' && typeof recipe.extract !== 'function')
        || (recipe.kind === 'skip' && 'extract' in recipe)) {
        throw new Error(`Duplicate or invalid projection recipe in ${file}`);
      }
      recipes.set(recipe.model, recipe as ProjectionRecipe);
    }
  }
  return recipes;
}

const recipes = await discoverProjectionRecipes();
export function projectionRecipeFor(model: string): ProjectionRecipe {
  const recipe = recipes.get(model);
  if (!recipe) throw new ContentProjectionUnavailable(`No projection recipe for Content model ${model}`);
  return recipe;
}

export function extractProjectionText(recipe: Extract<ProjectionRecipe, { kind: 'text' }>,
  body: Record<string, unknown>, publication: ProjectionPublication) {
  const extracted = recipe.extract(body, publication);
  if (typeof extracted.text !== 'string' || !extracted.text
    || Buffer.byteLength(extracted.text, 'utf8') > MAX_BODY_BYTES
    || /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/u.test(extracted.text)
    || !/^[a-z]{2,3}(?:-[A-Za-z0-9]{2,8})*$/.test(extracted.language)
    || publication.reference.language.kind !== 'tag'
    || extracted.language !== publication.reference.language.tag) {
    throw new ContentProjectionUnavailable('Projection recipe returned invalid search text');
  }
  return extracted;
}

/** One Access judgment invalidation projects one generation-bound spoiler badge. */
export function judgmentBadgeProjectionRecipe(counts: JudgmentCounts, hint: ConceptHint) {
  const { policy, spoiler } = summarizeJudgments(counts, hint);
  return { policyGeneration: policy.generation, protection: spoiler.protection,
    status: spoiler.status, sampleSize: spoiler.sampleSize,
    distribution: spoiler.distribution };
}

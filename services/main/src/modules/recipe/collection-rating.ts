import type { ImportCommands } from '../library-import/batch.ts';
import { ReaderImportUnavailable } from '../library-import/reader-import.ts';
import { onJudgmentScale, SCALED_GLOBAL_OBSERVATION, type JudgmentScale } from '../rating/scale.ts';
import type { CollectionRecipe } from './collection-file.ts';

export type RecipeCollectionRating = { status: 'native'; context: string; value: number; revision: string; scale: JudgmentScale }
  | { status: 'retained'; reason: 'unknown-source-scale' | 'unrated' | 'context-required' | 'scale-mismatch' | 'owner-refused' };

/** Paprika's zero means unrated. Mela's documented format has no numeric rating
 * scale, so an extension called rating remains raw rather than acquiring a guessed scale. */
export async function importCollectionRating(commands: ImportCommands, recipe: CollectionRecipe,
  input: { actor: string; work: string; mainVersion: string; key: string }): Promise<RecipeCollectionRating | undefined> {
  if (recipe.rating === undefined) return undefined;
  if (recipe.provider !== 'paprika' || !Number.isInteger(recipe.rating) || typeof recipe.rating !== 'number'
    || recipe.rating < 0 || recipe.rating > 5) return { status: 'retained', reason: 'unknown-source-scale' };
  if (recipe.rating === 0) return { status: 'retained', reason: 'unrated' };
  const sourceScale = { min: 1, max: 5, step: 1 };
  const compatible = (scale: JudgmentScale) => scale.min === sourceScale.min && scale.max === sourceScale.max
    && scale.step === sourceScale.step && onJudgmentScale(recipe.rating, scale);
  const available = await commands.read<{ items: Array<{ context: string; scale: JudgmentScale }>; nextCursor: string | null }>(
    '/v1/rating-contexts?scope=global&limit=20');
  const matches = available?.items.filter(item => compatible(item.scale));
  // The Library uses its sole Global Context by default. Multiple questions or
  // a continuation require an explicit native edit, not a guessed question.
  if (!available || available.nextCursor || matches?.length !== 1) return { status: 'retained', reason: 'context-required' };
  const context = matches[0]!.context;
  const configured = await commands.read<{ scale: JudgmentScale }>(`/v1/global-rating-contexts/${context.slice(-36)}`);
  if (!configured || !compatible(configured.scale)) return { status: 'retained', reason: 'scale-mismatch' };
  const response = await commands.call('POST', '/v1/global-rating-observations', {
    profile: SCALED_GLOBAL_OBSERVATION, context, work: input.work, mainVersion: input.mainVersion,
    actingSubject: input.actor, expectedRevisionHead: null, value: recipe.rating }, input.key);
  if (response.status >= 500 || response.status === 429 || response.status === 202) {
    throw new ReaderImportUnavailable('Recipe rating owner is unavailable');
  }
  if (!response.ok) return { status: 'retained', reason: 'owner-refused' };
  const saved = await response.json() as { observationRevision: string };
  return { status: 'native', context, value: recipe.rating, revision: saved.observationRevision, scale: configured.scale };
}

import { SeedApiError } from './api.ts';
import { grantHomeSeedAuthority } from './operator.ts';
import { seedKey } from './plan.ts';
import type { SeedState } from './state.ts';

const short = (id: string) => id.slice(-36);
const servings = 4;

/** One Kitchen Work has a real Recipe Structure, so its Work page can scale quantities. */
export function pancakeOperations(structure: string) {
  const line = (sourceKey: string, originalText: string, numerator: number, denominator: number,
    unitText: string, scaling: 'linear' | 'not-scalable' = 'linear') => {
    const amountLexical = /^\d+(?: \d+\/\d+|\/\d+)?/.exec(originalText)?.[0];
    if (!amountLexical) throw new Error('Seeded ingredient needs a written amount');
    return { op: 'insert' as const, parent: structure, position: 'last' as const, role: 'ingredient' as const,
      sourceKey, qualifier: { type: 'ingredient-line' as const,
        originalText: { value: originalText, language: 'en' }, amountLexical,
        amount: { numerator, denominator }, unitText, optional: false, scaling,
        substituteFor: [], parseStatus: 'parsed' as const } };
  };
  const step = (sourceKey: string, instruction: string) => ({
    op: 'insert' as const, parent: structure, position: 'last' as const, role: 'step' as const,
    sourceKey, qualifier: { type: 'recipe-step' as const,
      instructionText: { value: instruction, language: 'en' },
      usesIngredient: [], media: [], scaling: 'linear' as const },
  });
  return [
    line('flour', '1 1/2 cups flour', 3, 2, 'cups'),
    line('sugar', '2 tablespoons sugar', 2, 1, 'tablespoons'),
    line('baking-powder', '2 teaspoons baking powder', 2, 1, 'teaspoons'),
    line('salt', '1/4 teaspoon salt', 1, 4, 'teaspoon'),
    line('buttermilk', '1 cup buttermilk', 1, 1, 'cup'),
    line('egg', '1 egg', 1, 1, 'egg'),
    line('butter', '2 tablespoons melted butter', 2, 1, 'tablespoons'),
    step('mix-dry', 'Whisk flour, sugar, baking powder and salt.'),
    step('mix-wet', 'Whisk buttermilk, egg and melted butter into the dry ingredients; rest for 10 minutes.'),
    step('cook', 'Cook on a hot griddle for 3 minutes on each side, until golden.'),
  ];
}

export async function seedRecipes(state: SeedState) {
  const work = state.created.get('pancakes');
  const author = state.sessions.find(session => session.id === 'aria');
  if (!work || !author || !state.operatorInput) throw new Error('Pancake Work and author are required');
  const result = await state.optional('Measured Kitchen recipe', async () => {
    await grantHomeSeedAuthority({ ...state.operatorInput!, ownerAccountSubject: author.accountId,
      actingSubject: author.actingSubject }, [
      { action: 'recipe.edit', scope: `work:edit:${work.work}` },
    ]);
    const created = await state.api.post<{ structure: string; revision: string }>('/v1/recipes', {
      owner: work.work, mainVersion: work.mainVersion, actingSubject: author.actingSubject,
    }, author.token, seedKey('recipe-structure', 'pancakes'));
    const path = `/v1/recipes/${short(created.structure)}`;
    const changed = await state.api.post<{ revision: string }>(`${path}/changes`, {
      expectedHead: created.revision, actingSubject: author.actingSubject,
      operations: pancakeOperations(created.structure),
    }, author.token, seedKey('recipe-ingredients', 'pancakes')).catch((error: unknown) => {
      // A stack seeded before the current operations keeps its recipe; the scaling read below still checks it.
      if (error instanceof SeedApiError && error.status === 409) return null;
      throw error;
    });
    if (changed) await state.api.post(`${path}/measures`, {
      expectedHead: changed.revision, actingSubject: author.actingSubject,
      yield: { value: { numerator: servings, denominator: 1 }, unitText: 'servings',
        coverage: 'complete', provenance: 'declared' },
      servings: { value: { numerator: servings, denominator: 1 },
        coverage: 'complete', provenance: 'declared' },
      nutrition: { basis: 'whole-recipe', inputs: [] },
    }, author.token, seedKey('recipe-measures', 'pancakes'));
    const scaled = await state.api.getPublic<{ ingredients: Array<{ originalText: string;
      amount?: { numerator: number; denominator: number } }> }>(
      `/v1/recipes/works/${short(work.work)}?servings=6`);
    const flour = scaled.ingredients.find(item => item.originalText === '1 1/2 cups flour');
    if (flour?.amount?.numerator !== 9 || flour.amount.denominator !== 4) {
      throw new Error('Pancake Recipe Work read did not scale flour from 4 to 6 servings');
    }
    return scaled;
  });
  if (result) console.log('Kitchen recipe: weekend pancakes measured for four servings.');
}

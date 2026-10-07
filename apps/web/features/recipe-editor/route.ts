import { globalWorkHref } from '../work-page/route.ts';

/** `/w/{ref}/edit/recipe`: where a cook writes a recipe's details, ingredients and steps. */
export const recipeEditHref = (ref: string) => `${globalWorkHref(ref)}/edit/recipe`;

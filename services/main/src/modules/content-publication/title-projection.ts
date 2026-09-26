import { lit, RV } from '../work/activate.ts';

/** The public Work title is copied onto an admitted body MatchUnit. The title
 * field is indexed separately, while the shared unit supplies the join key. */
export function publicTitleProjection(title: string): string {
  if (title.length < 1 || title.length > 200
    || /[\u0000-\u001f\u007f]/u.test(title)) {
    throw new Error('invalid public Work title projection');
  }
  return `${lit(title)}@en`;
}

export const publicTitleProjectionRecipe = {
  model: 'work-metadata-v1', field: 'publicTitle', predicate: `${RV}publicTitle`,
  project: publicTitleProjection,
} as const;

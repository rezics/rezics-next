import { canonicalLanguage } from '../display-language/select.ts';
import { lit, RV } from '../work/activate.ts';

/** The public Work title is copied onto an admitted body MatchUnit. The title
 * field is indexed separately, while the shared unit supplies the join key. */
export function publicTitleProjection(title: string, language = 'und'): string {
  const canonical = canonicalLanguage(language);
  if (title.length < 1 || title.length > 500
    || /[\u0000-\u001f\u007f]/u.test(title)
    || !canonical) {
    throw new Error('invalid public Work title projection');
  }
  return `${lit(title)}@${canonical}`;
}

export const publicTitleProjectionRecipe = {
  model: 'work-metadata-v1', field: 'publicTitle', predicate: `${RV}publicTitle`,
  project: publicTitleProjection,
} as const;

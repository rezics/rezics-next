import type { ProjectionRecipe } from '../content-publication/projection-recipes.ts';

function text(body: Record<string, unknown>, language: string, field: string) {
  const value = body[field];
  if (typeof value !== 'string' || !value || Buffer.byteLength(value, 'utf8') > 65_536) {
    throw new Error('Hub projection text is unavailable');
  }
  return { text: value, language };
}

/** Published Hub content is searchable as literal data, never an execution request. */
export const projectionRecipes: readonly ProjectionRecipe[] = [
  { model: 'rezics-skill-package-v1', kind: 'text', extract: (body, publication) => {
    if (publication.reference.language.kind !== 'tag') throw new Error('Hub text language is unavailable');
    return text(body, publication.reference.language.tag, 'instructions');
  } },
  { model: 'rezics-prompt-v1', kind: 'text', extract: (body, publication) => {
    if (publication.reference.language.kind !== 'tag') throw new Error('Hub text language is unavailable');
    return text(body, publication.reference.language.tag, 'content');
  } },
];

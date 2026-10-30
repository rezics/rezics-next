import type { ZoneStarter } from '@rezics/composition';
import anime from '../../../../../../packages/definitions/presentation/anime/zone.json';
import book from '../../../../../../packages/definitions/presentation/book/zone.json';
import character from '../../../../../../packages/definitions/presentation/character/zone.json';
import game from '../../../../../../packages/definitions/presentation/game/zone.json';
import manga from '../../../../../../packages/definitions/presentation/manga/zone.json';
import recipe from '../../../../../../packages/definitions/presentation/recipe/zone.json';
import series from '../../../../../../packages/definitions/presentation/series/zone.json';
import visualNovel from '../../../../../../packages/definitions/presentation/visual-novel/zone.json';

// Build input only. No release observer, instance registry, generated translations or source rewrites.
const definitions: Readonly<Record<string, ZoneStarter>> = {
  anime,
  book,
  character,
  game,
  manga,
  recipe,
  series,
  'visual-novel': visualNovel,
};
export const starterChoices = Object.entries(definitions).map(([id, starter]) => ({
  id,
  labels: { ...starter.labels },
}));

export function copyStarter(id: string): ZoneStarter | undefined {
  return Object.hasOwn(definitions, id) ? structuredClone(definitions[id]) : undefined;
}

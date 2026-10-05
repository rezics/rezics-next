import type { StatusWords } from '../catalogue/reader-actions.tsx';
import { isUseAction } from '../catalogue/types.ts';
import type { WorkExperience } from '../entity-page/experience.ts';
import type { WorkPageMessages } from './messages.ts';

/**
 * The shelf words in the Work's own verb, as a showcase slide's action names it (read, play,
 * install or use, open a recipe). Books keep the reading words, which the control uses when it is
 * given none; the stored statuses are the same three for every kind.
 */
export function shelfWords(experience: Pick<WorkExperience, 'kind' | 'presentation' | 'primaryAction'>,
  t: WorkPageMessages): StatusWords | undefined {
  if (experience.kind === 'recipe') return { wantToRead: t.wantToCook, reading: t.cooking, read: t.cooked };
  if (experience.presentation === 'game') return { wantToRead: t.wantToPlay, reading: t.playing, read: t.played };
  if (isUseAction(experience.primaryAction)) return { wantToRead: t.wantToUse, reading: t.using, read: t.used };
  return undefined;
}

import type { StatusWords } from '../catalogue/reader-actions.tsx';
import { isUseAction } from '../catalogue/types.ts';
import type { WorkExperience } from '../entity-page/experience.ts';
import type { WorkPageMessages } from './messages.ts';

export type ShelfVerb = 'read' | 'play' | 'cook' | 'use';

/**
 * The verb a Work's shelf words follow, as a showcase slide's action names it (read, play,
 * install or use, open a recipe). Every kind keeps the same three stored statuses; only the words differ.
 */
export function shelfVerb(experience: Pick<WorkExperience, 'kind' | 'presentation' | 'primaryAction'>): ShelfVerb {
  if (experience.kind === 'recipe') return 'cook';
  if (experience.presentation === 'game') return 'play';
  return isUseAction(experience.primaryAction) ? 'use' : 'read';
}

/**
 * The shelf words in the Work's own verb. Books keep the reading words, which the control uses when
 * it is given none.
 */
export function shelfWords(experience: Pick<WorkExperience, 'kind' | 'presentation' | 'primaryAction'>,
  t: WorkPageMessages): StatusWords | undefined {
  switch (shelfVerb(experience)) {
    case 'cook': return { wantToRead: t.wantToCook, reading: t.cooking, read: t.cooked };
    case 'play': return { wantToRead: t.wantToPlay, reading: t.playing, read: t.played };
    case 'use': return { wantToRead: t.wantToUse, reading: t.using, read: t.used };
    case 'read': return undefined;
  }
}

/** The "N people are currently …" counts in each verb, as `shelfWords` names the shelf. */
export const nowWords = {
  read: { exact: 'readingNow', atLeast: 'readingNowAtLeast' },
  play: { exact: 'playingNow', atLeast: 'playingNowAtLeast' },
  cook: { exact: 'cookingNow', atLeast: 'cookingNowAtLeast' },
  use: { exact: 'usingNow', atLeast: 'usingNowAtLeast' },
} as const satisfies Record<ShelfVerb, { exact: keyof WorkPageMessages; atLeast: keyof WorkPageMessages }>;

import type { materializeData } from 'native-i18n';
import { isUseAction, primaryActionOf, typeEntry } from '../catalogue/types.ts';
import { type ShelfVerb, shelfVerb } from '../work-page/shelf-words.ts';
import type { LibraryMessages } from './messages.ts';
import type { ShelfStatus } from './types.ts';
import type { LibraryRow } from './types.ts';

// Labels shared by the server page and its client parts, so neither calls
// across the client boundary for a string.

type T = ReturnType<typeof materializeData<LibraryMessages>>;

export function statusLabel(status: ShelfStatus, t: T): string {
  return status === 'reading' ? t.reading : status === 'read' ? t.read : t.wantToRead;
}

/** Software, mods, skills and prompts use the same stored status slots as books; the registry says which are used. */
export function isUseWork(row: Pick<LibraryRow, 'types'>): boolean {
  return isUseAction(primaryActionOf(row.types ?? []));
}

/** The verb the registry gives a Work's type: games are played, recipes cooked, software and prompts used. */
export function shelfVerbOf(row: Pick<LibraryRow, 'types'>): ShelfVerb {
  const entry = typeEntry(row.types ?? []);
  return shelfVerb({ kind: entry?.presentation === 'recipe' ? 'recipe' : 'plain', presentation: entry?.presentation ?? 'default',
    primaryAction: entry?.primaryAction ?? 'read' });
}

/** Whether the Work's shelf words differ from a book's, so its row says which shelf it is on. */
export const hasKindWords = (row: Pick<LibraryRow, 'types'>) => shelfVerbOf(row) !== 'read';

/** The shelf a row is on, in the Work's own verb (stored statuses are the same three for every kind). */
export function rowStatusLabel(row: LibraryRow, t: T): string | null {
  if (!row.status) return null;
  const words = {
    read: [t.wantToRead, t.reading, t.read], play: [t.wantToPlay, t.playing, t.played],
    cook: [t.wantToCook, t.cooking, t.cooked], use: [t.wantToUse, t.using, t.used],
  }[shelfVerbOf(row)];
  return row.status === 'reading' ? words[1] : row.status === 'read' ? words[2] : words[0];
}

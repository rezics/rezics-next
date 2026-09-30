import type { materializeData } from 'native-i18n';
import { isUseAction, primaryActionOf } from '../catalogue/types.ts';
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

export function rowStatusLabel(row: LibraryRow, t: T): string | null {
  if (!row.status) return null;
  if (!isUseWork(row)) return statusLabel(row.status, t);
  return row.status === 'reading' ? t.using : row.status === 'read' ? t.used : t.wantToUse;
}

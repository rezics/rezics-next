import type { materializeData } from 'native-i18n';
import type { LibraryMessages } from './messages.ts';
import type { ShelfStatus } from './types.ts';

// Labels shared by the server page and its client parts, so neither calls
// across the client boundary for a string.

type T = ReturnType<typeof materializeData<LibraryMessages>>;

export function statusLabel(status: ShelfStatus, t: T): string {
  return status === 'reading' ? t.reading : status === 'read' ? t.read : t.wantToRead;
}

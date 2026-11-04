import { shelfHref, type ShelfLayout, type ShelfSize } from '../shelf-params';
import { subjectHref } from '../../subject/subject-href';
import { withSubjectVisitReturn } from '../../features/pages/subject-visit-navigation';
import type { ImportLibraryRow } from './presentation';

export const importLibraryAnchor = 'vndb-current-library';

/** Public navigation contains only a return landmark; the private native cursor never crosses this boundary. */
export function importLibraryReturnHref(locale: string): string {
  return `/${encodeURIComponent(locale)}/library/import-vndb#${importLibraryAnchor}`;
}

export function importLibraryWorkHref(row: ImportLibraryRow, locale: string): string | undefined {
  if (!row.subject) return;
  return withSubjectVisitReturn(
    subjectHref({ id: row.subject.id, label: row.title }, locale).href,
    importLibraryReturnHref(locale),
    locale,
  );
}

/** Consume the real shelf URL contract, explicitly retaining this reader's order over saved defaults. */
export function importLibraryShelfHref(
  locale: string,
  layout: ShelfLayout = 'list',
  size: ShelfSize = 'm',
): string {
  return shelfHref(locale, {
    orderBy: 'lastActivity',
    direction: 'desc',
    layout,
    layoutExplicit: true,
    size,
    sizeExplicit: true,
  });
}

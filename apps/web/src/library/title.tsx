import { pageText } from '../features/pages/shared';
import type { LibraryTitleLabel } from './reads';

/** Adapt the kernel's selected label without choosing a different language. */
export function libraryTitleValue(label: LibraryTitleLabel) {
  return typeof label === 'string' ? label : { [label.language]: label.value };
}

/** Pick a library title with the same locale and language annotation used by catalogue pages. */
export function displayLibraryTitle(label: LibraryTitleLabel, locale: string) {
  return pageText(libraryTitleValue(label), locale);
}

export function LibraryTitle({ label, locale }: { label: LibraryTitleLabel; locale: string }) {
  const title = displayLibraryTitle(label, locale);
  return <span lang={title.lang}>{title.text}</span>;
}

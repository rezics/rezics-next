import type { Release } from '../../subject/definitions';
import { m } from '../../paraglide/messages.js';
import type { Locale } from '../../paraglide/runtime.js';
import { libraryStateLabel } from '../profiles';
import { progressView, type ProgressView } from '../progress-label';
import { subjectOf, type LibrarySubject } from '../reads';
import { displayLibraryTitle } from '../title';
import type { ImportLibraryPage } from './read';

/** Parallel to the native rows: identities and occurrence order remain in the original page. */
export type ImportLibraryLabels = {
  state: string;
  stateLanguage?: string;
};

export function importLibraryLabels(page: ImportLibraryPage, locale: string, release?: Release): ImportLibraryLabels[] {
  return page.libraryEntries.map((entry) => {
    const label =
      release && entry.subject
        ? libraryStateLabel(release, entry.subject.type, entry.state, locale)
        : undefined;
    return {
      state: label?.text ?? m.library_other({}, { locale: locale as Locale }),
      ...(label?.lang ? { stateLanguage: label.lang } : {}),
    };
  });
}

export type ImportLibraryRow = {
  /** Local occurrence key includes page position; two entries for one disclosed Subject are distinct rows. */
  key: string;
  entry: ImportLibraryPage['libraryEntries'][number];
  subject: LibrarySubject | null;
  title: string;
  titleLanguage?: string;
  state: string;
  stateLanguage?: string;
  progress: ProgressView | null;
};

/** Only facts supplied by this FULL page participate. No source XML, receipts, votes or point reads. */
export function importLibraryRows(
  page: ImportLibraryPage,
  locale: string,
  labels?: readonly ImportLibraryLabels[],
): ImportLibraryRow[] {
  return page.libraryEntries.map((entry, index) => {
    const subject = subjectOf(entry.subject);
    const title = subject
      ? displayLibraryTitle(subject.label, locale)
      : { text: m.library_subject_unavailable({}, { locale: locale as Locale }), lang: undefined };
    return {
      key: `${index}:${entry.subjectId}:${entry.revision}`,
      entry,
      subject,
      title: title.text,
      ...(title.lang ? { titleLanguage: title.lang } : {}),
      state: labels?.[index]?.state ?? m.library_other({}, { locale: locale as Locale }),
      ...(labels?.[index]?.stateLanguage ? { stateLanguage: labels[index]!.stateLanguage } : {}),
      // The installed native page has no rating projection. Import score decisions cannot fill that gap.
      progress: progressView(entry.activeProgressSession ?? null, locale),
    };
  });
}

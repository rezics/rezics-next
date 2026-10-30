import type { TermsTransport } from '../../features/catalogue/subject-terms';
import subject from '../recorded/subject.json';
import { subjectHref } from '../../subject/subject-href';

export const editorialSubject = subject.subject;

/** Explicit native refusal samples for the existing terms page. No successful producer is fabricated. */
export function editorialEntryFailure(state: 'denied' | 'unavailable', locale: string): TermsTransport {
  return {
    read: async () =>
      state === 'unavailable'
        ? { state }
        : {
            state: 'ready',
            snapshot: {
              subject: editorialSubject,
              etag: `"${editorialSubject.revision}"`,
              href: subjectHref({ id: editorialSubject.id, label: editorialSubject.labels.en }, locale).href,
            },
          },
    submit: async () => ({ ok: false, reason: state }),
  };
}

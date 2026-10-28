import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';

/** An embedded subject; a type with no name in the reader's language is left out. */
export type SubjectReference = { id: string; type: string; label: string; typeLabel?: string };

/** An embedded subject, linked to its page, or the shared unavailable label when it cannot be read. */
export function SubjectRef({ subject }: { subject: SubjectReference | null }) {
  if (!subject) return <span>{m.library_subject_unavailable()}</span>;
  const href = subjectHref({ id: subject.id, label: subject.label }, getLocale());
  return (
    <>
      <Link to={href.to} params={href.params} className="text-primary underline-offset-4 hover:underline">
        {subject.label}
      </Link>
      {subject.typeLabel ? <span className="text-muted-foreground">{subject.typeLabel}</span> : null}
    </>
  );
}

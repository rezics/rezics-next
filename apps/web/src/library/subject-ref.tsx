import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';

export type SubjectReference = { id: string; type: string; label: string };

/** An embedded subject, linked to its page, or the shared unavailable label when it cannot be read. */
export function SubjectRef({ subject }: { subject: SubjectReference | null }) {
  if (!subject) return <span>{m.library_subject_unavailable()}</span>;
  return (
    <>
      <Link to="/subjects/$id" params={{ id: subject.id }} className="text-primary underline-offset-4 hover:underline">
        {subject.label}
      </Link>
      <span className="text-muted-foreground">{subject.type}</span>
    </>
  );
}

import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';

export function SubjectChangesLink({ id, title, locale }: { id: string; title: string; locale: string }) {
  return (
    <a
      className="text-sm text-primary underline underline-offset-4"
      href={`${subjectHref({ id, label: title }, locale).href}/changes`}
    >
      {m.changes_title({}, { locale: locale as never })}
    </a>
  );
}

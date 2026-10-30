import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';

export function SubjectFactsEntry({ id, label, locale }: { id: string; label: string; locale: string }) {
  return (
    <a
      href={`${subjectHref({ id, label }, locale).href}/edit`}
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {m.facts_title({}, { locale: locale as never })}
    </a>
  );
}

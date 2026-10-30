import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';

export function WorkPartsEntry({ id, label, locale }: { id: string; label: string; locale: string }) {
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={`${subjectHref({ id, label }, locale).href}/work-parts`}
    >
      {m.work_parts_title({}, { locale: locale as never })}
    </a>
  );
}

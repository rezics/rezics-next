import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';

export function AuthoredFieldEntry({ id, title, locale }: { id: string; title: string; locale: string }) {
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={`${subjectHref({ id, label: title }, locale).href}/authored`}
    >
      {m.authored_title({}, { locale: locale as never })}
    </a>
  );
}

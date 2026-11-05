import { buttonVariants } from '@rezics/ui/shadcn/button';
import { subjectHref } from '../../subject/subject-href';
import { m } from '../../paraglide/messages.js';

export function WorkPartsEntry({
  id,
  label,
  locale,
  context,
  realm,
}: {
  id: string;
  label: string;
  locale: string;
  context?: string | undefined;
  realm?: string | undefined;
}) {
  const query = new URLSearchParams();
  if (context) query.set('context', context);
  if (realm) query.set('realm', realm);
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={`${subjectHref({ id, label }, locale).href}/work-parts${query.size ? `?${query}` : ''}`}
    >
      {m.work_parts_title({}, { locale: locale as never })}
    </a>
  );
}

import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';

/** Navigation offers an attempt; only the current native terms response decides eligibility. */
export function SubjectTermsEntry({ id, label, locale }: { id: string; label: string; locale: string }) {
  return (
    <a
      href={`${subjectHref({ id, label }, locale).href}/terms`}
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {m.catalogue_terms_title({}, { locale: locale as never })}
    </a>
  );
}

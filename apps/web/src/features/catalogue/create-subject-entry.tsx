import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

/** Catalogue discovery lives in the existing subject content action slot. */
export function CreateSubjectEntry({ locale }: { locale: string }) {
  return (
    <a href={`/${locale}/catalogue/new`} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {m.catalogue_create_title({}, { locale: locale as never })}
    </a>
  );
}

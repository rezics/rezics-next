import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';

/** The editor resolves the exact work and emitted profiles before offering a creation form. */
export function PublicationEditorEntry({ work, locale }: { work: string; locale: string }) {
  return (
    <a
      href={`/${locale}/catalogue/publication?work=${encodeURIComponent(work)}`}
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
    >
      {m.publication_add({}, { locale: locale as never })}
    </a>
  );
}

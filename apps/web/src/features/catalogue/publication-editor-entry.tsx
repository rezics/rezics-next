import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function PublicationEditorEntry({ work, locale }: { work: string; locale: string }) {
  const entry = catalogueEntries.publication({ work, locale });
  return (
    <a href={entry.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {entry.label}
    </a>
  );
}

import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function SubjectFactsEntry({ id, label, locale }: { id: string; label: string; locale: string }) {
  const entry = catalogueEntries.facts({ id, label, locale });
  return (
    <a href={entry.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {entry.label}
    </a>
  );
}

import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function AuthoredFieldEntry({ id, title, locale }: { id: string; title: string; locale: string }) {
  const entry = catalogueEntries.authored({ id, title, locale });
  return (
    <a href={entry.href} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      {entry.label}
    </a>
  );
}

import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function CatalogueFileCreateEntry({ locale }: { locale: string }) {
  const entry = catalogueEntries.catalogueFile({ locale });
  if (!entry) return null;
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

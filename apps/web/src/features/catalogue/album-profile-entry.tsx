import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function AlbumProfileEntry({ id, label, locale }: { id?: string; label?: string; locale: string }) {
  const entry = catalogueEntries.album({ id, label, locale });
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

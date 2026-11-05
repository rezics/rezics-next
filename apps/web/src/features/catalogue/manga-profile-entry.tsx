import type { MangaPublicOrigin } from './manga-public-visit';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function MangaProfileEntry(props: {
  id?: string;
  label?: string;
  locale: string;
  origin?: MangaPublicOrigin | undefined;
}) {
  const entry = catalogueEntries.manga(props);
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

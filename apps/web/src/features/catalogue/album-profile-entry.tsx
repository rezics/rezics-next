import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function AlbumProfileEntry({
  id,
  label,
  locale,
  visit,
}: {
  id?: string;
  label?: string;
  locale: string;
  /** A bounded public reading intent. It never selects an assertion or grants write authority. */
  visit?: string;
}) {
  const entry = catalogueEntries.album({ id, label, locale, visit });
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

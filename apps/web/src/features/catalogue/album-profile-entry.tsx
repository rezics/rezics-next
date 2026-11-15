import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
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
    <a
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-6 max-w-full shrink whitespace-normal text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
      href={entry.href}
    >
      {entry.label}
    </a>
  );
}

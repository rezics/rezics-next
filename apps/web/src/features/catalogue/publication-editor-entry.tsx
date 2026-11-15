import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { catalogueEntries } from './catalogue-entry';

export function PublicationEditorEntry({ work, locale }: { work: string; locale: string }) {
  const entry = catalogueEntries.publication({ work, locale });
  return (
    <a
      href={entry.href}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal py-2 text-center [overflow-wrap:anywhere] md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      )}
    >
      {entry.label}
    </a>
  );
}

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
        'h-auto min-h-6 max-w-full shrink whitespace-normal text-center [overflow-wrap:anywhere]',
      )}
    >
      {entry.label}
    </a>
  );
}

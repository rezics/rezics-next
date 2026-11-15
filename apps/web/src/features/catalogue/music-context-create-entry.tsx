import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { catalogueEntries } from './catalogue-entry';

export function MusicContextCreateEntry({ locale }: { locale: string }) {
  const entry = catalogueEntries.musicContextCreate({ locale });
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

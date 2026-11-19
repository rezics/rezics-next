import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { catalogueEntries } from './catalogue-entry';

export function CreateSubjectEntry({ locale }: { locale: string }) {
  const entry = catalogueEntries.create({ locale });
  return (
    <a
      href={entry.href}
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-6 max-w-full shrink whitespace-normal text-center [overflow-wrap:anywhere] focus-visible:outline-2 focus-visible:outline-solid focus-visible:outline-offset-2 focus-visible:outline-ring',
        'max-md:hitbox-y-[11px] pointer-coarse:hitbox-y-[11px]',
      )}
    >
      {entry.label}
    </a>
  );
}

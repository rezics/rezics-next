import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import type { AddonPublicOrigin } from './addon-public-visit';
import { catalogueEntries } from './catalogue-entry';

export type AddonProfileEntryProps = {
  id?: string | undefined;
  label?: string | undefined;
  work?: string | undefined;
  locale: string;
  origin?: AddonPublicOrigin | undefined;
};
export function AddonProfileEntry(props: AddonProfileEntryProps) {
  const entry = catalogueEntries.addon(props);
  return (
    <a
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      )}
      href={entry.href}
    >
      {entry.label}
    </a>
  );
}

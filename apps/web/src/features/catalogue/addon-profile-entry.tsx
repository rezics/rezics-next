import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export type AddonProfileEntryProps = {
  id?: string | undefined;
  label?: string | undefined;
  work?: string | undefined;
  locale: string;
};
export function AddonProfileEntry(props: AddonProfileEntryProps) {
  const entry = catalogueEntries.addon(props);
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

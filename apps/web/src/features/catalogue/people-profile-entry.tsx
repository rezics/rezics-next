import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function PeopleProfileEntry(address: { id?: string; label?: string; work?: string; locale: string }) {
  const entry = catalogueEntries.people(address);
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

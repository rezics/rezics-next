import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { peopleCurrentVisitHref, type PeopleCurrentVisitInput } from './people-current-visit';

type CurrentVisitInput = Omit<PeopleCurrentVisitInput, 'id' | 'label' | 'locale'>;

export type PeopleProfileEntryProps = {
  id?: string;
  label?: string;
  work?: string;
  locale: string;
  currentVisit?: CurrentVisitInput;
};

/** Keep the route intent when EditorialEntry turns this link into a menu item. */
export function peopleProfileEntry({ currentVisit, ...address }: PeopleProfileEntryProps) {
  const entry = catalogueEntries.people(address);
  const href =
    currentVisit && address.id && address.label
      ? peopleCurrentVisitHref({ ...currentVisit, id: address.id, label: address.label, locale: address.locale })
      : entry.href;
  return href === entry.href ? entry : { ...entry, href };
}

export function PeopleProfileEntry(address: PeopleProfileEntryProps) {
  const entry = peopleProfileEntry(address);
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

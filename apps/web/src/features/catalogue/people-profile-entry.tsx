import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { peopleCurrentVisitHref, type PeopleCurrentVisitInput } from './people-current-visit';

type CurrentVisitInput = Omit<PeopleCurrentVisitInput, 'id' | 'label' | 'locale'>;

export function PeopleProfileEntry({
  currentVisit,
  ...address
}: {
  id?: string;
  label?: string;
  work?: string;
  locale: string;
  currentVisit?: CurrentVisitInput;
}) {
  const entry = catalogueEntries.people(address);
  const href =
    currentVisit && address.id && address.label
      ? peopleCurrentVisitHref({ ...currentVisit, id: address.id, label: address.label, locale: address.locale })
      : entry.href;
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={href}>
      {entry.label}
    </a>
  );
}

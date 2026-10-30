import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function CharacterProfileEntry({
  id,
  label,
  work,
  locale,
}: {
  id?: string | undefined;
  label?: string | undefined;
  work?: string | undefined;
  locale: string;
}) {
  const entry = catalogueEntries.character({ id, label, work, locale });
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

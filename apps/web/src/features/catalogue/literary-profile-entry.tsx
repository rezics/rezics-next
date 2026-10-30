import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { isLiteraryType } from './literary-profile';

export function LiteraryProfileEntry({
  id,
  label,
  type,
  locale,
}: {
  id?: string;
  label?: string;
  type?: string;
  locale: string;
}) {
  if (type && !isLiteraryType(type)) return null;
  const entry = catalogueEntries.literary({ id, label, locale });
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';

export function GameProfileEntry({
  id,
  type,
  label = '',
  locale,
}: {
  id?: string;
  type?: string;
  label?: string;
  locale: string;
}) {
  const entry = catalogueEntries.gameProfile({ id, type, label, locale });
  if (!entry) return null;
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

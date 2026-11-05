import { buttonVariants } from '@rezics/ui/shadcn/button';
import { catalogueEntries } from './catalogue-entry';
import { PlainLink, type PageLink } from '../pages/shared';

export function CharacterProfileEntry({
  id,
  label,
  work,
  context,
  realm,
  locale,
  link: Link = PlainLink,
}: {
  id?: string | undefined;
  label?: string | undefined;
  work?: string | undefined;
  context?: string | undefined;
  realm?: string | undefined;
  locale: string;
  link?: PageLink;
}) {
  const entry = catalogueEntries.character({ id, label, work, context, realm, locale });
  return (
    <Link
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 max-w-full whitespace-normal' })}
      href={entry.href}
    >
      {entry.label}
    </Link>
  );
}

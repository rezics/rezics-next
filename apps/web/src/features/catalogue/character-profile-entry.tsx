import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
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
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-6 max-w-full shrink whitespace-normal text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring',
      )}
      href={entry.href}
    >
      {entry.label}
    </Link>
  );
}

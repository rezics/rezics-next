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
        'h-auto min-h-11 min-w-11 max-w-full shrink whitespace-normal py-2 text-center [overflow-wrap:anywhere] focus-visible:outline focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring md:pointer-fine:min-h-8 md:pointer-fine:py-1',
      )}
      href={entry.href}
    >
      {entry.label}
    </Link>
  );
}

import { buttonVariants } from '@rezics/ui/shadcn/button';
import { cn } from '@rezics/ui/utils';
import { m } from '../../../paraglide/messages.js';
import { characterRelationshipsHref } from './navigation';
import { PlainLink, type PageLink } from '../../pages/shared';

export function CharacterRelationshipsEntry({
  id,
  label,
  locale,
  work,
  link: Link = PlainLink,
}: {
  id: string;
  label: string;
  locale: string;
  work?: string | undefined;
  link?: PageLink;
}) {
  return (
    <Link
      className={cn(
        buttonVariants({ variant: 'outline', size: 'sm' }),
        'h-auto min-h-6 max-w-full justify-start whitespace-normal text-start [overflow-wrap:anywhere]',
      )}
      href={characterRelationshipsHref({ id, label, locale, ...(work ? { work } : {}) })}
    >
      {m.character_relationships_title({}, { locale: locale as never })}
    </Link>
  );
}

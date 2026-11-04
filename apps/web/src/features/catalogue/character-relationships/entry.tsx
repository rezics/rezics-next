import { buttonVariants } from '@rezics/ui/shadcn/button';
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
      className={buttonVariants({ variant: 'outline', className: 'min-h-11 max-w-full whitespace-normal' })}
      href={characterRelationshipsHref({ id, label, locale, ...(work ? { work } : {}) })}
    >
      {m.character_relationships_title({}, { locale: locale as never })}
    </Link>
  );
}

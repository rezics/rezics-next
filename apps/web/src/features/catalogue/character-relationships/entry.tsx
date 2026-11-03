import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../../paraglide/messages.js';
import { characterRelationshipsHref } from './navigation';

export function CharacterRelationshipsEntry({
  id,
  label,
  locale,
  work,
}: {
  id: string;
  label: string;
  locale: string;
  work?: string | undefined;
}) {
  return (
    <a
      className={buttonVariants({ variant: 'outline', size: 'sm' })}
      href={characterRelationshipsHref({ id, label, locale, ...(work ? { work } : {}) })}
    >
      {m.character_relationships_title({}, { locale: locale as never })}
    </a>
  );
}

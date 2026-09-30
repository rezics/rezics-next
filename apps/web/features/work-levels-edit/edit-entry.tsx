import { buttonVariants } from '@rezics/ui/button';
import { PencilIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import Link from '../shell/localized-link.tsx';
import { mayEdit, readAllowedActions } from './authority.ts';
import { copyOf } from './messages.ts';
import { type EditSection, editHref } from './route.ts';

/** The way into an edit page from a read page: a link for a viewer Main lets edit the Work, nothing for anyone else. */
export async function EditEntry({ workRef, id, section, locale }: {
  workRef: string; id: string; section: EditSection; locale: UiLocale;
}) {
  if (!mayEdit(await readAllowedActions(id))) return null;
  return <div className="flex justify-end">
    <Link href={editHref(workRef, section)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
      <PencilIcon aria-hidden="true" />{copyOf(locale).edit}</Link>
  </div>;
}

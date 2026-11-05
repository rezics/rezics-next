import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../../paraglide/messages.js';
import { subjectHref } from '../../subject/subject-href';
import type { CatalogueEntry } from './catalogue-entry';

type Address = {
  id?: string | undefined;
  label?: string | undefined;
  work?: string | undefined;
  realm?: string | undefined;
  context?: string | undefined;
  definition?: string | undefined;
  via?: string | undefined;
  locale: string;
};
export function storyArcEntry({ id, label, work, realm, context, definition, via, locale }: Address): CatalogueEntry {
  const base = id
    ? `${subjectHref({ id, label: label ?? '' }, locale).href}/story-arc`
    : `/${locale}/catalogue/story-arc`;
  const query = new URLSearchParams({
    ...(work ? { work } : {}),
    ...(realm ? { realm } : {}),
    ...(context ? { context } : {}),
    ...(definition ? { definition } : {}),
    ...(via ? { via } : {}),
  }).toString();
  return {
    group: id ? 'edit' : 'create',
    label: m.story_arc_title({}, { locale: locale as never }),
    href: `${base}${query ? `?${query}` : ''}`,
  };
}
export function StoryArcProfileEntry(address: Address) {
  const entry = storyArcEntry(address);
  return (
    <a className={buttonVariants({ variant: 'outline', size: 'sm' })} href={entry.href}>
      {entry.label}
    </a>
  );
}

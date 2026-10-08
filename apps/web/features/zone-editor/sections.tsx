'use client';

import { usePathname } from 'next/navigation';
import { withoutLocale } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';

/** Home and Navigation. The preview stays with Home; theme is a later section. */
export function ZoneEditorSections({ editorPath, sectionsLabel, sectionHome, sectionNavigation }: {
  editorPath: string;
  sectionsLabel: string;
  sectionHome: string;
  sectionNavigation: string;
}) {
  const path = withoutLocale(usePathname() ?? '');
  const navigationPath = `${editorPath}/navigation`;
  const onNavigation = path === navigationPath || path.startsWith(`${navigationPath}/`);
  const item = 'inline-flex rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-medium';
  return <nav aria-label={sectionsLabel} className="flex gap-1 pb-2">
    <LocalizedLink href={editorPath} aria-current={onNavigation ? undefined : 'page'} className={item}>{sectionHome}</LocalizedLink>
    <LocalizedLink href={navigationPath} aria-current={onNavigation ? 'page' : undefined} className={item}>{sectionNavigation}</LocalizedLink>
  </nav>;
}

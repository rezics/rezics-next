'use client';

import { usePathname } from 'next/navigation';
import { withoutLocale } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';

/** Home, Navigation, Realm and Theme. The preview stays with Home. */
export function ZoneEditorSections({ editorPath, sectionsLabel, sectionHome, sectionNavigation, sectionRealm, sectionTheme }: {
  editorPath: string;
  sectionsLabel: string;
  sectionHome: string;
  sectionNavigation: string;
  sectionRealm: string;
  sectionTheme: string;
}) {
  const path = withoutLocale(usePathname() ?? '');
  const navigationPath = `${editorPath}/navigation`;
  const realmPath = `${editorPath}/realm`;
  const themePath = `${editorPath}/theme`;
  const onNavigation = path === navigationPath || path.startsWith(`${navigationPath}/`);
  const onRealm = path === realmPath || path.startsWith(`${realmPath}/`);
  const onTheme = path === themePath || path.startsWith(`${themePath}/`);
  const item = 'inline-flex rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-medium';
  return <nav aria-label={sectionsLabel} className="flex gap-1 overflow-x-auto pb-2">
    <LocalizedLink href={editorPath} aria-current={!onNavigation && !onRealm && !onTheme ? 'page' : undefined} className={item}>{sectionHome}</LocalizedLink>
    <LocalizedLink href={navigationPath} aria-current={onNavigation ? 'page' : undefined} className={item}>{sectionNavigation}</LocalizedLink>
    <LocalizedLink href={realmPath} aria-current={onRealm ? 'page' : undefined} className={item}>{sectionRealm}</LocalizedLink>
    <LocalizedLink href={themePath} aria-current={onTheme ? 'page' : undefined} className={item}>{sectionTheme}</LocalizedLink>
  </nav>;
}

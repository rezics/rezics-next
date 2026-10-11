'use client';

import { usePathname } from 'next/navigation';
import { withoutLocale } from '../../i18n/locale.ts';
import LocalizedLink from '../shell/localized-link.tsx';

/** Home, Navigation, Realm, Theme and lifecycle controls. The preview stays with Home. */
export function ZoneEditorSections({ editorPath, sectionsLabel, sectionHome, sectionNavigation, sectionRealm, sectionTheme,
  sectionLifecycle, lifecycleOnly = false }: {
  editorPath: string;
  sectionsLabel: string;
  sectionHome: string;
  sectionNavigation: string;
  sectionRealm: string;
  sectionTheme: string;
  sectionLifecycle?: string;
  lifecycleOnly?: boolean;
}) {
  const path = withoutLocale(usePathname() ?? '');
  const navigationPath = `${editorPath}/navigation`;
  const realmPath = `${editorPath}/realm`;
  const themePath = `${editorPath}/theme`;
  const lifecyclePath = `${editorPath}/lifecycle`;
  const onNavigation = path === navigationPath || path.startsWith(`${navigationPath}/`);
  const onRealm = path === realmPath || path.startsWith(`${realmPath}/`);
  const onTheme = path === themePath || path.startsWith(`${themePath}/`);
  const onLifecycle = path === lifecyclePath || path.startsWith(`${lifecyclePath}/`);
  const item = 'inline-flex rounded-md px-2 py-1 text-sm outline-none focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:font-medium';
  return <nav aria-label={sectionsLabel} className="flex gap-1 overflow-x-auto pb-2">
    {lifecycleOnly ? null : <>
      <LocalizedLink href={editorPath} aria-current={!onNavigation && !onRealm && !onTheme && !onLifecycle ? 'page' : undefined} className={item}>{sectionHome}</LocalizedLink>
      <LocalizedLink href={navigationPath} aria-current={onNavigation ? 'page' : undefined} className={item}>{sectionNavigation}</LocalizedLink>
      <LocalizedLink href={realmPath} aria-current={onRealm ? 'page' : undefined} className={item}>{sectionRealm}</LocalizedLink>
      <LocalizedLink href={themePath} aria-current={onTheme ? 'page' : undefined} className={item}>{sectionTheme}</LocalizedLink>
    </>}
    {sectionLifecycle ? <LocalizedLink href={lifecyclePath} aria-current={onLifecycle ? 'page' : undefined}
      className={item}>{sectionLifecycle}</LocalizedLink> : null}
  </nav>;
}

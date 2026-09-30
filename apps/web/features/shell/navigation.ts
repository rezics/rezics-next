import { Bell, Compass, House, LibraryBig, Plus, type LucideIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';
import { withoutLocale } from '../../i18n/locale.ts';
import de from './messages/de.ts';
import es from './messages/es.ts';
import fr from './messages/fr.ts';
import ja from './messages/ja.ts';
import ko from './messages/ko.ts';
import { messages as en } from './messages.ts';
import zhHans from './messages/zh-Hans.ts';
import zhHant from './messages/zh-Hant.ts';

type NavKey = 'navHome' | 'navDiscover' | 'navCreate' | 'notifications' | 'navAlerts' | 'navLibrary' | 'navLibraryShort';

function navLabel(key: NavKey): Record<UiLocale, string> {
  return {
    en: en[key],
    'zh-Hant': zhHant[key] ?? en[key],
    'zh-Hans': zhHans[key] ?? en[key],
    ja: ja[key] ?? en[key],
    ko: ko[key] ?? en[key],
    de: de[key] ?? en[key],
    fr: fr[key] ?? en[key],
    es: es[key] ?? en[key],
  };
}

export interface NavigationItem {
  href: string;
  icon: LucideIcon;
  label: Record<UiLocale, string>;
  /** A shorter phone-tab caption; the full `label` remains the accessible name. */
  bottomLabel?: Record<UiLocale, string>;
  /** Shown in the phone bottom bar, which holds exactly five items. */
  bottom?: boolean;
  /** The one emphasized action: the raised center item on phones. */
  emphasized?: boolean;
  /** The route is not built yet: the link shows a coming-soon page with this summary. */
  planned?: Record<UiLocale, string>;
}

// The navigation, in display order. A feature adds its entry as one line; git
// merges this file with the union driver (see .gitattributes).
export const navigation: readonly NavigationItem[] = [
  { href: '/', icon: House, bottom: true, label: navLabel('navHome') },
  { href: '/discover', icon: Compass, bottom: true, label: navLabel('navDiscover') },
  { href: '/submit', icon: Plus, bottom: true, emphasized: true, label: navLabel('navCreate') },
  { href: '/notifications', icon: Bell, bottom: true,
    label: navLabel('notifications'), bottomLabel: navLabel('navAlerts') },
  // The reader's own shelves, progress and read history (app/[locale]/library).
  { href: '/library', icon: LibraryBig, bottom: true,
    label: navLabel('navLibrary'), bottomLabel: navLabel('navLibraryShort') },
];

/** Whether `pathname` is at or below the item's route. Home matches only itself. */
export function isCurrent(item: Pick<NavigationItem, 'href'>, pathname: string): boolean {
  pathname = withoutLocale(pathname);
  if (item.href === '/') return pathname === '/';
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The planned item whose route `pathname` falls under, for the coming-soon page. */
export function plannedItem(pathname: string): NavigationItem | undefined {
  return navigation.find(item => item.planned && isCurrent(item, pathname));
}

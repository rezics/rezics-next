import { Compass, House, Inbox, LibraryBig, Plus, type LucideIcon } from 'lucide-react';
import { localeText, type UiLocale } from '../../i18n/define.ts';
import { withoutLocale } from '../../i18n/locale.ts';

export interface NavigationItem {
  href: string;
  icon: LucideIcon;
  label: Record<UiLocale, string>;
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
  { href: '/', icon: House, bottom: true, label: localeText({ en: 'Home', 'zh-Hans': '首页' }) },
  { href: '/discover', icon: Compass, bottom: true, label: localeText({ en: 'Discover', 'zh-Hans': '发现' }) },
  { href: '/studio', icon: Plus, bottom: true, emphasized: true, label: localeText({ en: 'Create', 'zh-Hans': '创作' }) },
  { href: '/inbox', icon: Inbox, bottom: true, label: localeText({ en: 'Inbox', 'zh-Hans': '收件箱' }), planned: localeText({ en: 'Notifications, replies and messages from the Realms you follow will arrive here.', 'zh-Hans': '来自你关注的领域的通知、回复和消息将显示在这里。' }) },
  { href: '/shelves', icon: LibraryBig, bottom: true, label: localeText({ en: 'Shelves', 'zh-Hans': '书架' }), planned: localeText({ en: 'Keep the works you are reading, want to read and have finished on your shelves.', 'zh-Hans': '把正在读、想读和读过的作品放在书架上。' }) },
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

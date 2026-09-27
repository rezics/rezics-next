import { Compass, House, Inbox, LibraryBig, Plus, type LucideIcon } from 'lucide-react';
import type { UiLocale } from '../../i18n/define.ts';

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
  { href: '/', icon: House, bottom: true, label: { en: 'Home', 'zh-CN': '首页' } },
  { href: '/search', icon: Compass, bottom: true, label: { en: 'Discover', 'zh-CN': '发现' } },
  { href: '/studio', icon: Plus, bottom: true, emphasized: true, label: { en: 'Create', 'zh-CN': '创作' } },
  { href: '/inbox', icon: Inbox, bottom: true, label: { en: 'Inbox', 'zh-CN': '收件箱' }, planned: { en: 'Notifications, replies and messages from the Realms you follow will arrive here.', 'zh-CN': '来自你关注的领域的通知、回复和消息将显示在这里。' } },
  { href: '/shelves', icon: LibraryBig, bottom: true, label: { en: 'Shelves', 'zh-CN': '书架' }, planned: { en: 'Keep the works you are reading, want to read and have finished on your shelves.', 'zh-CN': '把正在读、想读和读过的作品放在书架上。' } },
];

/** Whether `pathname` is at or below the item's route. Home matches only itself. */
export function isCurrent(item: Pick<NavigationItem, 'href'>, pathname: string): boolean {
  if (item.href === '/') return pathname === '/';
  return pathname === item.href || pathname.startsWith(`${item.href}/`);
}

/** The planned item whose route `pathname` falls under, for the coming-soon page. */
export function plannedItem(pathname: string): NavigationItem | undefined {
  return navigation.find(item => item.planned && isCurrent(item, pathname));
}

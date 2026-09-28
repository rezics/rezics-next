import { Bell, Compass, House, LibraryBig, Plus, type LucideIcon } from 'lucide-react';
import { localeText, type UiLocale } from '../../i18n/define.ts';
import { withoutLocale } from '../../i18n/locale.ts';

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
  { href: '/', icon: House, bottom: true, label: localeText({ en: 'Home', 'zh-Hant': '首頁', 'zh-Hans': '首页', ja: 'ホーム', ko: '홈', de: 'Startseite', fr: 'Accueil', es: 'Inicio' }) },
  { href: '/discover', icon: Compass, bottom: true, label: localeText({ en: 'Discover', 'zh-Hant': '探索', 'zh-Hans': '探索', ja: '見つける', ko: '둘러보기', de: 'Entdecken', fr: 'Découvrir', es: 'Explorar' }) },
  { href: '/submit', icon: Plus, bottom: true, emphasized: true, label: localeText({ en: 'Create', 'zh-Hant': '創作', 'zh-Hans': '创作', ja: '作る', ko: '만들기', de: 'Erstellen', fr: 'Créer', es: 'Crear' }) },
  { href: '/notifications', icon: Bell, bottom: true,
    label: localeText({ en: 'Notifications', 'zh-Hant': '通知', 'zh-Hans': '通知', ja: '通知', ko: '알림', de: 'Benachrichtigungen', fr: 'Notifications', es: 'Notificaciones' }),
    bottomLabel: localeText({ en: 'Alerts', 'zh-Hant': '通知', 'zh-Hans': '通知', ja: '通知', ko: '알림', de: 'Meldungen', fr: 'Alertes', es: 'Avisos' }) },
  // The reader's own shelves, progress and read history (app/[locale]/library).
  { href: '/library', icon: LibraryBig, bottom: true,
    label: localeText({ en: 'Library', 'zh-Hant': '書架', 'zh-Hans': '书架', ja: '本棚', ko: '서재', de: 'Bibliothek', fr: 'Bibliothèque', es: 'Biblioteca' }),
    bottomLabel: localeText({ en: 'Library', 'zh-Hant': '書架', 'zh-Hans': '书架', ja: '本棚', ko: '서재', de: 'Bücher', fr: 'Livres', es: 'Libros' }) },
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

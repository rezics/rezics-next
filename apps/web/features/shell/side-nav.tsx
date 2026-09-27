'use client';

import { buttonVariants } from '@rezics/ui/button';
import { cn } from '@rezics/ui/utils';
import Link from 'next/link';
import { usePathname } from 'next/navigation';
import { localizedPath } from '../../i18n/locale.ts';
import { isCurrent, navigation } from './navigation.ts';
import { useShell } from './shell-provider.tsx';

/**
 * The full navigation. The desktop rail follows the
 * collapse toggle; the phone drawer is always expanded.
 */
export function SideNav({ variant, onNavigate }: { variant: 'rail' | 'drawer'; onNavigate?: () => void }) {
  const { locale, t, collapsed: railCollapsed } = useShell();
  const collapsed = variant === 'rail' && railCollapsed;
  const pathname = usePathname();
  const action = navigation.find(item => item.emphasized);
  return <div className="flex h-full min-h-0 flex-col">
    <nav aria-label={t.navigation} className="min-h-0 flex-1 overflow-y-auto p-3">
      {action ? <Link href={localizedPath(action.href, locale)} onClick={onNavigate} title={collapsed ? action.label[locale] : undefined}
        aria-current={isCurrent(action, pathname) ? 'page' : undefined}
        className={cn(buttonVariants({ size: 'lg' }), 'mb-3 w-full', collapsed && 'px-0')}>
        <action.icon aria-hidden="true" className="size-5" />
        <span className={collapsed ? 'sr-only' : undefined}>{action.label[locale]}</span>
      </Link> : null}
      <ul className="grid gap-1">
        {navigation.filter(item => item !== action).map(item => <li key={item.href}>
          <Link href={localizedPath(item.href, locale)} onClick={onNavigate} title={collapsed ? item.label[locale] : undefined}
            aria-current={isCurrent(item, pathname) ? 'page' : undefined}
            className={cn('flex h-10 items-center gap-3 rounded-xl px-3 font-medium text-muted-foreground text-sm',
              'outline-none transition-colors hover:bg-accent/60 hover:text-accent-foreground',
              'focus-visible:ring-2 focus-visible:ring-ring',
              'aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-accent-foreground',
              collapsed && 'justify-center px-0')}>
            <item.icon aria-hidden="true" className="size-5 shrink-0" />
            <span className={collapsed ? 'sr-only' : 'min-w-0 flex-1 truncate'}>{item.label[locale]}</span>
            {item.planned && !collapsed
              ? <span className="rounded-full bg-muted px-2 py-0.5 font-medium text-[11px] text-muted-foreground">
                {t.soon}</span>
              : null}
          </Link>
        </li>)}
      </ul>
    </nav>
  </div>;
}

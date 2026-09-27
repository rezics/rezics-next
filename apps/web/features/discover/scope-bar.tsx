import { cn } from '@rezics/ui/utils';
import { GlobeIcon, type LucideIcon, UserRoundIcon, UsersRoundIcon } from 'lucide-react';
import type { ContractOf } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { DiscoverMessages } from './messages.ts';
import { type BrowseScope, sameScope, shortId } from './scope.ts';
import type { WorkName } from './types.ts';

/** A Realm a page can name: its public name when Main gave one. */
export interface ScopeRealm { id: string; name: WorkName | null }

/** The scope in words, for shelf titles and empty states ("Top rated · Classic Literature"). */
export function scopeName(scope: BrowseScope, realm: ScopeRealm | null, t: ContractOf<DiscoverMessages>): string {
  if (scope.kind === 'global') return t.global;
  if (scope.kind === 'mine') return t.mineScope;
  return realm?.id === scope.realm && realm.name ? realm.name.value : t.realmFallback({ id: shortId(scope.realm) });
}

function ScopeLink({ href, current, icon: Icon, lang, children }: {
  href: string; current: boolean; icon: LucideIcon; lang?: string; children: ReactNode;
}) {
  return <Link href={href} aria-current={current ? 'page' : undefined} className={cn(
    'flex h-9 min-w-0 max-w-72 items-center gap-1.5 rounded-xl px-3 font-medium text-sm outline-none transition-colors',
    'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=page]:bg-primary/10 aria-[current=page]:text-primary')}>
    <Icon aria-hidden="true" className="size-4 shrink-0" />
    <span lang={lang} className="truncate">{children}</span>
  </Link>;
}

/**
 * Whose Works, ratings and classification a browse page shows: Global, the
 * Realm in the URL, or Mine. The line under it says what that means, so the
 * scope is never implicit.
 */
export function ScopeBar({ scope, realm, hrefFor, line, t }: {
  scope: BrowseScope; realm: ScopeRealm | null; hrefFor: (scope: BrowseScope) => string; line: ReactNode;
  t: ContractOf<DiscoverMessages>;
}) {
  const choices: { scope: BrowseScope; icon: LucideIcon; label: string; lang?: string }[] = [
    { scope: { kind: 'global' }, icon: GlobeIcon, label: t.global },
    ...(scope.kind === 'realm' ? [{ scope, icon: UsersRoundIcon, label: scopeName(scope, realm, t),
      lang: realm?.name?.language }] : []),
    { scope: { kind: 'mine' }, icon: UserRoundIcon, label: t.mine },
  ];
  return <div className="grid gap-2">
    <nav aria-label={t.scopeLabel} className="-mx-1 flex flex-wrap gap-1 overflow-x-auto px-1">
      {choices.map(choice => <ScopeLink key={choice.label} href={hrefFor(choice.scope)} icon={choice.icon}
        lang={choice.lang} current={sameScope(choice.scope, scope)}>{choice.label}</ScopeLink>)}
    </nav>
    <p className="text-pretty text-muted-foreground text-sm">{line}</p>
  </div>;
}

import { buttonVariants } from '@rezics/ui/button';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { GlobeIcon, type LucideIcon, UserRoundIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { neighbourScope, sameScope, shortId, type WorkAt, workHref, type WorkScope, type WorkTab } from './route.ts';
import type { WorkName } from './types.ts';

/** A Realm the scope bar offers, with its public name when Main gave one. */
export interface ScopeRealm { id: string; name: WorkName | null }

/** A Realm's display name, or "Realm 1a2b3c4d" when Main could not name it. */
export function realmLabel(realm: ScopeRealm, messages: WorkPageMessages, locale: UiLocale): string {
  return realm.name?.value ?? materializeData(messages, { locale }).realmFallback({ id: shortId(realm.id) });
}

/** What a scoped region shows and where: the page's scope and the Realms it can offer. */
export interface ScopeView { workRef: WorkAt; scope: WorkScope; realms: readonly ScopeRealm[] }

/** The scope in words, for headings and empty states ("No ratings in Fantasy Readers yet"). */
export function scopeName(view: ScopeView, messages: WorkPageMessages, locale: UiLocale): string {
  const { scope } = view;
  if (scope.kind !== 'realm') return scope.kind === 'global' ? messages.global : messages.mine;
  return realmLabel(view.realms.find(realm => realm.id === scope.realm) ?? { id: scope.realm, name: null },
    messages, locale);
}

/** The neighbouring scope an empty state offers, as a link; none when there is nowhere else to look. */
export function ScopeOffer({ view, locale, messages, tab = 'overview' }: {
  view: ScopeView; locale: UiLocale; messages: WorkPageMessages; tab?: WorkTab;
}) {
  const next = neighbourScope(view.scope, view.realms.map(realm => realm.id));
  if (!next) return null;
  const t = materializeData(messages, { locale });
  const label = next.kind === 'global' ? t.seeGlobal
    : t.seeRealm({ realm: scopeName({ ...view, scope: next }, messages, locale) });
  return <Link href={workHref(view.workRef, tab, next)} className={buttonVariants({ variant: 'outline', size: 'sm' })}>
    {label}</Link>;
}

function ScopeLink({ href, current, icon: Icon, children }: {
  href: string; current: boolean; icon: LucideIcon; children: ReactNode;
}) {
  return <Link href={href} aria-current={current ? 'true' : undefined} className={cn(
    'flex h-8 max-w-56 items-center gap-1.5 rounded-full px-3 font-medium text-sm outline-none transition-colors',
    'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=true]:bg-foreground aria-[current=true]:text-background')}>
    <Icon aria-hidden="true" className="size-3.5 shrink-0" />
    <span className="truncate">{children}</span>
  </Link>;
}

/**
 * Whose ratings, genres and replies a section shows: everyone, a community
 * that features the Work, or the reader. Small and beside the section's
 * title, so it is there when wanted and never the headline. Discussion adds a
 * line saying whose replies are shown; elsewhere the section's own content
 * names the community when one is chosen.
 */
export function ScopeBar({ workRef, scope, realms, locale, messages, tab = 'overview' }: {
  workRef: WorkAt; scope: WorkScope | null; realms: readonly ScopeRealm[]; locale: UiLocale;
  messages: WorkPageMessages; tab?: WorkTab;
}) {
  const t = materializeData(messages, { locale });
  const current = scope?.kind === 'realm' ? realms.find(realm => realm.id === scope.realm) : undefined;
  const realm = scope?.kind === 'realm' ? realmLabel(current ?? { id: scope.realm, name: null }, messages, locale) : '';
  const description = tab !== 'discussion' || !scope ? null : scope.kind === 'global' ? t.scopeDiscussionGlobal
    : scope.kind === 'mine' ? t.scopeDiscussionMine : t.scopeDiscussionRealm({ realm });
  return <nav aria-label={t.scope} className="grid min-w-0 gap-2">
    <ul className="flex min-w-0 flex-wrap gap-1">
      <li><ScopeLink href={workHref(workRef, tab)} current={sameScope(scope, { kind: 'global' })} icon={GlobeIcon}>
        {t.global}</ScopeLink></li>
      {realms.map(realm => <li key={realm.id}>
        <ScopeLink href={workHref(workRef, tab, { kind: 'realm', realm: realm.id })} icon={UsersRoundIcon}
          current={sameScope(scope, { kind: 'realm', realm: realm.id })}>
          <span className="sr-only">{t.realm}: </span>
          <span lang={realm.name?.language}>{realmLabel(realm, messages, locale)}</span>
        </ScopeLink>
      </li>)}
      <li><ScopeLink href={workHref(workRef, tab, { kind: 'mine' })} current={sameScope(scope, { kind: 'mine' })}
        icon={UserRoundIcon}>{t.mine}</ScopeLink></li>
    </ul>
    {description ? <p className="text-muted-foreground text-xs">{description}</p> : null}
  </nav>;
}

export function ScopeBarSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="flex gap-1">
    <Skeleton className="h-8 w-24 rounded-full" /><Skeleton className="h-8 w-32 rounded-full" />
    <Skeleton className="h-8 w-16 rounded-full" />
  </div>;
}

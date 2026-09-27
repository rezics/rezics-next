import { buttonVariants } from '@rezics/ui/button';
import { Skeleton } from '@rezics/ui/skeleton';
import { cn } from '@rezics/ui/utils';
import { GlobeIcon, type LucideIcon, UserRoundIcon, UsersRoundIcon } from 'lucide-react';
import { materializeData } from 'native-i18n';
import Link from '../shell/localized-link.tsx';
import type { ReactNode } from 'react';
import type { UiLocale } from '../../i18n/define.ts';
import type { WorkPageMessages } from './messages.ts';
import { neighbourScope, sameScope, shortId, workHref, type WorkScope, type WorkTab } from './route.ts';
import type { WorkName } from './types.ts';

/** A Realm the scope bar offers, with its public name when Main gave one. */
export interface ScopeRealm { id: string; name: WorkName | null }

/** A Realm's display name, or "Realm 1a2b3c4d" when Main could not name it. */
export function realmLabel(realm: ScopeRealm, messages: WorkPageMessages, locale: UiLocale): string {
  return realm.name?.value ?? materializeData(messages, { locale }).realmFallback({ id: shortId(realm.id) });
}

/** What a scoped region shows and where: the page's scope and the Realms it can offer. */
export interface ScopeView { workRef: string; scope: WorkScope; realms: readonly ScopeRealm[] }

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
    'flex h-9 max-w-64 items-center gap-1.5 rounded-xl px-3 font-medium text-sm outline-none transition-colors',
    'text-muted-foreground hover:bg-accent hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring',
    'aria-[current=true]:bg-primary/10 aria-[current=true]:text-primary')}>
    <Icon aria-hidden="true" className="size-4 shrink-0" />
    <span className="truncate">{children}</span>
  </Link>;
}

/**
 * Whose ratings, classification, adoption and discussion the view shows: Global, a Realm
 * or Mine. Realms offered are those that adopted the Work plus the one in the
 * URL. The line under it names the scope in words, so it is never implicit.
 */
export function ScopeBar({ workRef, scope, realms, locale, messages, tab = 'overview' }: {
  workRef: string; scope: WorkScope | null; realms: readonly ScopeRealm[]; locale: UiLocale;
  messages: WorkPageMessages; tab?: WorkTab;
}) {
  const t = materializeData(messages, { locale });
  const current = scope?.kind === 'realm' ? realms.find(realm => realm.id === scope.realm) : undefined;
  const realm = scope?.kind === 'realm' ? realmLabel(current ?? { id: scope.realm, name: null }, messages, locale) : '';
  const discussion = tab === 'discussion';
  const description = !scope ? null
    : scope.kind === 'global' ? (discussion ? t.scopeDiscussionGlobal : t.scopeGlobal)
      : scope.kind === 'mine' ? (discussion ? t.scopeDiscussionMine : t.scopeMine)
        : discussion ? t.scopeDiscussionRealm({ realm }) : t.scopeRealm({ realm });
  return <nav aria-label={t.scope} className="grid min-w-0 gap-2">
    <div className="flex">
      <ul className="flex min-w-0 flex-wrap gap-1 rounded-2xl border border-border/60 bg-card/80 p-1
        shadow-(--aura-shadow-card)">
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
    </div>
    <p className="text-muted-foreground text-xs">
      {description}{realms.length ? null : <> {t.noAdoptingRealms}</>}
    </p>
  </nav>;
}

export function ScopeBarSkeleton({ label }: { label: string }) {
  return <div role="status" aria-label={label} className="grid gap-2">
    <Skeleton className="h-11 w-64 rounded-2xl" /><Skeleton className="h-4 w-72 rounded-md" />
  </div>;
}

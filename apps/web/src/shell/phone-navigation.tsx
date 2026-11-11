import { createContext, useContext, useEffect, useRef, useState, type ReactNode } from 'react';
import { House, Inbox, Library, LogIn, Plus } from 'lucide-react';
import { Menu } from '@rezics/ui/menu';
import { UnreadBadgeView, useInboxUnreadCount, type UnreadCount } from '../inbox';
import { useOperation } from '../kernel/exposure';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import type { SessionState } from '../session/state';
import { NavigationEntries } from './navigation-view';
import { navigationPathMatches, navigationPathname } from './navigation';
import { useShellStyleNonce } from './csp-rendering/style-nonce';

type Session = SessionState | 'unknown';
/** A vertical supplies only actions it can currently offer, with its native route rechecking authority. */
export type PhoneCreationAction = { id: string; label: string; href: string };
type CreationRegistration = { owner: object; actions: readonly PhoneCreationAction[] };
const CreationContext = createContext<readonly PhoneCreationAction[]>([]);
const CreationRegistrationContext = createContext<((registration: CreationRegistration) => () => void) | null>(null);
export function PhoneCreationProvider({ children }: { children: ReactNode }) {
  const [owners, setOwners] = useState(() => new Map<object, CreationRegistration & { order: number }>());
  const [register] = useState(() => {
    // Effect cleanup precedes an action update. Keep that owner's original position across both steps.
    const order = new WeakMap<object, number>();
    let nextOrder = 0;
    return (registration: CreationRegistration) => {
      if (!order.has(registration.owner)) order.set(registration.owner, nextOrder++);
      const current = { ...registration, order: order.get(registration.owner)! };
      setOwners((previous) => new Map(previous).set(current.owner, current));
      return () =>
        setOwners((previous) => {
          if (previous.get(current.owner) !== current) return previous;
          const remaining = new Map(previous);
          remaining.delete(current.owner);
          return remaining;
        });
    };
  });
  const actions = [...owners.values()].sort((a, b) => a.order - b.order).flatMap((owner) => owner.actions);
  return (
    <CreationRegistrationContext value={register}>
      <CreationContext value={actions}>{children}</CreationContext>
    </CreationRegistrationContext>
  );
}
export function useRegisterPhoneCreationActions(actions: readonly PhoneCreationAction[]) {
  const register = useContext(CreationRegistrationContext);
  const owner = useRef({});
  useEffect(() => register?.({ owner: owner.current, actions }), [register, actions]);
}
function usePhoneUnread(session: Session) {
  const query = useInboxUnreadCount();
  return { ...query, data: session === 'signed-in' ? query.data : undefined };
}
export function PhoneUnreadDotView({ data, failed = false }: { data?: UnreadCount | undefined; failed?: boolean }) {
  return !failed && data?.signedIn && data.state === 'ready' && (data.count > 0 || data.capped) ? (
    <span
      aria-label={m.shell_new_activity()}
      className="absolute end-1 top-1 size-2 rounded-full bg-primary ring-2 ring-background"
    />
  ) : null;
}
export function PhoneUnreadDot({ session }: { session: Session }) {
  const { data, isError } = usePhoneUnread(session);
  return session === 'signed-in' ? <PhoneUnreadDotView data={data} failed={isError} /> : null;
}
export const phoneTabClass =
  'relative flex min-h-14 w-full min-w-0 flex-1 flex-col items-center justify-center gap-1 rounded-xl px-1 py-1 text-center text-[11px] leading-tight wrap-anywhere font-medium text-muted-foreground outline-none transition-colors duration-150 motion-reduce:transition-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:text-primary';
const creationLinkClass =
  'flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-3 py-2 text-sm wrap-anywhere whitespace-normal outline-none hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring [&_svg]:shrink-0';
export function PhoneCreationLinks({
  actions,
  pathname,
  session,
  returnTo,
}: {
  actions: readonly PhoneCreationAction[];
  pathname: string;
  session: Session;
  /** Router-admitted public URL, including its query, without the fragment. */
  returnTo?: string;
}) {
  if (session === 'unknown')
    return (
      <p role="status" aria-busy="true" className="p-3 text-sm text-muted-foreground">
        {m.candidate_loading()}
      </p>
    );
  if (session !== 'signed-in')
    return (
      <div className="grid gap-2">
        {session === 'unavailable' && (
          <p role="status" className="px-3 pt-3 text-sm text-muted-foreground">
            {m.shell_account_unavailable()}
          </p>
        )}
        <a className={creationLinkClass} href={shellSignInHref(pathname, returnTo)}>
          <LogIn aria-hidden="true" className="size-4" />
          <span className="min-w-0">{m.account_sign_in()}</span>
        </a>
      </div>
    );
  return (
    <div className="grid min-w-0 gap-2">
      {actions.map((action) => (
        <a key={action.id} className={creationLinkClass} href={action.href}>
          <span className="min-w-0">{action.label}</span>
        </a>
      ))}
      <NavigationEntries context={{ locale: getLocale(), pathname }} session={session} kind="creation">
        {(entry) => {
          if (actions.some((action) => action.href === entry.href)) return null;
          const Icon = entry.icon;
          if (entry.unavailable)
            return (
              <span role="link" aria-disabled="true" className={`${creationLinkClass} text-muted-foreground`}>
                {Icon && <Icon aria-hidden="true" className="size-4" />}
                <span className="min-w-0">{entry.label}</span>
              </span>
            );
          return (
            <a href={entry.href} className={creationLinkClass} aria-current={entry.current ? 'page' : undefined}>
              {Icon && <Icon aria-hidden="true" className="size-4" />}
              <span className="min-w-0">{entry.label}</span>
            </a>
          );
        }}
      </NavigationEntries>
      <p className="hidden p-3 text-sm text-muted-foreground only:block">{m.shell_creation_unavailable()}</p>
    </div>
  );
}
// Production passes publicHref. The fallback supports standalone shell patterns with either pathname shape.
export function shellSignInHref(pathname: string, returnTo?: string): string {
  const locale = getLocale();
  const path = navigationPathname({ locale, pathname });
  const destination = returnTo ?? `/${locale}${path === '/' ? '' : path}`;
  return `/auth/sign-in?return_to=${encodeURIComponent(destination)}`;
}

export function PhoneNavigationView({
  pathname,
  library,
  session,
  returnTo,
  unread,
  failed,
  actions,
  account,
}: {
  pathname: string;
  library: boolean;
  session: Session;
  returnTo?: string;
  unread?: UnreadCount | undefined;
  failed?: boolean;
  actions: readonly PhoneCreationAction[];
  account: ReactNode;
}) {
  const locale = getLocale();
  const nonce = useShellStyleNonce();
  const navigationContext = { locale, pathname };
  const signedInSession = session === 'signed-in';
  const signIn = shellSignInHref(pathname, returnTo);
  const inboxContent = (
    <>
      <span className="relative">
        <Inbox aria-hidden="true" className="size-5 shrink-0" />
        {signedInSession && (
          <span className="absolute -end-4 -top-2">
            <UnreadBadgeView data={unread} failed={failed ?? false} />
          </span>
        )}
      </span>
      <span>{m.nav_inbox()}</span>
    </>
  );
  return (
    <nav
      data-phone-navigation
      aria-label={m.shell_phone_tabs()}
      className="fixed inset-x-0 bottom-0 z-40 grid grid-cols-5 items-stretch gap-1 border-t border-border/60 bg-background/95 px-2 pt-2 pb-[max(.5rem,env(safe-area-inset-bottom))] backdrop-blur md:hidden"
    >
      <a
        className={phoneTabClass}
        href={`/${locale}`}
        aria-current={navigationPathMatches(navigationContext, '/', 'exact') ? 'page' : undefined}
      >
        <House aria-hidden="true" className="size-5 shrink-0" />
        <span>{m.nav_home()}</span>
      </a>
      {signedInSession && library ? (
        <a
          className={phoneTabClass}
          href={`/${locale}/library`}
          aria-current={
            navigationPathMatches(navigationContext, '/library', 'prefix') ||
            navigationPathMatches(navigationContext, '/collections', 'prefix')
              ? 'page'
              : undefined
          }
        >
          <Library aria-hidden="true" className="size-5 shrink-0" />
          <span>{m.nav_library()}</span>
        </a>
      ) : (
        <span className={phoneTabClass} role="link" aria-disabled="true">
          <Library aria-hidden="true" className="size-5 shrink-0" />
          <span>{m.nav_library()}</span>
        </span>
      )}
      <Menu
        title={m.shell_create()}
        closeOnNavigation
        trigger={
          <button type="button" className={`${phoneTabClass} group`}>
            <span className="grid h-9 w-12 place-items-center rounded-2xl bg-primary text-primary-foreground transition-transform duration-150 group-active:scale-95 motion-reduce:transform-none motion-reduce:transition-none">
              <Plus aria-hidden="true" className="size-5 shrink-0" />
            </span>
            <span>{m.shell_create()}</span>
          </button>
        }
        content={
          <PhoneCreationLinks
            actions={actions}
            pathname={pathname}
            session={session}
            {...(returnTo ? { returnTo } : {})}
          />
        }
      />
      {session === 'unknown' || session === 'unavailable' ? (
        <span
          data-phone-inbox-js
          role="link"
          aria-disabled="true"
          aria-busy={session === 'unknown' || undefined}
          className={phoneTabClass}
        >
          {inboxContent}
          <span className="sr-only">
            {session === 'unknown' ? m.candidate_loading() : m.shell_account_unavailable()}
          </span>
        </span>
      ) : (
        <a
          data-phone-inbox-js
          className={phoneTabClass}
          href={signedInSession ? `/${locale}/inbox` : signIn}
          aria-current={navigationPathMatches(navigationContext, '/inbox', 'prefix') ? 'page' : undefined}
        >
          {inboxContent}
        </a>
      )}
      <a data-phone-inbox-fallback className={`${phoneTabClass} hidden`} href={`/${locale}/inbox`}>
        <Inbox aria-hidden="true" className="size-5 shrink-0" />
        <span>{m.nav_inbox()}</span>
      </a>
      <div data-phone-you-js className="contents">
        {account}
      </div>
      <a data-phone-you-fallback className={`${phoneTabClass} hidden`} href={`/${locale}/settings`}>
        {m.shell_you()}
      </a>
      <noscript>
        <style nonce={nonce}>
          {
            '[data-phone-you-js],[data-phone-inbox-js]{display:none!important}[data-phone-you-fallback],[data-phone-inbox-fallback]{display:flex!important}'
          }
        </style>
      </noscript>
    </nav>
  );
}
export function useShellCreationActions(session: Session) {
  const collection = useOperation('collection.create');
  const contextualActions = useContext(CreationContext);
  const actions: PhoneCreationAction[] = [];
  if (session === 'signed-in') {
    const ids = new Set<string>();
    const destinations = new Set<string>();
    for (const action of [
      ...(collection
        ? [{ id: 'collection', label: m.library_collection_new(), href: `/${getLocale()}/collections/new` }]
        : []),
      ...contextualActions,
    ]) {
      if (!action.href.startsWith('/') || action.href.startsWith('//') || /[\\\r\n]/.test(action.href)) continue;
      if (ids.has(action.id) || destinations.has(action.href)) continue;
      ids.add(action.id);
      destinations.add(action.href);
      actions.push(action);
    }
  }
  return actions;
}
export function PhoneNavigation({
  session,
  pathname,
  returnTo,
  account,
}: {
  session: Session;
  pathname: string;
  csrfToken: string | null;
  returnTo: string;
  account: ReactNode;
}) {
  const library = useOperation('library_entry.list');
  const actions = useShellCreationActions(session);
  const unread = usePhoneUnread(session);
  return (
    <PhoneNavigationView
      pathname={pathname}
      library={session === 'signed-in' && library}
      session={session}
      returnTo={returnTo}
      unread={unread.data}
      failed={unread.isError}
      actions={actions}
      account={account}
    />
  );
}

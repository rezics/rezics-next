import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { Folders, House, Inbox, Library, ReceiptText, Search, ShieldCheck } from 'lucide-react';
import { useOperation } from '../kernel/exposure';
import { m } from '../paraglide/messages.js';
import {
  createNavigation,
  resolveNavigation,
  type NavigationContext,
  type NavigationContribution,
  type NavigationSession,
  type ResolvedNavigationEntry,
} from './navigation';

export const defaultNavigation = createNavigation([
  {
    id: 'shell.home',
    kind: 'navigation',
    group: 'primary',
    order: 0,
    href: '/',
    label: ({ locale }) => m.nav_home({}, { locale }),
    icon: House,
  },
  {
    id: 'shell.search',
    kind: 'navigation',
    group: 'primary',
    order: 10,
    href: '/search',
    label: ({ locale }) => m.nav_search({}, { locale }),
    icon: Search,
  },
  {
    id: 'shell.library',
    kind: 'navigation',
    group: 'personal',
    order: 0,
    href: '/library',
    label: ({ locale }) => m.nav_library({}, { locale }),
    icon: Library,
    match: 'prefix',
    signedIn: true,
    operation: 'library_entry.list',
    retainWhenUnavailable: true,
  },
  {
    id: 'shell.collections',
    kind: 'navigation',
    group: 'personal',
    order: 5,
    href: '/library/collections',
    label: ({ locale }) => m.library_nav_collections({}, { locale }),
    icon: Folders,
    match: 'prefix',
    signedIn: true,
    operation: 'collection.list',
    retainWhenUnavailable: true,
  },
  {
    id: 'shell.orders',
    kind: 'navigation',
    group: 'personal',
    order: 10,
    href: '/orders',
    label: ({ locale }) => m.nav_orders({}, { locale }),
    icon: ReceiptText,
    match: 'prefix',
    signedIn: true,
    operation: 'order.list',
  },
  {
    id: 'shell.inbox',
    kind: 'navigation',
    group: 'personal',
    order: 20,
    href: '/inbox',
    label: ({ locale }) => m.nav_inbox({}, { locale }),
    icon: Inbox,
    match: 'prefix',
    signedIn: true,
    desktopOnly: true,
  },
  {
    id: 'shell.catalogue-moderation',
    kind: 'navigation',
    group: 'personal',
    order: 30,
    href: '/moderation/workbench',
    label: ({ locale }) => m.moderation_workbench_heading({}, { locale }),
    icon: ShieldCheck,
    match: 'prefix',
    signedIn: true,
  },
]);
const NavigationContextValue = createContext(defaultNavigation);

export function NavigationProvider({
  contributions = [],
  children,
}: {
  contributions?: readonly NavigationContribution[];
  children: ReactNode;
}) {
  const entries = useMemo(() => createNavigation([...defaultNavigation, ...contributions]), [contributions]);
  return <NavigationContextValue.Provider value={entries}>{children}</NavigationContextValue.Provider>;
}

const subscribe = () => () => {};
function OperationEntry({
  entry,
  children,
}: {
  entry: ResolvedNavigationEntry;
  children: (entry: ResolvedNavigationEntry) => ReactNode;
}) {
  const offered = useOperation(entry.operation!);
  return offered ? children(entry) : entry.retainWhenUnavailable ? children({ ...entry, unavailable: true }) : null;
}

/** Shared by the desktop rail, script-free links and phone menus/CreateSheet. */
export function NavigationEntries({
  context,
  session,
  kind,
  desktop = false,
  children,
}: {
  context: NavigationContext;
  session: NavigationSession;
  kind?: NavigationContribution['kind'];
  desktop?: boolean;
  children: (entry: ResolvedNavigationEntry) => ReactNode;
}) {
  const entries = useContext(NavigationContextValue);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return resolveNavigation(entries, context).map((entry) => {
    if ((kind && entry.kind !== kind) || (entry.desktopOnly && !desktop)) return null;
    if (entry.signedIn && (!hydrated || session !== 'signed-in')) {
      return entry.retainWhenUnavailable ? (
        <span key={entry.id} className="contents">
          {children({ ...entry, unavailable: true })}
        </span>
      ) : null;
    }
    return (
      <NavigationEntry key={entry.id} entry={entry}>
        {children}
      </NavigationEntry>
    );
  });
}

function NavigationEntry({
  entry,
  children,
}: {
  entry: ResolvedNavigationEntry;
  children: (entry: ResolvedNavigationEntry) => ReactNode;
}) {
  return entry.operation ? <OperationEntry entry={entry}>{children}</OperationEntry> : children(entry);
}

export function NavigationLinks({
  label,
  className,
  ...props
}: Omit<Parameters<typeof NavigationEntries>[0], 'children'> & {
  label: string;
  className?: string;
}) {
  return (
    <nav aria-label={label} className={className ?? 'grid gap-1'}>
      <NavigationEntries {...props}>
        {(entry) => {
          const Icon = entry.icon;
          if (entry.unavailable)
            return (
              <span
                role="link"
                aria-disabled="true"
                aria-current={entry.current ? 'page' : undefined}
                title={m.library_subject_unavailable({}, { locale: props.context.locale })}
                className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm text-muted-foreground"
              >
                {Icon && <Icon aria-hidden="true" className="size-4" />}
                {entry.label}
                <span className="sr-only">{`: ${m.library_subject_unavailable({}, { locale: props.context.locale })}`}</span>
              </span>
            );
          return (
            <a
              href={entry.href}
              aria-current={entry.current ? 'page' : undefined}
              className="flex min-h-11 items-center gap-3 rounded-xl px-3 text-sm outline-none hover:bg-accent focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-medium"
            >
              {Icon && <Icon aria-hidden="true" className="size-4 text-sidebar-primary" />}
              {entry.label}
            </a>
          );
        }}
      </NavigationEntries>
    </nav>
  );
}

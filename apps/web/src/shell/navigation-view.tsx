import { createContext, useContext, useMemo, useSyncExternalStore, type ReactNode } from 'react';
import { House, Library, ReceiptText, Search } from 'lucide-react';
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
function OperationEntry({ entry, children }: { entry: ResolvedNavigationEntry; children: ReactNode }) {
  const offered = useOperation(entry.operation!);
  return offered ? children : null;
}

/** Shared by the desktop rail, script-free links and phone menus/CreateSheet. */
export function NavigationEntries({
  context,
  session,
  kind,
  children,
}: {
  context: NavigationContext;
  session: NavigationSession;
  kind?: NavigationContribution['kind'];
  children: (entry: ResolvedNavigationEntry) => ReactNode;
}) {
  const entries = useContext(NavigationContextValue);
  const hydrated = useSyncExternalStore(
    subscribe,
    () => true,
    () => false,
  );
  return resolveNavigation(entries, context).map((entry) => {
    if ((kind && entry.kind !== kind) || (entry.signedIn && (!hydrated || session !== 'signed-in'))) return null;
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
  const content = children(entry);
  return entry.operation ? <OperationEntry entry={entry}>{content}</OperationEntry> : content;
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

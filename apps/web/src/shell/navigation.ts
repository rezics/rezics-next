import type { LucideIcon } from 'lucide-react';
import type { useOperation } from '../kernel/exposure';
import type { locales } from '../paraglide/runtime.js';
import type { SessionState } from '../session/state';

export type NavigationSession = SessionState | 'unknown';
export type NavigationContext = Readonly<{ locale: (typeof locales)[number]; pathname: string }>;
export type NavigationOperation = Parameters<typeof useOperation>[0];
export type NavigationContribution = Readonly<
  {
    /** Stable, owner-namespaced identity, independent of label and locale. */
    id: string;
    order: number;
    label: string | ((context: NavigationContext) => string);
    /** An unprefixed site path. Returning null omits a context-unsupported entry. */
    href: `/${string}` | ((context: NavigationContext) => `/${string}` | null);
    icon?: LucideIcon;
    match?: 'exact' | 'prefix';
    signedIn?: boolean;
    /** Preserve an existing desktop-only destination without adding it to phone menus. */
    desktopOnly?: boolean;
    /** Keep a disabled destination visible when its existing operation is not offered. */
    retainWhenUnavailable?: boolean;
    /** Affordance only; the native destination still authorizes every read and command. */
    operation?: NavigationOperation;
  } & ({ kind: 'navigation'; group: 'primary' | 'personal' } | { kind: 'creation'; group: 'create' })
>;

export type ResolvedNavigationEntry = Readonly<
  Omit<NavigationContribution, 'label' | 'href'> & {
    label: string;
    path: `/${string}`;
    href: string;
    current: boolean;
    unavailable?: boolean;
  }
>;
const groups = { primary: 0, personal: 1, create: 2 } as const;

/** Copy static metadata into a snapshot; never register request or account state globally. */
export function createNavigation(contributions: readonly NavigationContribution[]): readonly NavigationContribution[] {
  const ids = new Set<string>();
  const entries = contributions.map((entry) => {
    if (!entry.id.trim() || !Number.isFinite(entry.order))
      throw new Error('Navigation requires a stable id and finite order');
    if (ids.has(entry.id)) throw new Error(`Duplicate navigation id: ${entry.id}`);
    ids.add(entry.id);
    return Object.freeze({ ...entry });
  });
  entries.sort(
    (a, b) => groups[a.group] - groups[b.group] || a.order - b.order || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0),
  );
  return Object.freeze(entries);
}

function pathOnly(path: string): string {
  return path.split(/[?#]/, 1)[0]!.replace(/\/+$/, '') || '/';
}

/** Router pathnames may already be unprefixed; document and story paths may include the current locale. */
export function navigationPathname(context: NavigationContext): string {
  const path = pathOnly(context.pathname);
  const prefix = `/${context.locale}`;
  return path === prefix ? '/' : path.startsWith(`${prefix}/`) ? path.slice(prefix.length) : path;
}

export function navigationPathMatches(
  context: NavigationContext,
  destination: string,
  match: 'exact' | 'prefix',
): boolean {
  const pathname = navigationPathname(context);
  const path = pathOnly(destination);
  return pathname === path || (match === 'prefix' && path !== '/' && pathname.startsWith(`${path}/`));
}

export function resolveNavigation(
  entries: readonly NavigationContribution[],
  context: NavigationContext,
): readonly ResolvedNavigationEntry[] {
  const publicContext = Object.freeze({ locale: context.locale, pathname: navigationPathname(context) });
  const destinations = new Set<string>();
  return entries.flatMap((entry): ResolvedNavigationEntry[] => {
    const path = typeof entry.href === 'function' ? entry.href(publicContext) : entry.href;
    if (path === null) return [];
    if (!path.startsWith('/') || path.startsWith('//') || /[\\\u0000-\u0020\u007f]/.test(path)) {
      throw new Error(`Navigation href must be a local path: ${entry.id}`);
    }
    const destination = `${entry.kind}:${path}`;
    if (destinations.has(destination)) throw new Error(`Duplicate navigation destination: ${path}`);
    destinations.add(destination);
    const currentPath = pathOnly(path);
    return [
      {
        ...entry,
        label: typeof entry.label === 'function' ? entry.label(publicContext) : entry.label,
        path,
        href: `/${context.locale}${path === '/' ? '' : path}`,
        current: navigationPathMatches(publicContext, currentPath, entry.match ?? 'exact'),
      },
    ];
  });
}

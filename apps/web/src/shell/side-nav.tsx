import { createContext, useContext, useId, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Globe, Settings2, Users } from 'lucide-react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useReaderCurrentOrigin } from '../session/reader';
import { navigationPathMatches } from './navigation';
import { useLocation } from '@tanstack/react-router';
import type { ShellCommunities } from './community-navigation';

const CommunitiesContext = createContext<ReactNode>(null);
export function SideNavProvider({ communities, children }: { communities?: ReactNode; children: ReactNode }) {
  return communities === undefined ? (
    <FollowedCommunities>{children}</FollowedCommunities>
  ) : (
    <CommunitiesContext value={communities}>{children}</CommunitiesContext>
  );
}
export const useSideNavCommunities = () => useContext(CommunitiesContext);

export function SideNav({
  items,
  pathname,
  footer,
}: {
  items: ShellCommunities['items'];
  pathname: string;
  footer?: ReactNode;
}) {
  const locale = getLocale();
  const context = { locale, pathname };
  const headingId = useId();
  return (
    <section aria-labelledby={headingId} className="mt-3 min-w-0 border-t border-border/60 pt-3">
      <h2 id={headingId} className="px-3 pb-2 text-xs font-semibold wrap-anywhere text-muted-foreground">
        {m.library_following_heading()}
      </h2>
      {items.length > 0 ? (
        <ul className="grid min-w-0 gap-1">
          {items.map((item) => {
            const Icon = item.kind === 'realm' ? Globe : Users;
            const current = navigationPathMatches(context, item.path, 'prefix');
            return (
              <li key={item.id} className="min-w-0">
                <a
                  href={`/${locale}${item.path}`}
                  title={item.title}
                  aria-current={current ? 'page' : undefined}
                  className="flex min-h-8 min-w-0 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs wrap-anywhere whitespace-normal outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30 aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-primary"
                >
                  <Icon aria-hidden="true" className="size-4 shrink-0 text-sidebar-primary" />
                  <span data-community-label lang={item.titleLanguage} className="min-w-0 wrap-anywhere">
                    {item.title}
                  </span>
                </a>
              </li>
            );
          })}
        </ul>
      ) : null}
      <div data-community-footer className="min-w-0 empty:hidden">{footer}</div>
      <a
        href={`/${locale}/library/following`}
        title={m.shell_manage_following()}
        className="mt-1 flex min-h-8 min-w-0 items-center gap-2 rounded-[calc(var(--radius-sm)+2px)] p-2 text-xs wrap-anywhere whitespace-normal text-muted-foreground outline-none hover:bg-accent hover:text-accent-foreground focus-visible:bg-accent focus-visible:ring-2 focus-visible:ring-ring/30"
      >
        <Settings2 aria-hidden="true" className="size-4 shrink-0" />
        <span data-community-label className="min-w-0 wrap-anywhere">
          {m.shell_manage_following()}
        </span>
      </a>
    </section>
  );
}

const operations = ['follow.list'] as const;
/** One identity/locale/gate-bound read shared by the rail and the phone drawer. */
function FollowedCommunities({ children }: { children: ReactNode }) {
  const locale = getLocale();
  const { pathname } = useLocation();
  const origin = useReaderCurrentOrigin(`shell-communities:${locale}`, operations);
  const current = () => origin.current(0);
  const read = useQuery(
    {
      queryKey: ['shell-communities', origin.subject, locale, origin.lifetime(0)],
      enabled: origin.hydrated && !!origin.subject && origin.allowed[0] === true,
      queryFn: async ({ signal }) => {
        const guard = () => {
          if (signal.aborted || !current()) throw new DOMException('Community viewer changed', 'AbortError');
        };
        guard();
        const { readShellCommunities } = await import('./community-navigation-actions');
        guard();
        const data = await readShellCommunities();
        guard();
        if (!data || data.subject !== origin.subject || data.locale !== locale)
          throw new Error('Community navigation unavailable');
        return data;
      },
      staleTime: 60_000,
      gcTime: 0,
      retry: false,
      refetchOnWindowFocus: false,
    },
    origin.client,
  );
  const visible = origin.hydrated && !!origin.subject && origin.allowed[0] && current();
  const data = read.isSuccess && read.data.subject === origin.subject && read.data.locale === locale ? read.data : null;
  const loading = !read.isError && !data;
  const status = read.isError
    ? m.library_follow_unavailable()
    : loading
      ? m.library_follow_loading()
      : data && data.items.length === 0
        ? m.library_following_page_empty()
        : null;
  const communities = visible ? (
    <SideNav
      items={data?.items ?? []}
      pathname={pathname}
      footer={
        status ? (
          <p
            role="status"
            aria-busy={loading || undefined}
            className="min-w-0 px-3 py-2 text-xs wrap-anywhere text-muted-foreground"
          >
            {status}
          </p>
        ) : null
      }
    />
  ) : null;
  return <CommunitiesContext value={communities}>{children}</CommunitiesContext>;
}

import { createContext, useContext, type ReactNode } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@rezics/ui/shadcn/collapsible';
import { ChevronDown, Globe, Users } from 'lucide-react';
import { getLocale } from '../paraglide/runtime.js';
import { m } from '../paraglide/messages.js';
import { useHistoryCurrentOrigin } from '../library/history-current-origin';
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
  return (
    <section aria-label={m.library_following_heading()} className="mt-3 min-w-0 border-t border-border/60 pt-3">
      {(['realm', 'space'] as const).map((kind) => (
        <section key={kind} aria-label={kind === 'realm' ? m.realms_heading() : m.library_following_spaces()}>
          <Collapsible defaultOpen>
            <h2>
              <CollapsibleTrigger className="group/community flex min-h-11 w-full items-center justify-between gap-2 rounded-xl px-3 text-start text-xs font-semibold text-muted-foreground hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring">
                {m.library_following_heading()} · {kind === 'realm' ? m.realms_heading() : m.library_following_spaces()}
                <ChevronDown
                  aria-hidden
                  className="size-4 shrink-0 transition-transform duration-150 group-aria-expanded/community:rotate-180 motion-reduce:transition-none"
                />
              </CollapsibleTrigger>
            </h2>
            <CollapsibleContent>
              <ul className="grid min-w-0 gap-1">
                {items
                  .filter((item) => item.kind === kind)
                  .map((item) => {
                    const Icon = kind === 'realm' ? Globe : Users;
                    const current =
                      navigationPathMatches(context, item.path, 'prefix') ||
                      (!!item.alternatePath && navigationPathMatches(context, item.alternatePath, 'prefix'));
                    return (
                      <li key={item.id} className="min-w-0">
                        <a
                          href={`/${locale}${item.path}`}
                          title={item.title}
                          aria-current={current ? 'page' : undefined}
                          className="flex min-h-11 min-w-0 items-center gap-3 rounded-xl px-3 text-sm hover:bg-accent focus-visible:ring-2 focus-visible:ring-ring aria-[current=page]:bg-accent aria-[current=page]:font-semibold aria-[current=page]:text-primary"
                        >
                          <Icon aria-hidden="true" className="size-4 shrink-0 text-primary" />
                          <span data-community-label className="truncate">
                            {item.title}
                          </span>
                        </a>
                      </li>
                    );
                  })}
              </ul>
            </CollapsibleContent>
          </Collapsible>
        </section>
      ))}
      <div data-community-footer>{footer}</div>
    </section>
  );
}

const operations = ['follow.list'] as const;
/** One identity/locale/gate-bound read shared by the rail and the phone drawer. */
function FollowedCommunities({ children }: { children: ReactNode }) {
  const locale = getLocale();
  const { pathname } = useLocation();
  const origin = useHistoryCurrentOrigin(`shell-communities:${locale}`, operations);
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
  const communities = visible ? (
    <SideNav
      items={data?.items ?? []}
      pathname={pathname}
      footer={
        <div className="px-3 py-2 text-xs text-muted-foreground">
          <p role="status">
            {read.isError
              ? m.library_follow_unavailable()
              : !data
                ? m.library_follow_loading()
                : data.items.length === 0
                  ? m.library_following_page_empty()
                  : null}
          </p>
          <a
            className="mt-2 inline-flex min-h-11 items-center text-sm text-primary hover:underline"
            href={`/${locale}/library/following`}
          >
            {m.library_following_heading()}
          </a>
        </div>
      }
    />
  ) : null;
  return <CommunitiesContext value={communities}>{children}</CommunitiesContext>;
}

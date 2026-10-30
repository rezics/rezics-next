import { Cover } from '@rezics/ui/cover';
import { ListRow, ListRowControl, ListRowLink } from '@rezics/ui/list-row';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { subjectHref } from '../subject/subject-href';
import { ResultRow, localizedLabel } from './results';
import { discoveryKey, type AccountDiscoverySummary, type DiscoveryState } from './discovery';

/** Only a current native handle can address the supported public account route. */
export function discoveryAccountHref(account: AccountDiscoverySummary, locale: string): string | undefined {
  return account.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account.handle)
    ? `/${encodeURIComponent(locale)}/@${encodeURIComponent(account.handle)}`
    : undefined;
}

function AccountRow({ account, kind, locale }: { account: AccountDiscoverySummary; kind: string; locale: string }) {
  const title = account.displayName || (account.handle ? `@${account.handle}` : m.discovery_unnamed_account());
  const href = discoveryAccountHref(account, locale);
  const verified = account.verifiedAgent;
  return (
    <ListRow className="flex min-w-0 items-start gap-4 py-2" data-discovery-account={account.id}>
      {href && <ListRowLink href={href}>{title}</ListRowLink>}
      <div className="w-[72px] shrink-0 sm:w-24">
        <Cover
          subject={{ id: account.id, title, types: [] }}
          cover={account.avatar}
          ratio="1:1"
          size="fill"
          src={coverSrc}
          decorative
        />
      </div>
      <div className="min-w-0 space-y-1">
        <h2 className="line-clamp-2 text-base leading-snug font-semibold" aria-hidden={href ? true : undefined}>
          {title}
        </h2>
        <p className="text-sm text-muted-foreground">{kind}</p>
        {account.handle && <p className="break-words text-sm text-muted-foreground">@{account.handle}</p>}
        {verified && (
          <ListRowControl className="text-sm">
            <a
              className="text-primary underline underline-offset-4"
              href={subjectHref({ id: verified.id, label: verified.label }, locale).href}
            >
              {m.discovery_verified_as({ name: verified.label })}
            </a>
          </ListRowControl>
        )}
      </div>
    </ListRow>
  );
}

/** The same region is used by the live page and every mixed-card story. No row performs a read. */
export function DiscoveryResults({ state, locale }: { state: DiscoveryState; locale: string }) {
  if (state.status !== 'ready' || state.page.hits.length === 0) {
    const message =
      state.status === 'loading'
        ? m.discovery_loading()
        : state.status === 'unavailable'
          ? m.search_failed()
          : state.status === 'not-ready'
            ? m.discovery_not_ready()
            : m.search_no_results();
    return (
      <Empty
        className="border"
        role={state.status === 'unavailable' ? 'alert' : 'status'}
        aria-busy={state.status === 'loading'}
      >
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{message}</EmptyTitle>
        </EmptyHeader>
      </Empty>
    );
  }
  const kinds = Object.fromEntries(state.page.kinds.values.map((kind) => [kind.id, kind.labels]));
  return (
    <ul role="list" className="space-y-2" data-slot="discovery-results">
      {state.page.hits.map((hit) => {
        const kind = localizedLabel(kinds[hit.key.kind] ?? {}, locale).text || hit.key.kind;
        if (hit.summary.kind === 'account')
          return <AccountRow key={discoveryKey(hit)} account={hit.summary.value} kind={kind} locale={locale} />;
        const summary = hit.summary.value;
        const label = summary.label;
        return (
          <ResultRow
            key={discoveryKey(hit)}
            hit={{
              id: hit.key.id,
              type: hit.key.kind,
              labels: label ? { [label.language]: label.value } : {},
              summary,
            }}
            locale={locale}
            hitTypes={kinds}
            yearProperties={[]}
          />
        );
      })}
    </ul>
  );
}

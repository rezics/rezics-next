import { Cover } from '@rezics/ui/cover';
import { ContentItem } from '@rezics/ui/content-item';
import { Empty, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { locales } from '../paraglide/runtime.js';
import { subjectHref } from '../subject/subject-href';
import { ResultRow, localizedLabel } from './results';
import { discoveryKey, isCatalogueHit, type AccountDiscoverySummary, type DiscoveryState } from './discovery';

function messageOptions(locale?: string) {
  return locale === undefined ? {} : { locale: locales.find((value) => value === locale) ?? 'en' };
}

/** Only a current native handle can address the supported public account route. */
export function discoveryAccountHref(account: AccountDiscoverySummary, locale: string): string | undefined {
  return account.handle && /^[A-Za-z0-9][A-Za-z0-9_-]{0,63}$/.test(account.handle)
    ? `/${encodeURIComponent(locale)}/@${encodeURIComponent(account.handle)}`
    : undefined;
}

function AccountRow({ account, kind, locale }: { account: AccountDiscoverySummary; kind: string; locale: string }) {
  const options = messageOptions(locale);
  const title =
    account.displayName || (account.handle ? `@${account.handle}` : m.discovery_unnamed_account({}, options));
  const href = discoveryAccountHref(account, locale);
  const verified = account.verifiedAgent;
  return (
    <ContentItem
      data-discovery-account={account.id}
      title={title}
      {...(href !== undefined ? { href } : {})}
      visual={
        <div className="w-[72px] sm:w-24">
          <Cover
            subject={{ id: account.id, title, types: [] }}
            cover={account.avatar}
            ratio="1:1"
            size="fill"
            src={coverSrc}
            decorative
          />
        </div>
      }
      metadata={
        <div className="min-w-0 space-y-1">
          <p className="text-sm text-muted-foreground">{kind}</p>
          {account.handle && <p className="break-words text-sm text-muted-foreground">@{account.handle}</p>}
          {verified && (
            <a
              className="text-primary underline underline-offset-4"
              href={subjectHref({ id: verified.id, label: verified.label }, locale).href}
            >
              {m.discovery_verified_as({ name: verified.label }, options)}
            </a>
          )}
        </div>
      }
    />
  );
}

/** The same region is used by the live page and every mixed-card story. No row performs a read. Locale is optional for DiscoveryKinds. */
export function discoveryMessage(status: DiscoveryState['status'], locale?: string): string {
  const options = messageOptions(locale);
  switch (status) {
    case 'loading':
      return m.discovery_loading({}, options);
    case 'not-ready':
      return m.discovery_not_ready({}, options);
    case 'preparing':
      return m.discovery_preparing({}, options);
    case 'closed':
      return m.discovery_closed({}, options);
    case 'restart':
      return m.discovery_restart({}, options);
    case 'invalid':
      return m.discovery_invalid({}, options);
    case 'unsupported':
      return m.discovery_unsupported({}, options);
    case 'denied':
      return m.discovery_denied({}, options);
    case 'ready':
      return m.search_no_results({}, options);
    default:
      return m.search_failed({}, options);
  }
}

export function DiscoveryResults({
  state,
  locale,
  yearProperties = [],
  restartHref,
}: {
  state: DiscoveryState;
  locale: string;
  yearProperties?: string[];
  restartHref?: string | undefined;
}) {
  if (state.status !== 'ready' || state.page.hits.length === 0) {
    const options = messageOptions(locale);
    const message = discoveryMessage(state.status, locale);
    return (
      <Empty
        className="border"
        role={
          ['unavailable', 'restart', 'closed', 'invalid', 'unsupported', 'denied'].includes(state.status)
            ? 'alert'
            : 'status'
        }
        aria-busy={state.status === 'loading'}
      >
        <EmptyHeader>
          <EmptyTitle className="text-base font-normal">{message}</EmptyTitle>
        </EmptyHeader>
        {restartHref && state.status !== 'ready' && state.status !== 'loading' && (
          <a href={restartHref} className={buttonVariants({ variant: 'outline' })}>
            {state.status === 'restart' ? m.discovery_restart_action({}, options) : m.search_facet_retry({}, options)}
          </a>
        )}
      </Empty>
    );
  }
  const kinds = Object.fromEntries(state.page.kinds.values.map((kind) => [kind.id, kind.labels]));
  return (
    <ul role="list" className="space-y-2" data-slot="discovery-results">
      {state.page.hits.map((hit) => {
        const kind = localizedLabel(kinds[hit.key.kind] ?? {}, locale).text || hit.key.kind;
        if (!isCatalogueHit(hit))
          return <AccountRow key={discoveryKey(hit)} account={hit.summary.value} kind={kind} locale={locale} />;
        const summary = hit.summary.value;
        const label = summary.label;
        return (
          <ResultRow
            key={discoveryKey(hit)}
            hit={{
              id: hit.key.id,
              type: hit.key.kind,
              ...hit,
              labels: hit.labels ?? (label ? { [label.language]: label.value } : {}),
              summary,
            }}
            locale={locale}
            hitTypes={kinds}
            yearProperties={yearProperties}
          />
        );
      })}
    </ul>
  );
}

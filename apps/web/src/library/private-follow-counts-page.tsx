import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { useRef } from 'react';
import { usePrivateReportOrigin, usePrivateReportPayload } from './private-report-current-origin';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { PageHeading } from '../shell/page-heading';
import { privateFollowCountsHref } from './private-follow-counts-link';
import {
  followCountsSearch,
  privateFollowCountsQuery,
  type FollowCountsRead,
  type FollowCountsReader,
  type FollowCountsSearch,
  type FollowCountState,
} from './private-follow-counts';

function CountOutcome({ value, context }: { value: FollowCountState; context: FollowCountsSearch }) {
  if (value.state === 'ready')
    return (
      <p data-follow-count={value.count} className="text-4xl font-semibold tabular-nums">
        {new Intl.NumberFormat(getLocale()).format(value.count)}
      </p>
    );
  const text =
    value.state === 'loading'
      ? m.library_follow_counts_loading()
      : value.state === 'closed'
        ? m.platform_closed_heading()
        : value.state === 'denied'
          ? m.library_follow_counts_denied()
          : value.state === 'signed-out'
            ? m.library_sign_in()
            : m.library_follow_counts_unavailable();
  const retryAfter = 'retryAfter' in value ? value.retryAfter : undefined;
  const retryDate = retryAfter ? Date.parse(retryAfter) : NaN;
  const retryText =
    retryAfter && /^\d+$/.test(retryAfter)
      ? m.library_follow_counts_retry_after({ value: retryAfter })
      : Number.isFinite(retryDate)
        ? m.library_follow_counts_retry_at({
            value: new Intl.DateTimeFormat(getLocale(), { dateStyle: 'short', timeStyle: 'short' }).format(retryDate),
          })
        : null;
  return (
    <div className="space-y-2" role={value.state === 'loading' ? 'status' : 'alert'}>
      <p>{text}</p>
      {retryText ? <p className="text-sm text-muted-foreground">{retryText}</p> : null}
      {value.state === 'signed-out' ? (
        <a
          className="text-primary underline"
          href={`/auth/sign-in?return_to=${encodeURIComponent(
            context.targetType && context.targetId
              ? (privateFollowCountsHref({ targetType: context.targetType, targetId: context.targetId }) ??
                  `/${getLocale()}/library/follow-counts`)
              : `/${getLocale()}/library/follow-counts`,
          )}`}
        >
          {m.account_sign_in()}
        </a>
      ) : null}
    </div>
  );
}

export function PrivateFollowCountsPageView({
  page,
  busy = false,
  onReload,
}: {
  page: FollowCountsRead;
  busy?: boolean;
  onReload?: () => void;
}) {
  const context = page.context;
  return (
    <article className="container mx-auto max-w-4xl space-y-8 px-4 py-8 text-foreground">
      <header className="space-y-3">
        <a href={`/${getLocale()}/library`} className="text-sm text-primary underline">
          {m.nav_library()}
        </a>
        <PageHeading>{m.library_follow_counts_heading()}</PageHeading>
        <p className="max-w-prose text-muted-foreground">{m.library_follow_counts_description()}</p>
      </header>
      <section className="space-y-3" aria-labelledby="outgoing-count-heading" aria-busy={busy}>
        <h2 id="outgoing-count-heading" className="text-xl font-semibold">
          {m.library_follow_counts_outgoing()}
        </h2>
        <CountOutcome value={page.outgoing} context={context} />
        <a
          href={`/${getLocale()}/library/following`}
          className="inline-flex min-h-10 items-center text-primary underline"
        >
          {m.library_nav_following()}
        </a>
      </section>
      <section
        className="space-y-3 border-t border-border pt-6"
        aria-labelledby="target-count-heading"
        aria-busy={busy}
      >
        <h2 id="target-count-heading" className="text-xl font-semibold">
          {m.library_follow_counts_target()}
        </h2>
        {context.invalidContext ? (
          <p role="status">{m.library_follow_counts_invalid_context()}</p>
        ) : context.targetType && context.targetId ? (
          <>
            <p className="text-sm text-muted-foreground">
              {context.targetType === 'collection'
                ? m.library_following_kind_collection()
                : context.targetType === 'space'
                  ? m.library_following_kind_space()
                  : m.library_following_subjects()}
            </p>
            <CountOutcome
              value={page.target ?? (busy ? { state: 'loading' } : { state: 'unavailable' })}
              context={context}
            />
          </>
        ) : (
          <p className="max-w-prose text-muted-foreground">{m.library_follow_counts_context_help()}</p>
        )}
      </section>
      {onReload ? (
        <Button type="button" variant="outline" disabled={busy} onClick={onReload}>
          {m.library_follow_counts_reload()}
        </Button>
      ) : null}
    </article>
  );
}

function reportAddress(context: FollowCountsSearch, locale: string): string {
  return JSON.stringify([context.targetType, context.targetId, !!context.invalidContext, locale]);
}

function reportAddressAt(href: string, locale: string): string {
  const url = new URL(href, 'https://report.invalid');
  const parts = url.pathname.replace(/\/$/, '').split('/').filter(Boolean);
  return parts.at(-1) === 'follow-counts' && parts.at(-2) === 'library' && parts.length <= 3
    ? reportAddress(followCountsSearch(Object.fromEntries(url.searchParams)), parts.length === 3 ? parts[0]! : locale)
    : href;
}

export function PrivateFollowCountsPage({
  context: input,
  read,
}: {
  context: FollowCountsSearch;
  read?: FollowCountsReader;
}) {
  const client = useQueryClient();
  const context = followCountsSearch(input);
  const locale = getLocale();
  const { origin, value, hydrated } = usePrivateReportOrigin(reportAddress(context, locale), locale, (href) =>
    reportAddressAt(href, locale),
  );
  const current = origin.capture('personal_library');
  const lifetime = { key: origin.version('personal_library'), isCurrent: current, locale };
  const payload = useRef<{ owner: number; page?: Awaited<ReturnType<FollowCountsReader>> }>({ owner: value.owner });
  if (payload.current.owner !== value.owner) payload.current = { owner: value.owner };
  const options = privateFollowCountsQuery(
    { subject: value.subject ?? '', csrfToken: value.csrfToken },
    context,
    read,
    lifetime,
  );
  const query = useQuery({
    ...options,
    enabled: hydrated && current(),
    // A healthy refresh keeps the actual read and its captured credential; it does not perform another GET.
    ...(payload.current.page ? { initialData: payload.current.page } : {}),
  });
  const capturePayload = usePrivateReportPayload(client, options.queryKey);
  const sameRead = capturePayload(query.data);
  const sameReload = capturePayload(query.data, false);
  const busy =
    !hydrated ||
    (!value.unavailable && value.state !== 'signed-out' && !value.authority) ||
    (current() && (query.isPending || query.isFetching));
  const outcome: FollowCountState = {
    state: !hydrated
      ? 'loading'
      : value.state === 'signed-out'
        ? 'signed-out'
        : value.unavailable
          ? 'unavailable'
          : value.state === 'unknown'
            ? 'loading'
            : !value.subject
              ? 'unavailable'
              : value.authority && !current()
                ? 'closed'
                : busy || !value.authority
                  ? 'loading'
                  : 'unavailable',
  };
  const candidate = query.data;
  const actualContext = followCountsSearch(candidate?.context);
  const matches =
    candidate &&
    candidate.locale === locale &&
    actualContext.targetType === context.targetType &&
    actualContext.targetId === context.targetId &&
    !!actualContext.invalidContext === !!context.invalidContext &&
    (candidate.viewer === null
      ? candidate.outgoing.state !== 'ready' && candidate.target?.state !== 'ready'
      : candidate.viewer.subject === value.subject &&
        (candidate.viewer.csrfToken === value.csrfToken || candidate === payload.current.page));
  const accepted = hydrated && current() && sameRead() && !query.isFetching && matches ? candidate : undefined;
  if (accepted) payload.current.page = accepted;
  const page: FollowCountsRead = accepted ?? {
    context,
    outgoing: outcome,
    target: context.targetType && context.targetId ? outcome : null,
  };
  return (
    <PrivateFollowCountsPageView
      page={page}
      busy={busy}
      {...(hydrated && current()
        ? {
            onReload: () => {
              if (current() && sameReload() && client.getQueryState(options.queryKey)?.fetchStatus !== 'fetching')
                void query.refetch();
            },
          }
        : {})}
    />
  );
}

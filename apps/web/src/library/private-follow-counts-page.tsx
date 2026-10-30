import { useQuery } from '@tanstack/react-query';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import { useSession } from '../session/query';
import { PageHeading } from '../shell/page-heading';
import { privateFollowCountsHref } from './private-follow-counts-link';
import {
  privateFollowCountsQuery,
  type FollowCountsRead,
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

export function PrivateFollowCountsPage({ context }: { context: FollowCountsSearch }) {
  const session = useSession();
  const viewer = { subject: session.subject ?? '', csrfToken: session.csrfToken ?? '' };
  const query = useQuery({
    ...privateFollowCountsQuery(viewer, context),
    enabled: session.state === 'signed-in' && !!viewer.subject && !!viewer.csrfToken,
  });
  const preparing =
    session.state === 'unknown' ||
    (session.state === 'signed-in' && !!viewer.subject && !!viewer.csrfToken && query.isPending);
  // Hide the previous scalar during refresh, identity changes, session failure and sign-out.
  const page: FollowCountsRead =
    session.state === 'signed-in' && !query.isFetching && !query.isError && query.data
      ? query.data
      : {
          context,
          outgoing: {
            state:
              preparing || query.isFetching ? 'loading' : session.state === 'signed-out' ? 'signed-out' : 'unavailable',
          },
          target: null,
        };
  return (
    <PrivateFollowCountsPageView
      page={page}
      busy={preparing || query.isFetching}
      {...(session.state === 'signed-in' ? { onReload: () => void query.refetch() } : {})}
    />
  );
}

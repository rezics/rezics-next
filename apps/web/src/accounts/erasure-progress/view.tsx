import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@rezics/ui/shadcn/card';
import { m } from '../../paraglide/messages.js';
import { getLocale, locales } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import { routedId } from '../resource-access/data';
import type { Page } from './data';

/** Only an existing local erasure route can be a sign-in return; selection never supplies authority. */
export function erasureSignInHref(returnTo = '/') {
  let path = '/';
  if (returnTo.startsWith('/') && !/[\\\u0000-\u0020\u007f]/u.test(returnTo)) {
    const match = new RegExp(`^/(?:(${locales.join('|')})/)?platform/accounts/([^/]+)/erasure$`).exec(
      returnTo.split(/[?#]/u)[0]!,
    );
    if (match && routedId(match[2])) path = returnTo;
  }
  return `/auth/sign-in?return_to=${encodeURIComponent(path)}`;
}

function participantLabel(name: string) {
  const labels: Record<string, () => string> = {
    access: m.erasure_participant_access,
    auth: m.erasure_participant_auth,
    library: m.erasure_participant_library,
    commerce: m.erasure_participant_commerce,
    content: m.erasure_participant_content,
    community: m.erasure_participant_community,
    semantic: m.erasure_participant_semantic,
    search: m.erasure_participant_search,
    imports: m.erasure_participant_imports,
    'shared-history': m.erasure_participant_history,
    delivery: m.erasure_participant_delivery,
  };
  return (Object.hasOwn(labels, name) ? labels[name]! : m.erasure_participant_other)();
}

function statusText(status: Page['status']) {
  switch (status) {
    case 'loading':
      return m.erasure_loading();
    case 'signed-out':
      return m.erasure_signed_out();
    case 'denied':
      return m.erasure_denied();
    case 'missing':
      return m.erasure_missing();
    default:
      return m.erasure_unavailable();
  }
}
function date(value: string) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(getLocale(), {
        dateStyle: 'medium',
        timeStyle: 'long',
        timeZone: 'UTC',
      }).format(new Date(value))}
    </time>
  );
}
export function ErasureProgressView({
  page,
  reload,
  returnTo,
  sessionRecovery = false,
}: {
  page: Page;
  reload?: (() => void) | undefined;
  returnTo?: string | undefined;
  sessionRecovery?: boolean;
}) {
  const value = page.status === 'ready' ? page.value : null;
  return (
    <article className="mx-auto flex w-full max-w-2xl flex-col gap-6 pb-8">
      <header className="flex flex-col gap-3">
        <PageHeading>{m.erasure_title()}</PageHeading>
        <p className="text-muted-foreground">{m.erasure_intro()}</p>
      </header>
      <section aria-live="polite" aria-busy={page.status === 'loading'} className="flex flex-col gap-4">
        {value ? (
          <Card>
            <CardHeader>
              <CardTitle>
                <h2>
                  {value.state === 'complete'
                    ? m.erasure_complete()
                    : value.state === 'retention-outstanding'
                      ? m.erasure_retention()
                      : m.erasure_pending()}
                </h2>
              </CardTitle>
              <CardDescription>
                {value.state === 'retention-outstanding'
                  ? m.erasure_retention_help()
                  : value.state === 'complete'
                    ? m.erasure_complete_help()
                    : m.erasure_pending_help()}
              </CardDescription>
            </CardHeader>
            <CardContent className="flex flex-col gap-4">
              <dl className="grid gap-2">
                <dt className="font-medium">{m.erasure_barrier()}</dt>
                <dd>{date(value.at)}</dd>
                <dt className="font-medium">{m.erasure_completed_at()}</dt>
                <dd>{value.completedAt ? date(value.completedAt) : m.erasure_not_reported()}</dd>
              </dl>
              <section aria-labelledby="erasure-participants" className="flex flex-col gap-2">
                <h3 id="erasure-participants" className="font-medium">
                  {m.erasure_participants()}
                </h3>
                {value.pendingParticipants.length ? (
                  <ul className="list-inside list-disc">
                    {value.pendingParticipants.map((name) => (
                      <li key={name}>{participantLabel(name)}</li>
                    ))}
                  </ul>
                ) : (
                  <p>{m.erasure_no_pending_names()}</p>
                )}
              </section>
              <ul className="flex list-inside list-disc flex-col gap-2">
                <li>{value.retentionOutstanding ? m.erasure_retained_yes() : m.erasure_retained_no()}</li>
                <li>{value.lateItems ? m.erasure_late_yes() : m.erasure_late_no()}</li>
                <li>{value.effectsFrontier ? m.erasure_frontier_yes() : m.erasure_frontier_no()}</li>
              </ul>
              <details className="rounded-lg border p-4">
                <summary className="cursor-pointer font-medium focus-visible:outline-ring">
                  {m.erasure_details()}
                </summary>
                <dl className="mt-4 grid gap-2">
                  <dt className="font-medium">{m.erasure_account()}</dt>
                  <dd className="break-all font-mono text-sm">{value.accountId}</dd>
                  {value.pendingParticipants.length ? (
                    <>
                      <dt className="font-medium">{m.erasure_participant_identifiers()}</dt>
                      <dd>
                        <ul className="flex flex-col gap-2">
                          {value.pendingParticipants.map((name) => (
                            <li key={name}>
                              {participantLabel(name)}: <code className="break-all">{name}</code>
                            </li>
                          ))}
                        </ul>
                      </dd>
                    </>
                  ) : null}
                </dl>
              </details>
            </CardContent>
          </Card>
        ) : (
          <p role="status">
            {sessionRecovery && page.status === 'unavailable'
              ? m.erasure_session_unavailable()
              : statusText(page.status)}
          </p>
        )}
      </section>
      {page.status === 'signed-out' ? (
        <a
          className="self-start font-medium text-primary underline underline-offset-4"
          href={erasureSignInHref(returnTo)}
        >
          {m.erasure_sign_in()}
        </a>
      ) : null}
      {reload && page.status !== 'signed-out' ? (
        <Button className="self-start" variant="outline" disabled={page.status === 'loading'} onClick={reload}>
          {sessionRecovery ? m.erasure_retry_session() : m.erasure_reload()}
        </Button>
      ) : null}
    </article>
  );
}

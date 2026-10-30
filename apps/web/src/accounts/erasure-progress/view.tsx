import { Button } from '@rezics/ui/shadcn/button';
import { Card, CardHeader, CardTitle, CardDescription, CardContent } from '@rezics/ui/shadcn/card';
import { m } from '../../paraglide/messages.js';
import { getLocale } from '../../paraglide/runtime.js';
import { PageHeading } from '../../shell/page-heading';
import type { Page } from './data';

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
export function ErasureProgressView({ page, reload }: { page: Page; reload?: () => void }) {
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
                <dt className="font-medium">{m.erasure_account()}</dt>
                <dd className="break-all font-mono text-sm">{value.accountId}</dd>
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
                      <li className="break-all font-mono text-sm" key={name}>
                        {name}
                      </li>
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
            </CardContent>
          </Card>
        ) : (
          <p role="status">{statusText(page.status)}</p>
        )}
      </section>
      {reload ? (
        <Button className="self-start" variant="outline" disabled={page.status === 'loading'} onClick={reload}>
          {m.erasure_reload()}
        </Button>
      ) : null}
    </article>
  );
}

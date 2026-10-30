import { Cover } from '@rezics/ui/cover';
import { ListRow, ListRowLink } from '@rezics/ui/list-row';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Badge } from '@rezics/ui/shadcn/badge';
import { Button, buttonVariants } from '@rezics/ui/shadcn/button';
import { Empty, EmptyDescription, EmptyHeader, EmptyTitle } from '@rezics/ui/shadcn/empty';
import { coverSrc } from '../media/cover-src';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { BuyerEntitlement, BuyerEntitlementsPage, EntitlementsRead } from './entitlements';
import { subjectCover } from './subject-cover';

export function EntitlementStatus({ record }: { record: BuyerEntitlement }) {
  return (
    <Badge variant={record.active ? 'secondary' : 'outline'}>
      {record.active ? m.entitlements_active() : m.entitlements_revoked()}
    </Badge>
  );
}

export function EntitlementTime({ value, locale }: { value: string; locale: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(new Date(value))}
    </time>
  );
}

export function EntitlementsState({
  kind,
  locale,
  retry,
}: {
  kind: Exclude<EntitlementsRead<never>['kind'], 'ready'>;
  locale: string;
  retry?: () => void;
}) {
  const message =
    kind === 'denied'
      ? m.entitlements_denied()
      : kind === 'preparing'
        ? m.entitlements_preparing()
        : kind === 'cursor-error'
          ? m.entitlements_cursor_error()
          : m.entitlements_unavailable();
  return (
    <Alert role={kind === 'preparing' ? 'status' : 'alert'}>
      <AlertDescription className="space-y-4">
        <p>{message}</p>
        {kind === 'cursor-error' ? (
          <a href={`/${locale}/entitlements`} className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}>
            {m.entitlements_restart()}
          </a>
        ) : kind !== 'denied' ? (
          <Button variant="outline" className="min-h-11" onClick={retry ?? (() => window.location.reload())}>
            {m.entitlements_retry()}
          </Button>
        ) : null}
      </AlertDescription>
    </Alert>
  );
}

export function EntitlementsPage({
  page,
  locale,
  retry,
}: {
  page: BuyerEntitlementsPage;
  locale: string;
  retry?: () => void;
}) {
  return (
    <section className="max-w-4xl min-w-0 space-y-6" aria-labelledby="entitlements-heading">
      <header className="space-y-3">
        <PageHeading id="entitlements-heading">{m.entitlements_heading()}</PageHeading>
        <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.entitlements_intro()}</p>
        <a href={`/${locale}/orders`} className={buttonVariants({ variant: 'link', className: 'min-h-11 px-0' })}>
          {m.entitlements_orders()}
        </a>
      </header>
      {page.kind !== 'ready' ? (
        <EntitlementsState kind={page.kind} locale={locale} {...(retry ? { retry } : {})} />
      ) : page.data.entitlements.length === 0 ? (
        <Empty className="border border-border">
          <EmptyHeader>
            <EmptyTitle>{page.data.next ? m.entitlements_page_empty() : m.entitlements_empty()}</EmptyTitle>
            <EmptyDescription>{m.entitlements_empty_hint()}</EmptyDescription>
          </EmptyHeader>
        </Empty>
      ) : (
        <ul className="space-y-3">
          {page.data.entitlements.map((record) => {
            const { subject, cover } = subjectCover(
              locale,
              record.targetSubjectId,
              m.entitlements_hidden_subject(),
              record.summary,
            );
            return (
              <ListRow key={record.id} className="flex min-w-0 gap-4 p-2" data-entitlement-id={record.id}>
                <Cover subject={subject} cover={cover} size="xs" src={coverSrc} decorative />
                <div className="min-w-0 flex-1 space-y-2">
                  <div className="flex flex-wrap items-start justify-between gap-2">
                    <h2 className="min-w-0 break-words font-semibold" lang={record.summary?.label?.language}>
                      {subject.title}
                    </h2>
                    <EntitlementStatus record={record} />
                  </div>
                  <p className="text-sm text-muted-foreground">
                    {m.entitlements_granted()} <EntitlementTime value={record.grantedAt} locale={locale} />
                  </p>
                  <p className="break-all text-xs text-muted-foreground">
                    {m.entitlements_record_id()}: {record.id}
                  </p>
                </div>
                <ListRowLink href={`/${locale}/entitlements/${record.id}`}>
                  {m.entitlements_open({ title: subject.title })}
                </ListRowLink>
              </ListRow>
            );
          })}
        </ul>
      )}
      {page.kind === 'ready' && page.data.next ? (
        <nav aria-label={m.entitlements_pagination()}>
          <a
            href={`/${locale}/entitlements?cursor=${encodeURIComponent(page.data.next)}`}
            className={buttonVariants({ variant: 'outline', className: 'min-h-11' })}
          >
            {m.entitlements_next()}
          </a>
        </nav>
      ) : null}
    </section>
  );
}

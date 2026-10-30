import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { BuyerEntitlementPage } from './entitlements';
import { EntitlementStatus, EntitlementTime, EntitlementsState } from './entitlements-page';
import { SubjectCover, subjectCover } from './subject-cover';

export function EntitlementPage({
  page,
  locale,
  retry,
}: {
  page: BuyerEntitlementPage;
  locale: string;
  retry?: () => void;
}) {
  const record = page.kind === 'ready' ? page.data : null;
  const subject = record
    ? subjectCover(locale, record.targetSubjectId, m.entitlements_hidden_subject(), record.summary)
    : null;
  return (
    <article className="max-w-4xl min-w-0 space-y-6" aria-labelledby="entitlement-heading">
      <Button render={<a href={`/${locale}/entitlements`} />} variant="link" className="min-h-11 px-0">
        {m.entitlements_heading()}
      </Button>
      <PageHeading id="entitlement-heading">{m.entitlements_detail_heading()}</PageHeading>
      {page.kind !== 'ready' ? (
        <EntitlementsState kind={page.kind} locale={locale} {...(retry ? { retry } : {})} />
      ) : record && subject ? (
        <>
          <div className="flex min-w-0 items-start gap-4 sm:gap-6">
            <SubjectCover data={subject} size="sm" />
            <div className="min-w-0 space-y-3">
              <h2 className="break-words text-xl font-semibold" lang={record.summary?.label?.language}>
                {subject.subject.title}
              </h2>
              <EntitlementStatus record={record} />
              {subject.href ? (
                <p>
                  <a
                    href={subject.href}
                    className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
                  >
                    {m.entitlements_subject_link()}
                  </a>
                </p>
              ) : null}
            </div>
          </div>
          <Alert>
            <AlertDescription>{m.entitlements_delivery_unknown()}</AlertDescription>
          </Alert>
          <dl className="grid min-w-0 grid-cols-1 gap-y-2 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-6 sm:gap-y-4 [&>dt]:text-muted-foreground [&>dd]:mb-3 [&>dd]:break-words sm:[&>dd]:mb-0">
            <dt>{m.entitlements_granted()}</dt>
            <dd>
              <EntitlementTime value={record.grantedAt} locale={locale} />
            </dd>
            {record.revokedAt !== null ? (
              <>
                <dt>{m.entitlements_revoked_at()}</dt>
                <dd>
                  <EntitlementTime value={record.revokedAt} locale={locale} />
                </dd>
              </>
            ) : null}
            {record.revokeReason !== null ? (
              <>
                <dt>{m.entitlements_revoke_reason()}</dt>
                <dd>
                  {record.revokeReason === 'refund' ? m.entitlements_refund() : m.entitlements_dispute()}{' '}
                  <span className="text-muted-foreground">({record.revokeReason})</span>
                </dd>
              </>
            ) : null}
            <dt>{m.entitlements_record_id()}</dt>
            <dd className="break-all">{record.id}</dd>
            <dt>{m.order_reference()}</dt>
            <dd>
              <a
                href={`/${locale}/orders/${record.orderId}`}
                className="inline-flex min-h-11 break-all items-center text-primary underline underline-offset-4"
              >
                {record.orderId}
              </a>
            </dd>
            <dt>{m.entitlements_offer_id()}</dt>
            <dd className="break-all">{record.offerId}</dd>
          </dl>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.entitlements_history_hint()}</p>
        </>
      ) : null}
    </article>
  );
}

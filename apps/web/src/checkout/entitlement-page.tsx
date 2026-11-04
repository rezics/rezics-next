import { purchaseHistoryHref, type PurchaseHistoryPosition } from './purchase-return';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { BuyerEntitlementPage } from './entitlements';
import { EntitlementStatus, EntitlementTime, EntitlementsState } from './entitlements-page';
import { SubjectCover, subjectCover } from './subject-cover';
import { capturedBenefit } from './benefit';
import { BenefitDetails } from './benefit-details';

export function EntitlementPage({
  page,
  locale,
  retry,
  history = {},
  onOpenReader,
}: {
  page: BuyerEntitlementPage;
  locale: string;
  retry?: () => void;
  history?: PurchaseHistoryPosition | undefined;
  onOpenReader?: (editionId: string, href: string) => boolean;
}) {
  const record = page.kind === 'ready' ? page.data : null;
  const subject = record
    ? subjectCover(locale, record.targetSubjectId, m.entitlements_hidden_subject(), record.summary)
    : null;
  return (
    <article className="max-w-4xl min-w-0 space-y-6" aria-labelledby="entitlement-heading">
      <a
        href={purchaseHistoryHref(locale, 'entitlements', history)}
        className={buttonVariants({ variant: 'link', className: 'min-h-11 px-0' })}
      >
        {m.entitlements_heading()}
      </a>
      <PageHeading id="entitlement-heading">{m.entitlements_detail_heading()}</PageHeading>
      {page.kind !== 'ready' ? (
        <EntitlementsState kind={page.kind} locale={locale} history={history} {...(retry ? { retry } : {})} />
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
          <BenefitDetails
            benefit={capturedBenefit(record.contentEdition, record.targetSubjectId)}
            creatorName={page.creatorName}
            active={record.active && record.revokedAt === null && record.revokeReason === null}
            locale={locale}
            {...(onOpenReader ? { onOpenReader } : {})}
          />
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
                  {record.revokeReason === 'refund' ? m.entitlements_refund() : m.entitlements_dispute()}
                  <p className="mt-2 max-w-prose leading-relaxed">
                    {record.revokeReason === 'refund'
                      ? m.entitlements_refund_consequence()
                      : m.entitlements_dispute_consequence()}
                  </p>
                </dd>
              </>
            ) : null}
          </dl>
          <p>
            <a
              href={purchaseHistoryHref(locale, `orders/${record.orderId}`, history)}
              className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
            >
              {m.order_receipt()}
            </a>
          </p>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.entitlements_history_hint()}</p>
          <details className="min-w-0 text-sm">
            <summary className="min-h-11 cursor-pointer content-center rounded-sm py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
              {m.entitlements_technical_details()}
            </summary>
            <dl className="space-y-3 [overflow-wrap:anywhere]">
              <div>
                <dt className="text-muted-foreground">{m.order_reference()}</dt>
                <dd>
                  <a
                    href={purchaseHistoryHref(locale, `orders/${record.orderId}`, history)}
                    className="inline-flex min-h-11 items-center break-all font-mono text-primary underline underline-offset-4"
                  >
                    {record.orderId}
                  </a>
                </dd>
              </div>
              {record.revokeReason !== null ? (
                <div>
                  <dt className="text-muted-foreground">{m.entitlements_revoke_code()}</dt>
                  <dd className="mt-1 select-all font-mono">({record.revokeReason})</dd>
                </div>
              ) : null}
            </dl>
          </details>
        </>
      ) : null}
    </article>
  );
}

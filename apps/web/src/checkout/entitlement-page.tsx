import { purchaseHistoryHref, type PurchaseHistoryPosition } from './purchase-return';
import { buttonVariants } from '@rezics/ui/shadcn/button';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { BuyerEntitlement, BuyerEntitlementPage } from './entitlements';
import { EntitlementStatus, EntitlementTime, EntitlementsState } from './entitlements-page';
import { SubjectCover, subjectCover, type SubjectCoverData } from './subject-cover';
import { capturedBenefit } from './benefit';
import { BenefitDetails } from './benefit-details';
import { EntitlementRecordFrame } from './entitlement-workspace';

function EntitlementCurrentContext({
  record,
  subject,
}: {
  record: BuyerEntitlement;
  subject: SubjectCoverData;
}) {
  return (
    <div className="min-w-0">
      <div className="grid min-w-0 gap-5 sm:grid-cols-[auto_minmax(0,1fr)] sm:items-center sm:gap-7">
        <SubjectCover data={subject} size="sm" />
        <div className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
          <h2 className="break-words text-2xl font-semibold leading-tight" lang={record.summary?.label?.language}>
            {subject.subject.title}
          </h2>
          <div className="flex min-w-0 flex-wrap items-center gap-x-4 gap-y-2">
            <EntitlementStatus record={record} />
            {subject.href ? (
              <a
                href={subject.href}
                className="inline-flex min-h-11 max-w-full items-center whitespace-normal text-primary underline underline-offset-4"
              >
                {m.entitlements_subject_link()}
              </a>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function EntitlementHistoryFacts({ record, locale }: { record: BuyerEntitlement; locale: string }) {
  return (
    <div className="min-w-0 space-y-4 border-t border-border pt-6">
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.entitlements_history_hint()}</p>
      <dl className="grid min-w-0 grid-cols-1 gap-y-2 text-sm [overflow-wrap:anywhere] sm:grid-cols-[minmax(10rem,0.38fr)_minmax(0,1fr)] sm:gap-x-8 sm:gap-y-4 [&>dt]:text-muted-foreground [&>dd]:mb-3 [&>dd]:min-w-0 [&>dd]:break-words sm:[&>dd]:mb-0">
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
    </div>
  );
}

function EntitlementSupportingReferences({
  record,
  locale,
  history,
}: {
  record: BuyerEntitlement;
  locale: string;
  history: PurchaseHistoryPosition;
}) {
  const receiptHref = purchaseHistoryHref(locale, `orders/${record.orderId}`, history);
  return (
    <div className="min-w-0 border-t border-border pt-5">
      <div className="flex min-w-0 flex-col gap-3 sm:flex-row sm:items-start sm:justify-between sm:gap-8">
        <a
          href={receiptHref}
          className={buttonVariants({
            variant: 'outline',
            className: 'min-h-11 w-full max-w-full whitespace-normal text-center sm:w-fit',
          })}
        >
          {m.order_receipt()}
        </a>
        <details className="min-w-0 text-sm sm:flex-1 sm:max-w-3xl">
          <summary className="min-h-11 cursor-pointer content-center rounded-sm py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
            {m.entitlements_technical_details()}
          </summary>
          <dl className="min-w-0 space-y-3 [overflow-wrap:anywhere]">
            <div>
              <dt className="text-muted-foreground">{m.order_reference()}</dt>
              <dd>
                <a
                  href={receiptHref}
                  className="inline-flex min-h-11 max-w-full items-center break-all font-mono text-primary underline underline-offset-4"
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
      </div>
    </div>
  );
}

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
    <EntitlementRecordFrame>
      <header className="min-w-0 space-y-4">
        <a
          href={purchaseHistoryHref(locale, 'entitlements', history)}
          className={buttonVariants({
            variant: 'link',
            className: 'min-h-11 w-fit max-w-full justify-start whitespace-normal px-0 text-left',
          })}
        >
          {m.entitlements_heading()}
        </a>
        <PageHeading id="entitlement-heading" tabIndex={-1}>
          {m.entitlements_detail_heading()}
        </PageHeading>
      </header>
      {page.kind !== 'ready' ? (
        <EntitlementsState kind={page.kind} locale={locale} history={history} {...(retry ? { retry } : {})} />
      ) : record && subject ? (
        <>
          <EntitlementCurrentContext record={record} subject={subject} />
          <BenefitDetails
            benefit={capturedBenefit(record.contentEdition, record.targetSubjectId)}
            creatorName={page.creatorName}
            active={record.active && record.revokedAt === null && record.revokeReason === null}
            locale={locale}
            {...(onOpenReader ? { onOpenReader } : {})}
          />
          <EntitlementHistoryFacts record={record} locale={locale} />
          <EntitlementSupportingReferences record={record} locale={locale} history={history} />
        </>
      ) : null}
    </EntitlementRecordFrame>
  );
}

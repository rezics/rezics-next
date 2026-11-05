import { ContentItemFrame, ContentItemHeading } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@rezics/ui/shadcn/accordion';
import type { MouseEvent, ReactNode } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorStatementData, CreatorStatementLine } from './creator-statements';
import type { StatementWindowControls } from './creator-statement-windows';
import { recordedMoneyUnit } from './money-schema';
import {
  StatementAmount,
  StatementNotice,
  StatementPayment,
  StatementTime,
  statementHref,
  statementMonth,
  statementsHref,
} from './creator-statements-page';

function lineKind(kind: CreatorStatementLine['kind']): string {
  switch (kind) {
    case 'charge':
      return m.statements_charge();
    case 'refund':
      return m.statements_refund();
    case 'refund_reversal':
      return m.statements_refund_reversal();
    case 'dispute':
      return m.statements_dispute();
    case 'dispute_reversal':
      return m.statements_dispute_reversal();
  }
}

export function CreatorStatementPage({
  page,
  id,
  locale,
  cursor,
  from,
  payment,
  navigation,
  onMovement,
  onRetry,
}: {
  page: CreatorStatementData | { kind: 'preparing' };
  id: string;
  locale: string;
  cursor?: string;
  from?: string;
  payment?: ReactNode;
  navigation?: StatementWindowControls;
  onMovement?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onRetry?: () => void;
}) {
  const href = statementHref(locale, id, cursor, from);
  const noticeRetry = onRetry ? { onRetry } : {};
  const pagination = {
    locale,
    ...(from !== undefined ? { from } : {}),
    ...(cursor !== undefined ? { cursor } : {}),
    ...(navigation ? { navigation } : {}),
    ...(onMovement ? { onMovement } : {}),
  };
  const statement = page.kind === 'ready' ? page.statement : undefined;
  const summary = statement
    ? ([
        [m.statements_gross(), statement.grossMinor],
        [m.statements_tax(), statement.taxMinor],
        [m.statements_fee(), statement.feeMinor],
        [m.statements_dispute_fee(), statement.disputeFeeMinor],
        [m.statements_refunds(), statement.refundsMinor],
        [m.statements_chargebacks(), statement.chargebacksMinor],
        [m.statements_net(), statement.netReceiptsMinor],
        [m.statements_creator_share(), statement.creatorShareMinor],
        [m.statements_platform_share(), statement.rezicsShareMinor],
      ] as const)
    : [];
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="statement-heading">
      <a
        href={statementsHref(locale, from)}
        className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {m.statements_back()}
      </a>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <PageHeading id="statement-heading" tabIndex={-1}>
            {m.statements_detail_heading()}
          </PageHeading>
          {statement && (
            <p className="text-lg">
              {statementMonth(statement.period, locale)} · {statement.currency.toUpperCase()}
            </p>
          )}
        </div>
        {page.kind !== 'preparing' && (
          <Button variant="outline" className="min-h-11" nativeButton={false} render={<a href={href} />}>
            {m.statements_refresh()}
          </Button>
        )}
      </div>
      {page.kind !== 'ready' ? (
        <>
          <StatementNotice kind={page.kind} retryHref={href} {...noticeRetry} />
          <StatementLinePagination id={id} page={page} {...pagination} />
        </>
      ) : (
        <>
          <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.statements_intro()}</p>
          <section
            className="space-y-4 rounded-xl border bg-card p-5 text-card-foreground"
            aria-labelledby="statement-summary"
          >
            <h2 id="statement-summary" className="text-lg font-semibold">
              {m.statements_summary()}
            </h2>
            <p className="text-sm text-muted-foreground">{m.statements_amount_note()}</p>
            <dl className="grid min-w-0 gap-x-6 gap-y-3 sm:grid-cols-2">
              {summary.map(([label, value]) => (
                <div key={label} className="flex min-w-0 flex-wrap justify-between gap-x-3 gap-y-1">
                  <dt className="text-sm text-muted-foreground">{label}</dt>
                  <dd>
                    <StatementAmount
                      value={value}
                      currency={page.statement.currency}
                      moneyUnit={recordedMoneyUnit(page.statement)}
                      locale={locale}
                    />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm leading-relaxed text-muted-foreground">{m.statements_accounting_note()}</p>
          </section>
          {payment ?? <StatementPayment statement={page.statement} locale={locale} />}
          <section className="min-w-0 space-y-4" aria-labelledby="statement-lines">
            <h2 id="statement-lines" tabIndex={-1} className="text-xl font-semibold">
              {m.statements_lines()}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.statements_lines_note()}</p>
            {page.lines.kind !== 'ready' ? (
              <>
                <StatementNotice kind={page.lines.kind} retryHref={href} {...noticeRetry} />
                <StatementLinePagination id={id} page={page} {...pagination} />
              </>
            ) : (
              <>
                {page.lines.lines.length === 0 ? (
                  <div className="min-w-0 space-y-2 rounded-xl border bg-card p-5 text-card-foreground">
                    <h3 className="break-words font-medium">
                      {cursor || page.lines.next
                        ? m.statement_line_page_reader_page_empty()
                        : m.statement_line_page_reader_first_empty()}
                    </h3>
                    <p className="text-sm leading-relaxed text-muted-foreground" role="status">
                      {m.statements_lines_empty()}
                    </p>
                  </div>
                ) : (
                  <ul className="min-w-0 space-y-2">
                    {page.lines.lines.map((line) => (
                      <li key={line.balanceTransactionId} className="min-w-0">
                        <ContentItemFrame as="div" className="min-w-0 space-y-4 py-3 sm:py-4">
                          <div className="flex min-w-0 flex-wrap items-start justify-between gap-x-6 gap-y-2">
                            <ContentItemHeading
                              level={3}
                              className="min-w-0 break-words text-[17px] leading-snug font-semibold sm:text-lg md:text-xl"
                            >
                              {lineKind(line.kind)}
                            </ContentItemHeading>
                            <dl className="min-w-0 sm:text-right">
                              <dt className="text-sm text-muted-foreground">{m.statements_net()}</dt>
                              <dd className="break-words font-semibold">
                                <StatementAmount
                                  moneyUnit={recordedMoneyUnit(line)}
                                  value={line.netReceiptsMinor}
                                  currency={line.currency}
                                  locale={locale}
                                />
                              </dd>
                            </dl>
                          </div>
                          <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                            {[
                              [m.statements_recording_month(), line.period],
                              [
                                m.statements_royalty_basis(),
                                new Intl.NumberFormat(locale).format(line.royaltyBasisPoints),
                              ],
                            ].map(([label, value]) => (
                              <div key={label} className="min-w-0">
                                <dt className="text-muted-foreground">{label}</dt>
                                <dd className="break-words tabular-nums">{value}</dd>
                              </div>
                            ))}
                            <div className="min-w-0">
                              <dt className="text-muted-foreground">{m.statements_created()}</dt>
                              <dd className="break-words">
                                <StatementTime value={line.created} locale={locale} />
                              </dd>
                            </div>
                            <div className="min-w-0">
                              <dt className="text-muted-foreground">{m.statements_recorded()}</dt>
                              <dd className="break-words">
                                <StatementTime value={line.recordedAt} locale={locale} />
                              </dd>
                            </div>
                            {(
                              [
                                [m.statements_gross(), line.grossMinor],
                                [m.statements_tax(), line.taxMinor],
                                [m.statements_fee(), line.feeMinor],
                                [m.statements_dispute_fee(), line.disputeFeeMinor],
                              ] satisfies readonly (readonly [string, number])[]
                            ).map(([label, value]) => (
                              <div key={label} className="min-w-0">
                                <dt className="text-muted-foreground">{label}</dt>
                                <dd className="break-words">
                                  <StatementAmount
                                    moneyUnit={recordedMoneyUnit(line)}
                                    value={value}
                                    currency={line.currency}
                                    locale={locale}
                                  />
                                </dd>
                              </div>
                            ))}
                          </dl>
                          <Accordion className="min-w-0">
                            <AccordionItem value="source">
                              <AccordionTrigger className="min-h-11">
                                {m.statements_line_source_details()}
                              </AccordionTrigger>
                              <AccordionContent keepMounted>
                                <dl className="grid min-w-0 gap-3 text-sm">
                                  {[
                                    [m.statements_transaction(), line.balanceTransactionId],
                                    [m.statements_order_source(), line.orderId],
                                    [m.statements_offer_source(), line.offerId],
                                  ].map(([label, value]) => (
                                    <div key={label} className="min-w-0">
                                      <dt className="text-muted-foreground">{label}</dt>
                                      <dd className="select-all break-all">{value}</dd>
                                    </div>
                                  ))}
                                </dl>
                                <a
                                  href={`/${locale}/offers/${line.offerId}`}
                                  className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                                >
                                  {m.creator_sale_open_offer()}
                                </a>
                              </AccordionContent>
                            </AccordionItem>
                          </Accordion>
                        </ContentItemFrame>
                      </li>
                    ))}
                  </ul>
                )}
                <StatementLinePagination id={id} page={page} {...pagination} />
              </>
            )}
          </section>
          <Accordion className="min-w-0 bg-card text-card-foreground">
            <AccordionItem value="provenance">
              <AccordionTrigger className="min-h-11">{m.statements_provenance()}</AccordionTrigger>
              <AccordionContent keepMounted>
                <dl className="space-y-3 text-sm">
                  <div>
                    <dt className="text-muted-foreground">{m.statements_id()}</dt>
                    <dd className="break-all">{page.statement.id}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.statements_revision()}</dt>
                    <dd>{page.statement.revision}</dd>
                  </div>
                  <div>
                    <dt className="text-muted-foreground">{m.statements_weighted()}</dt>
                    <dd className="break-all tabular-nums">{page.statement.weightedNetMinor}</dd>
                  </div>
                </dl>
              </AccordionContent>
            </AccordionItem>
          </Accordion>
        </>
      )}
    </section>
  );
}

function StatementLinePagination({
  locale,
  id,
  from,
  cursor,
  page,
  navigation,
  onMovement,
}: {
  locale: string;
  id: string;
  from?: string;
  cursor?: string;
  page: CreatorStatementData | { kind: 'preparing' };
  navigation?: StatementWindowControls;
  onMovement?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const hasPrevious = navigation ? navigation.previous !== undefined : false;
  const restart = navigation ? navigation.restart : !!cursor;
  const next = page.kind === 'ready' && page.lines.kind === 'ready' ? page.lines.next : null;
  if (!hasPrevious && !restart && !next) return null;
  return (
    <nav aria-label={m.statements_line_pagination()} className="flex min-w-0 flex-wrap gap-3">
      {hasPrevious && (
        <Button
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal break-words"
          nativeButton={false}
          render={
            <a href={statementHref(locale, id, navigation!.previous ?? undefined, from)} onClick={onMovement} />
          }
        >
          {m.statements_previous_lines()}
        </Button>
      )}
      {restart && (
        <Button
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal break-words"
          nativeButton={false}
          render={<a href={statementHref(locale, id, undefined, from)} onClick={onMovement} />}
        >
          {m.statements_restart_lines()}
        </Button>
      )}
      {next && (
        <Button
          variant="outline"
          className="h-auto min-h-11 min-w-11 max-w-full py-2 whitespace-normal break-words"
          nativeButton={false}
          render={<a href={statementHref(locale, id, next, from)} onClick={onMovement} />}
        >
          {m.statements_next_lines()}
        </Button>
      )}
    </nav>
  );
}

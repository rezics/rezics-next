import { Button } from '@rezics/ui/shadcn/button';
import { Accordion, AccordionItem, AccordionTrigger, AccordionContent } from '@rezics/ui/shadcn/accordion';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorStatementData, CreatorStatementLine } from './creator-statements';
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
}: {
  page: CreatorStatementData | { kind: 'preparing' };
  id: string;
  locale: string;
  cursor?: string;
  from?: string;
}) {
  const href = statementHref(locale, id, cursor, from);
  const restart = statementHref(locale, id, undefined, from);
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
      <Link
        preload={false}
        to="/creator/statements"
        search={from ? { cursor: from } : {}}
        className="inline-flex min-h-11 items-center text-primary underline underline-offset-4 focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
      >
        {m.statements_back()}
      </Link>
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0 space-y-2">
          <PageHeading id="statement-heading">{m.statements_detail_heading()}</PageHeading>
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
        <StatementNotice
          kind={page.kind}
          retryHref={href}
          restartHref={restart}
          restartLabel={m.statements_restart_lines()}
        />
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
                    <StatementAmount value={value} currency={page.statement.currency} locale={locale} />
                  </dd>
                </div>
              ))}
            </dl>
            <p className="text-sm leading-relaxed text-muted-foreground">{m.statements_accounting_note()}</p>
          </section>
          <StatementPayment statement={page.statement} locale={locale} />
          <section className="min-w-0 space-y-4" aria-labelledby="statement-lines">
            <h2 id="statement-lines" className="text-xl font-semibold">
              {m.statements_lines()}
            </h2>
            <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.statements_lines_note()}</p>
            {page.lines.kind !== 'ready' ? (
              <StatementNotice
                kind={page.lines.kind}
                retryHref={href}
                restartHref={restart}
                restartLabel={m.statements_restart_lines()}
              />
            ) : (
              <>
                {page.lines.lines.length === 0 ? (
                  <p className="rounded-xl border bg-card p-5 text-card-foreground" role="status">
                    {m.statements_lines_empty()}
                  </p>
                ) : (
                  <ul className="space-y-4">
                    {page.lines.lines.map((line) => (
                      <li
                        key={line.balanceTransactionId}
                        className="min-w-0 space-y-4 rounded-xl border bg-card p-4 text-card-foreground sm:p-5"
                      >
                        <div className="flex flex-wrap justify-between gap-2">
                          <h3 className="font-semibold">{lineKind(line.kind)}</h3>
                          <StatementAmount value={line.netReceiptsMinor} currency={line.currency} locale={locale} />
                        </div>
                        <dl className="grid min-w-0 gap-x-6 gap-y-3 text-sm sm:grid-cols-2">
                          {[
                            [m.statements_transaction(), line.balanceTransactionId],
                            [m.statements_order_source(), line.orderId],
                            [m.statements_offer_source(), line.offerId],
                            [m.statements_recording_month(), line.period],
                            [
                              m.statements_royalty_basis(),
                              new Intl.NumberFormat(locale).format(line.royaltyBasisPoints),
                            ],
                          ].map(([label, value]) => (
                            <div key={label} className="min-w-0">
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd className="break-all">{value}</dd>
                            </div>
                          ))}
                          <div>
                            <dt className="text-muted-foreground">{m.statements_created()}</dt>
                            <dd>
                              <StatementTime value={line.created} locale={locale} />
                            </dd>
                          </div>
                          <div>
                            <dt className="text-muted-foreground">{m.statements_recorded()}</dt>
                            <dd>
                              <StatementTime value={line.recordedAt} locale={locale} />
                            </dd>
                          </div>
                          {(
                            [
                              [m.statements_gross(), line.grossMinor],
                              [m.statements_tax(), line.taxMinor],
                              [m.statements_fee(), line.feeMinor],
                              [m.statements_dispute_fee(), line.disputeFeeMinor],
                              [m.statements_net(), line.netReceiptsMinor],
                            ] satisfies readonly (readonly [string, number])[]
                          ).map(([label, value]) => (
                            <div key={label}>
                              <dt className="text-muted-foreground">{label}</dt>
                              <dd>
                                <StatementAmount value={value} currency={line.currency} locale={locale} />
                              </dd>
                            </div>
                          ))}
                        </dl>
                      </li>
                    ))}
                  </ul>
                )}
                <nav aria-label={m.statements_line_pagination()} className="flex flex-wrap gap-3">
                  {cursor && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      nativeButton={false}
                      render={
                        <Link
                          preload={false}
                          to="/creator/statements/$id"
                          params={{ id }}
                          search={from ? { from } : {}}
                        />
                      }
                    >
                      {m.statements_restart_lines()}
                    </Button>
                  )}
                  {page.lines.next && (
                    <Button
                      variant="outline"
                      className="min-h-11"
                      nativeButton={false}
                      render={
                        <Link
                          preload={false}
                          to="/creator/statements/$id"
                          params={{ id }}
                          search={{ cursor: page.lines.next, ...(from ? { from } : {}) }}
                        />
                      }
                    >
                      {m.statements_next_lines()}
                    </Button>
                  )}
                </nav>
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

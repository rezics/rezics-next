import { Button } from '@rezics/ui/shadcn/button';
import { Link } from '@tanstack/react-router';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorStatement, CreatorStatementsData, StatementFailure } from './creator-statements';
import { formatMinorAmount } from './money';
import { recordedMoneyUnit } from './money-schema';

export function statementsHref(locale: string, cursor?: string): string {
  return `/${locale}/creator/statements${cursor ? `?cursor=${encodeURIComponent(cursor)}` : ''}`;
}

export function statementHref(locale: string, id: string, cursor?: string, from?: string): string {
  const query = new URLSearchParams({ ...(cursor ? { cursor } : {}), ...(from ? { from } : {}) });
  return `/${locale}/creator/statements/${id}${query.size ? `?${query}` : ''}`;
}

export function StatementAmount({
  value,
  currency,
  locale,
  moneyUnit,
}: {
  value: number;
  currency: string;
  locale: string;
  moneyUnit?: unknown;
}) {
  return (
    <span className="tabular-nums">
      {formatMinorAmount(locale, currency, value, moneyUnit) ?? m.statements_amount_unavailable()}
    </span>
  );
}

export function statementMonth(period: string, locale: string): string {
  return new Intl.DateTimeFormat(locale, { month: 'long', year: 'numeric', timeZone: 'UTC' }).format(
    new Date(`${period}-01T00:00:00Z`),
  );
}

export function StatementTime({ value, locale }: { value: string; locale: string }) {
  return (
    <time dateTime={value}>
      {new Intl.DateTimeFormat(locale, {
        dateStyle: 'medium',
        timeStyle: 'short',
        timeZone: 'UTC',
      }).format(new Date(value))}
    </time>
  );
}

export function StatementNotice({
  kind,
  retryHref,
  restartHref,
  restartLabel,
}: {
  kind: StatementFailure['kind'] | 'preparing';
  retryHref: string;
  restartHref: string;
  restartLabel?: string;
}) {
  const label =
    kind === 'denied'
      ? m.statements_denied()
      : kind === 'stale'
        ? m.statements_stale()
        : kind === 'error'
          ? m.statements_error()
          : kind === 'preparing'
            ? m.statements_preparing()
            : m.statements_unavailable();
  return (
    <div
      className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground"
      role={kind === 'preparing' ? 'status' : 'alert'}
    >
      <p>{label}</p>
      {kind !== 'preparing' && (
        <Button
          variant="outline"
          className="min-h-11"
          nativeButton={false}
          render={<a href={kind === 'stale' || kind === 'error' ? restartHref : retryHref} />}
        >
          {kind === 'stale' || kind === 'error' ? (restartLabel ?? m.statements_restart()) : m.statements_retry()}
        </Button>
      )}
    </div>
  );
}

export function StatementPayment({ statement, locale }: { statement: CreatorStatement; locale: string }) {
  return (
    <section
      className="space-y-3 rounded-xl border bg-card p-5 text-card-foreground"
      aria-labelledby="statement-payment"
    >
      <h2 id="statement-payment" className="text-lg font-semibold">
        {m.statements_payment_heading()}
      </h2>
      <p>{statement.state === 'paid' ? m.statements_paid() : m.statements_open()}</p>
      {statement.state === 'paid' && (
        <dl className="grid grid-cols-[auto_minmax(0,1fr)] gap-x-4 gap-y-2 text-sm">
          <dt className="text-muted-foreground">{m.statements_paid_reference()}</dt>
          <dd className="break-words">
            {statement.paidReference?.trim() ? statement.paidReference : m.statements_unknown()}
          </dd>
          <dt className="text-muted-foreground">{m.statements_paid_at()}</dt>
          <dd>
            {statement.paidAt ? <StatementTime value={statement.paidAt} locale={locale} /> : m.statements_unknown()}
          </dd>
        </dl>
      )}
      <p className="text-sm leading-relaxed text-muted-foreground">{m.statements_payment_meaning()}</p>
      <p className="text-sm text-muted-foreground">{m.statements_funds_unknown()}</p>
    </section>
  );
}

export function CreatorStatementsPage({
  page,
  locale,
  cursor,
}: {
  page: CreatorStatementsData | { kind: 'preparing' };
  locale: string;
  cursor?: string;
}) {
  const href = statementsHref(locale, cursor);
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="statements-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading id="statements-heading">{m.statements_heading()}</PageHeading>
        {page.kind !== 'preparing' && (
          <Button variant="outline" className="min-h-11" nativeButton={false} render={<a href={href} />}>
            {m.statements_refresh()}
          </Button>
        )}
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.statements_intro()}</p>
      {page.kind !== 'ready' ? (
        <StatementNotice kind={page.kind} retryHref={href} restartHref={statementsHref(locale)} />
      ) : (
        <>
          {page.payoutStatements.length === 0 ? (
            <div className="space-y-2 rounded-xl border bg-card p-5 text-card-foreground" role="status">
              <p className="font-medium">{cursor ? m.statements_page_empty() : m.statements_empty()}</p>
              <p className="text-sm text-muted-foreground">{m.statements_empty_hint()}</p>
            </div>
          ) : (
            <ul className="divide-y rounded-xl border bg-card text-card-foreground">
              {page.payoutStatements.map((statement) => (
                <li key={statement.id} className="min-w-0 p-4 sm:p-5">
                  <Link
                    preload={false}
                    to="/creator/statements/$id"
                    params={{ id: statement.id }}
                    search={cursor ? { from: cursor } : {}}
                    className="flex min-h-11 flex-wrap items-start justify-between gap-3 rounded-sm text-foreground focus-visible:outline-2 focus-visible:outline-offset-4 focus-visible:outline-ring"
                  >
                    <div className="space-y-1">
                      <h2 className="font-semibold">
                        {statementMonth(statement.period, locale)} · {statement.currency.toUpperCase()}
                      </h2>
                      <p className="text-sm text-muted-foreground">
                        {statement.state === 'paid' ? m.statements_paid() : m.statements_open()}
                      </p>
                    </div>
                    <div className="space-y-1 sm:text-right">
                      <p className="text-sm text-muted-foreground">{m.statements_creator_share()}</p>
                      <p className="font-semibold">
                        <StatementAmount
                          value={statement.creatorShareMinor}
                          moneyUnit={recordedMoneyUnit(statement)}
                          currency={statement.currency}
                          locale={locale}
                        />
                      </p>
                    </div>
                  </Link>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label={m.statements_pagination()} className="flex flex-wrap gap-3">
            {cursor && (
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<Link preload={false} to="/creator/statements" search={{}} />}
              >
                {m.statements_restart()}
              </Button>
            )}
            {page.next && (
              <Button
                variant="outline"
                className="min-h-11"
                nativeButton={false}
                render={<Link preload={false} to="/creator/statements" search={{ cursor: page.next }} />}
              >
                {m.statements_next()}
              </Button>
            )}
          </nav>
        </>
      )}
    </section>
  );
}

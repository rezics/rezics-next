import { ContentItem } from '@rezics/ui/content-item';
import { Button } from '@rezics/ui/shadcn/button';
import type { MouseEvent } from 'react';
import { m } from '../paraglide/messages.js';
import { PageHeading } from '../shell/page-heading';
import type { CreatorStatement, CreatorStatementsData, StatementFailure } from './creator-statements';
import { formatMinorAmount } from './money';
import { recordedMoneyUnit } from './money-schema';
import type { StatementWindowControls } from './creator-statement-windows';

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
  onRetry,
}: {
  kind: StatementFailure['kind'] | 'preparing';
  retryHref: string;
  onRetry?: () => void;
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
      {kind !== 'preparing' &&
        (onRetry ? (
          <Button type="button" variant="outline" className="min-h-11 min-w-11" onClick={onRetry}>
            {m.statements_retry()}
          </Button>
        ) : (
          <Button variant="outline" className="min-h-11 min-w-11" nativeButton={false} render={<a href={retryHref} />}>
            {m.statements_retry()}
          </Button>
        ))}
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
  navigation,
  onMovement,
  onRetry,
}: {
  page: CreatorStatementsData | { kind: 'preparing' };
  locale: string;
  cursor?: string;
  navigation?: StatementWindowControls;
  onMovement?: (event: MouseEvent<HTMLAnchorElement>) => void;
  onRetry?: () => void;
}) {
  const href = statementsHref(locale, cursor);
  const noticeRetry = onRetry ? { onRetry } : {};
  const pagination = {
    locale,
    ...(cursor !== undefined ? { cursor } : {}),
    ...(navigation ? { navigation } : {}),
    ...(onMovement ? { onMovement } : {}),
  };
  return (
    <section className="max-w-4xl min-w-0 space-y-6 text-foreground" aria-labelledby="statements-heading">
      <div className="flex flex-wrap items-start justify-between gap-4">
        <PageHeading id="statements-heading" tabIndex={-1}>
          {m.statements_heading()}
        </PageHeading>
        {page.kind !== 'preparing' && (
          <Button variant="outline" className="min-h-11" nativeButton={false} render={<a href={href} />}>
            {m.statements_refresh()}
          </Button>
        )}
      </div>
      <p className="max-w-prose text-sm leading-relaxed text-muted-foreground">{m.statements_intro()}</p>
      {page.kind !== 'ready' ? (
        <>
          <StatementNotice kind={page.kind} retryHref={href} {...noticeRetry} />
          <StatementListPagination page={page} {...pagination} />
        </>
      ) : (
        <>
          {page.payoutStatements.length === 0 ? (
            <div className="space-y-2 rounded-xl border bg-card p-5 text-card-foreground" role="status">
              <p className="font-medium">{cursor ? m.statements_page_empty() : m.statements_empty()}</p>
              <p className="text-sm text-muted-foreground">{m.statements_empty_hint()}</p>
            </div>
          ) : (
            <ul>
              {page.payoutStatements.map((statement) => (
                <ContentItem
                  key={statement.id}
                  title={`${statementMonth(statement.period, locale)} · ${statement.currency.toUpperCase()}`}
                  headingLevel={2}
                  href={statementHref(locale, statement.id, undefined, cursor)}
                  state={
                    <span className="text-sm text-muted-foreground">
                      {statement.state === 'paid' ? m.statements_paid() : m.statements_open()}
                    </span>
                  }
                  trailing={
                    <div className="min-w-0 space-y-1 sm:text-right">
                      <p className="text-sm text-muted-foreground">{m.statements_creator_share()}</p>
                      <p className="break-words font-semibold">
                        <StatementAmount
                          value={statement.creatorShareMinor}
                          moneyUnit={recordedMoneyUnit(statement)}
                          currency={statement.currency}
                          locale={locale}
                        />
                      </p>
                    </div>
                  }
                />
              ))}
            </ul>
          )}
          <StatementListPagination page={page} {...pagination} />
        </>
      )}
    </section>
  );
}

function StatementListPagination({
  locale,
  cursor,
  page,
  navigation,
  onMovement,
}: {
  locale: string;
  cursor?: string;
  page: CreatorStatementsData | { kind: 'preparing' };
  navigation?: StatementWindowControls;
  onMovement?: (event: MouseEvent<HTMLAnchorElement>) => void;
}) {
  const hasPrevious = navigation ? navigation.previous !== undefined : false;
  const restart = navigation ? navigation.restart : !!cursor;
  const next = page.kind === 'ready' ? page.next : null;
  if (!hasPrevious && !restart && !next) return null;
  return (
    <nav aria-label={m.statements_pagination()} className="flex flex-wrap gap-3">
      {hasPrevious && (
        <Button
          variant="outline"
          className="min-h-11 min-w-11"
          nativeButton={false}
          render={<a href={statementsHref(locale, navigation!.previous ?? undefined)} onClick={onMovement} />}
        >
          {m.statements_previous()}
        </Button>
      )}
      {restart && (
        <Button
          variant="outline"
          className="min-h-11 min-w-11"
          nativeButton={false}
          render={<a href={statementsHref(locale)} onClick={onMovement} />}
        >
          {m.statements_restart()}
        </Button>
      )}
      {next && (
        <Button
          variant="outline"
          className="min-h-11 min-w-11"
          nativeButton={false}
          render={<a href={statementsHref(locale, next)} onClick={onMovement} />}
        >
          {m.statements_next()}
        </Button>
      )}
    </nav>
  );
}

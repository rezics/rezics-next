import { Exposure, useOperation } from '../kernel/exposure';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CurrentEntitlement, OrderPageData, Settlement } from './order';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';
import { useSession } from '../session/query';
import { BenefitDetails } from './benefit-details';
import { formatMinorAmount } from './money';
import {
  createReconciliationRequest,
  requestOrderReconciliation,
  type ReconciliationSender,
  type ReconciliationPhase,
} from './order-reconcile';

const recheckMs = 2_000;
// The first read is the page loader. Fifteen further reads reach the 16-read cap at 30 seconds.
const recheckLimit = 15;
const openSettlement = new Set<Settlement>(['pending', 'unknown']);

/** Status polling updates settlement only; current access needs a fresh page read. */
export function applyOrderStatus(order: OrderPageData, settlement: Settlement, offerId: string): OrderPageData {
  if (order.offerId !== offerId || order.settlement === settlement) return order;
  return { ...order, settlement, entitlement: { kind: 'refresh' }, canUseBenefit: false };
}

function entitlementLabel(entitlement: CurrentEntitlement): string {
  if (entitlement.kind === 'current')
    return entitlement.active ? m.order_entitlement_active() : m.order_entitlement_revoked();
  if (entitlement.kind === 'none') return m.orders_entitlement_none();
  if (entitlement.kind === 'refresh') return m.order_entitlement_refresh();
  return m.order_entitlement_unavailable();
}

type OrderPageProps = {
  order: OrderPageData;
  checkout?: 'canceled' | 'success';
  /** Component stories substitute only this operation's contract-shaped response. */
  reconcile?: ReconciliationSender;
};

export function OrderPage(props: OrderPageProps) {
  return <OrderReceipt key={props.order.id} {...props} />;
}

function OrderReceipt(props: OrderPageProps) {
  const [loaded, setLoaded] = useState(props.order);
  const [order, setOrder] = useState(props.order);
  if (loaded !== props.order) {
    setLoaded(props.order);
    setOrder(props.order);
  }
  const [gaveUp, setGaveUp] = useState(false);
  const canReadOrder = useOperation('order.get');
  const { state: session, csrfToken, subject } = useSession();
  // Admission/session changes retire work, but cannot replenish this loaded order's read allowance.
  const polls = useRef(0);
  return (
    <OrderLifetime
      key={JSON.stringify([
        props.order.offerId,
        session,
        subject ?? null,
        canReadOrder,
        props.order.canReconcile === true,
      ])}
      {...props}
      order={order}
      setOrder={setOrder}
      gaveUp={gaveUp}
      setGaveUp={setGaveUp}
      canReadOrder={canReadOrder}
      signedIn={session === 'signed-in'}
      csrfToken={csrfToken}
      polls={polls}
    />
  );
}

function OrderLifetime({
  order: initial,
  setOrder,
  gaveUp,
  setGaveUp,
  checkout,
  reconcile,
  canReadOrder,
  signedIn,
  csrfToken,
  polls,
}: OrderPageProps & {
  setOrder: Dispatch<SetStateAction<OrderPageData>>;
  gaveUp: boolean;
  setGaveUp: Dispatch<SetStateAction<boolean>>;
  canReadOrder: boolean;
  signedIn: boolean;
  csrfToken: string | null;
  polls: { current: number };
}) {
  const order = initial;
  const [reconciliation, setReconciliation] = useState<ReconciliationPhase>('ready');
  const [refreshQueued, setRefreshQueued] = useState(false);
  const operation = useRef<ReturnType<typeof createReconciliationRequest> | null>(null);
  const lifetime = useRef({ active: false });
  // Retire callbacks at commit, before a late microtask can update the retained receipt state.
  useLayoutEffect(() => {
    const current = { active: true };
    lifetime.current = current;
    return () => {
      current.active = false;
      operation.current = null;
    };
  }, []);
  const sender = useRef<ReconciliationSender>(async () => ({ kind: 'unavailable' }));
  sender.current = (intent) =>
    reconcile
      ? reconcile(intent)
      : requestOrderReconciliation({ data: intent, headers: { 'X-CSRF-Token': csrfToken ?? '' } });
  async function checkStatus() {
    const current = lifetime.current;
    if (
      !current.active ||
      !canReadOrder ||
      !initial.canReconcile ||
      !signedIn ||
      !csrfToken ||
      ['refreshing', 'queued', 'denied', 'conflict'].includes(reconciliation)
    )
      return;
    operation.current ??= createReconciliationRequest(initial.id, (intent) => sender.current(intent));
    setReconciliation('refreshing');
    const result = await operation.current();
    if (!current.active || !result) return;
    setReconciliation(result.kind);
    if (result.kind === 'queued') {
      setOrder((current) => ({ ...current, entitlement: { kind: 'refresh' }, canUseBenefit: false }));
      setRefreshQueued(true);
    }
  }
  const shouldPoll =
    signedIn && canReadOrder && (refreshQueued || (checkout !== 'canceled' && openSettlement.has(order.settlement)));
  useEffect(() => {
    if (!shouldPoll) return;
    const current = lifetime.current;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const recheck = () => {
      if (stopped || !current.active) return;
      if (polls.current >= recheckLimit) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(async () => {
        if (stopped || !current.active) return;
        polls.current += 1;
        try {
          const response = await fetch(`/orders/${order.id}/status`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            redirect: 'manual',
            signal: controller.signal,
          });
          if (stopped || !current.active) return;
          if (response.ok) {
            const body: unknown = await response.json();
            if (stopped || !current.active) return;
            if (
              body &&
              typeof body === 'object' &&
              !Array.isArray(body) &&
              'id' in body &&
              body.id === order.id &&
              'offerId' in body &&
              body.offerId === order.offerId &&
              'settlement' in body &&
              (body.settlement === 'paid' ||
                body.settlement === 'failed' ||
                body.settlement === 'pending' ||
                body.settlement === 'unknown')
            ) {
              const settlement = body.settlement;
              setOrder((current) => applyOrderStatus(current, settlement, order.offerId));
              if (!refreshQueued && !openSettlement.has(settlement)) return;
            }
          }
        } catch {}
        recheck();
      }, recheckMs);
    };
    recheck();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
  }, [shouldPoll, order.id, order.offerId, refreshQueued]);

  const pending = openSettlement.has(order.settlement);
  const canceled = checkout === 'canceled' && order.settlement !== 'paid';
  const confirming = pending && !canceled;
  const locale = getLocale();
  const money = order.money;
  const charge = order.settlement === 'paid' ? money?.recordedCharge : null;
  const price = money && formatMinorAmount(locale, money.currency, money.unitAmountMinor, money.moneyUnit);
  const total = charge && formatMinorAmount(locale, charge.currency, charge.amountTotalMinor, charge.moneyUnit);
  const tax =
    charge?.amountTaxMinor != null
      ? formatMinorAmount(locale, charge.currency, charge.amountTaxMinor, charge.moneyUnit)
      : money?.amountTaxMinor != null
        ? formatMinorAmount(locale, money.currency, money.amountTaxMinor, money.moneyUnit)
        : null;
  const heading =
    order.settlement === 'paid'
      ? m.order_paid()
      : canceled
        ? m.order_canceled()
        : gaveUp && pending
          ? m.order_still_processing()
          : pending
            ? m.order_pending()
            : m.order_failed();

  return (
    <article className="max-w-3xl min-w-0 space-y-8 text-foreground">
      <PageHeading className="text-foreground">{heading}</PageHeading>
      <div
        className={
          order.settlement === 'paid'
            ? 'space-y-5 rounded-xl border border-border bg-card p-5 text-card-foreground sm:p-6'
            : 'flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start sm:gap-4'
        }
      >
        {order.settlement === 'paid' && (
          <h2 id="receipt-heading" className="text-xl font-semibold">
            {m.order_receipt()}
          </h2>
        )}
        <div className="flex min-w-0 flex-col gap-5 sm:flex-row sm:items-start sm:gap-6">
          <SubjectCover data={order.subject} size="sm" priority />
          <div className="min-w-0 space-y-4">
            <p
              className={
                order.settlement === 'paid'
                  ? 'break-words text-lg font-medium'
                  : 'min-w-0 break-words pt-1 font-serif text-xl text-foreground'
              }
            >
              {order.subject.subject.title}
            </p>
            {order.settlement === 'paid' && (
              <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
                <dt className="text-muted-foreground">{m.order_reference()}</dt>
                <dd className="break-all font-mono">{order.id}</dd>
                <dt className="text-muted-foreground">{m.order_ordered_at()}</dt>
                <dd>
                  <time>
                    {new Intl.DateTimeFormat(locale, { dateStyle: 'long', timeStyle: 'short' }).format(
                      new Date(order.createdAt),
                    )}
                  </time>
                </dd>
              </dl>
            )}
            <dl className="grid min-w-0 grid-cols-[auto_minmax(0,1fr)] gap-x-5 gap-y-2 text-sm">
              <dt className="text-muted-foreground">{m.order_currency()}</dt>
              <dd>{money?.currency?.toUpperCase() || m.order_currency_unavailable()}</dd>
              <dt className="text-muted-foreground">
                {money?.taxBehavior === 'exclusive' ? m.order_recorded_price_exclusive() : m.order_recorded_price()}
              </dt>
              <dd>{price || m.statements_amount_unavailable()}</dd>
              {order.settlement === 'paid' && (
                <>
                  <dt className="text-muted-foreground">{m.order_paid_total()}</dt>
                  <dd>{total || m.order_paid_total_unavailable()}</dd>
                  <dt className="text-muted-foreground">{m.order_recorded_tax()}</dt>
                  <dd>{tax || m.order_tax_unavailable()}</dd>
                </>
              )}
              {money?.taxCode ? (
                <>
                  <dt className="text-muted-foreground">{m.order_tax_code()}</dt>
                  <dd className="break-all">{money.taxCode}</dd>
                </>
              ) : null}
            </dl>
          </div>
        </div>
      </div>
      <dl className="space-y-1">
        <dt className="font-medium">{m.order_current_access()}</dt>
        <dd role="status">{entitlementLabel(order.entitlement)}</dd>
      </dl>
      {order.settlement === 'paid' && order.benefit ? (
        <BenefitDetails
          benefit={order.benefit}
          creatorName={order.creatorName}
          locale={locale}
          active={order.canUseBenefit === true && order.entitlement.kind === 'current' && order.entitlement.active}
        />
      ) : null}
      {order.entitlementId ? (
        <p>
          <a
            href={`/${locale}/entitlements/${encodeURIComponent(order.entitlementId)}`}
            className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          >
            {m.entitlements_detail_heading()}
          </a>
        </p>
      ) : null}
      {initial.canReconcile && signedIn && canReadOrder && (
        <section className="space-y-3" aria-label={m.order_reconcile_action()}>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            disabled={!csrfToken || ['refreshing', 'queued', 'denied', 'conflict'].includes(reconciliation)}
            onClick={() => void checkStatus()}
          >
            {reconciliation === 'refreshing'
              ? m.order_reconcile_refreshing()
              : reconciliation === 'retry' || reconciliation === 'unavailable'
                ? m.order_reconcile_retry()
                : m.order_reconcile_action()}
          </Button>
          <p role="status" className="text-sm text-muted-foreground">
            {reconciliation === 'queued'
              ? m.order_reconcile_queued()
              : reconciliation === 'unavailable'
                ? m.order_reconcile_unavailable()
                : reconciliation === 'retry'
                  ? m.order_reconcile_error()
                  : reconciliation === 'denied' || reconciliation === 'conflict'
                    ? m.order_reconcile_denied()
                    : m.order_reconcile_hint()}
          </p>
        </section>
      )}
      {confirming && (
        <Alert role="status">
          <AlertDescription className="text-foreground">{m.order_confirming()}</AlertDescription>
        </Alert>
      )}
      {order.settlement === 'failed' && !canceled && (
        <Alert role="status">
          <AlertDescription className="space-y-3 text-foreground">
            <p>{m.order_failed_detail()}</p>
            <a
              href={`/${locale}/offers/${order.offerId}`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_back()}
            </a>
          </AlertDescription>
        </Alert>
      )}
      {order.settlement === 'paid' && (
        <section aria-labelledby="next-step-heading" className="space-y-3">
          <h2 id="next-step-heading" className="text-xl font-semibold">
            {m.order_next_step()}
          </h2>
          <div className="flex flex-wrap gap-x-5 gap-y-2">
            <a
              href={`/${locale}/library`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_open_library()}
            </a>
            <a
              href={`/${locale}/offers/${order.offerId}`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_back()}
            </a>
          </div>
        </section>
      )}
      {canceled && (
        <Alert role="status">
          <AlertDescription className="space-y-3 text-foreground">
            <a
              href={`/${locale}/offers/${order.offerId}`}
              className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
            >
              {m.order_back()}
            </a>
          </AlertDescription>
        </Alert>
      )}
      {((gaveUp && pending) || order.entitlement.kind === 'refresh') && (
        <Button
          variant="outline"
          size="lg"
          className="w-full sm:w-auto"
          disabled={!canReadOrder}
          onClick={() => window.location.reload()}
        >
          {m.order_refresh()}
        </Button>
      )}
      <Exposure operation="order.list">
        <p>
          <a
            href={`/${locale}/orders`}
            className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
          >
            {m.nav_orders()}
          </a>
        </p>
      </Exposure>
    </article>
  );
}

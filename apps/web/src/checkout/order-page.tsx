import { purchaseHistoryHref, type PurchaseHistoryPosition } from './purchase-return';
import { Exposure } from '../kernel/exposure';
import { Alert, AlertDescription } from '@rezics/ui/shadcn/alert';
import { Button } from '@rezics/ui/shadcn/button';
import { useEffect, useLayoutEffect, useRef, useState, type Dispatch, type SetStateAction } from 'react';
import { m } from '../paraglide/messages.js';
import { getLocale } from '../paraglide/runtime.js';
import type { CurrentEntitlement, OrderPageData, Settlement } from './order';
import { PageHeading } from '../shell/page-heading';
import { SubjectCover } from './subject-cover';
import { useBuyerCurrentOrigin, type BuyerCurrentOrigin } from './buyer-current-origin';
import { BenefitDetails } from './benefit-details';
import { OrderAccessRecovery } from './order-access-recovery';
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
  history?: PurchaseHistoryPosition | undefined;
  checkout?: 'canceled' | 'success';
  /** Component stories substitute only this operation's contract-shaped response. */
  reconcile?: ReconciliationSender;
};

export function OrderPage(props: OrderPageProps) {
  const locale = getLocale();
  const address = JSON.stringify([props.order.id, props.order.offerId, locale]);
  const session = useBuyerCurrentOrigin(
    'order.get',
    JSON.stringify([address, props.order.canReconcile === true]),
    address,
  );
  const benefit = useBuyerCurrentOrigin('entitlement.get', address);
  // Keep the bound across viewer, admission and address ABA, including revisiting an order.
  const budgets = useRef(new Map<string, { polls: { current: number }; accepted: boolean }>());
  let budget = budgets.current.get(props.order.id);
  if (!budget) {
    budget = { polls: { current: 0 }, accepted: false };
    budgets.current.set(props.order.id, budget);
  }
  return <OrderReceipt key={props.order.id} {...props} locale={locale} session={session} benefit={benefit} budget={budget} />;
}

function OrderReceipt(
  props: OrderPageProps & {
    locale: string;
    session: ReturnType<typeof useBuyerCurrentOrigin>;
    benefit: ReturnType<typeof useBuyerCurrentOrigin>;
    budget: { polls: { current: number }; accepted: boolean };
  },
) {
  const { locale, session, benefit, budget } = props;
  const [loaded, setLoaded] = useState(props.order);
  const [order, setOrder] = useState(props.order);
  if (loaded !== props.order) {
    setLoaded(props.order);
    setOrder(props.order);
  }
  // The loaded access result can belong to its first actual viewer only. Re-admission or viewer ABA
  // needs a fresh page result before it can advertise protected use again; history remains a receipt.
  const [access, setAccess] = useState(() => ({
    loaded: props.order,
    origin: benefit.origin.isCurrent() ? benefit.origin : null,
  }));
  let accessOrigin = access.origin;
  if (access.loaded !== props.order || (!access.origin && benefit.origin.isCurrent())) {
    accessOrigin = benefit.origin.isCurrent() ? benefit.origin : null;
    setAccess({ loaded: props.order, origin: accessOrigin });
  }
  const [gaveUp, setGaveUp] = useState(budget.polls.current >= recheckLimit);
  // The command belongs to the viewer/address, independently of each admission read.
  const newCommand = () => ({
    operation: null as ReturnType<typeof createReconciliationRequest> | null,
    owner: session.intent,
    phase: (budget.accepted ? 'queued' : 'ready') as ReconciliationPhase,
  });
  const [enrolled, setEnrolled] = useState(() => ({ owner: session.intent, command: newCommand() }));
  let command = enrolled.command;
  if (enrolled.owner !== session.intent) {
    command = newCommand();
    setEnrolled({ owner: session.intent, command });
  }
  return (
    <OrderLifetime
      key={session.origin.id}
      {...props}
      locale={locale}
      order={order}
      setOrder={setOrder}
      gaveUp={gaveUp}
      setGaveUp={setGaveUp}
      origin={session.origin}
      benefitOrigin={accessOrigin}
      canUseBenefit={!benefit.hydrated || accessOrigin?.isCurrent() === true}
      hydrated={session.hydrated}
      canReadOrder={session.admitted}
      signedIn={session.state === 'signed-in' && !!session.subject}
      csrfToken={session.csrfToken}
      polls={budget.polls}
      enqueue={budget}
      command={command}
    />
  );
}

function OrderLifetime({
  order: initial,
  locale,
  setOrder,
  gaveUp,
  setGaveUp,
  checkout,
  history = {},
  reconcile,
  canReadOrder,
  hydrated,
  signedIn,
  csrfToken,
  polls,
  origin,
  benefitOrigin,
  canUseBenefit,
  enqueue,
  command,
}: OrderPageProps & {
  locale: string;
  setOrder: Dispatch<SetStateAction<OrderPageData>>;
  gaveUp: boolean;
  setGaveUp: Dispatch<SetStateAction<boolean>>;
  canReadOrder: boolean;
  hydrated: boolean;
  signedIn: boolean;
  csrfToken: string | null;
  polls: { current: number };
  origin: BuyerCurrentOrigin;
  benefitOrigin: BuyerCurrentOrigin | null;
  canUseBenefit: boolean;
  enqueue: { accepted: boolean };
  command: {
    operation: ReturnType<typeof createReconciliationRequest> | null;
    owner: BuyerCurrentOrigin;
    phase: ReconciliationPhase;
  };
}) {
  const order = initial;
  const [reconciliation, setReconciliation] = useState<ReconciliationPhase>(() =>
    enqueue.accepted ? 'queued' : command.phase === 'refreshing' ? 'retry' : command.phase,
  );
  const [refreshQueued, setRefreshQueued] = useState(enqueue.accepted);
  const phase = useRef<ReconciliationPhase>(reconciliation);
  const lifetime = useRef({ active: false });
  useLayoutEffect(() => {
    const episode = { active: true };
    lifetime.current = episode;
    return () => {
      episode.active = false;
    };
  }, []);
  const current = () => lifetime.current.active && origin.isCurrent();
  async function checkStatus() {
    if (
      !current() ||
      !canReadOrder ||
      !initial.canReconcile ||
      !signedIn ||
      !command.owner.isObserved() ||
      enqueue.accepted ||
      ['refreshing', 'queued', 'denied', 'conflict'].includes(phase.current)
    )
      return;
    if (!command.operation) {
      const token = origin.credential();
      if (!token) return;
      // The sender and explicit credential belong to this deliberate intent, including every retry.
      const send: ReconciliationSender =
        reconcile ?? ((intent) => requestOrderReconciliation({ data: intent, headers: { 'X-CSRF-Token': token } }));
      command.operation = createReconciliationRequest(initial.id, send);
    }
    command.phase = phase.current = 'refreshing';
    setReconciliation('refreshing');
    const result = await command.operation(() => current() && command.owner.isObserved());
    if (!current()) return;
    command.phase = phase.current = result?.kind ?? 'retry';
    setReconciliation(phase.current);
    if (result?.kind === 'queued') {
      enqueue.accepted = true;
      // Reconciliation enqueue is not settlement or current-access evidence.
      setRefreshQueued(true);
    }
  }
  const shouldPoll =
    signedIn && canReadOrder && (refreshQueued || (checkout !== 'canceled' && openSettlement.has(order.settlement)));
  useEffect(() => {
    if (!shouldPoll) return;
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const controller = new AbortController();
    const stop = () => {
      stopped = true;
      clearTimeout(timer);
      controller.abort();
    };
    const release = origin.onRetire(stop);
    const recheck = () => {
      if (stopped || !current()) return;
      if (polls.current >= recheckLimit) {
        setGaveUp(true);
        return;
      }
      timer = setTimeout(async () => {
        if (stopped || !current()) return;
        polls.current += 1;
        try {
          const response = await fetch(`/orders/${order.id}/status`, {
            headers: { accept: 'application/json' },
            cache: 'no-store',
            redirect: 'manual',
            signal: controller.signal,
          });
          if (stopped || !current()) return;
          if (response.ok) {
            const body: unknown = await response.json();
            if (stopped || !current()) return;
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
              setOrder((value) => (current() ? applyOrderStatus(value, settlement, order.offerId) : value));
              if (!refreshQueued && !openSettlement.has(settlement)) return;
            }
          }
        } catch {}
        recheck();
      }, recheckMs);
    };
    recheck();
    return () => {
      release();
      stop();
    };
  }, [shouldPoll, order.id, order.offerId, refreshQueued, origin]);

  const pending = openSettlement.has(order.settlement);
  const canceled = checkout === 'canceled' && order.settlement !== 'paid';
  const confirming = pending && !canceled;
  const money = order.money;
  const charge = order.settlement === 'paid' ? money?.recordedCharge : null;
  const presentment = order.settlement === 'paid' ? money?.recordedPresentment : null;
  const customerTotal =
    presentment && formatMinorAmount(locale, presentment.currency, presentment.amountTotalMinor, presentment.moneyUnit);
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
              <dl className="grid min-w-0 grid-cols-1 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-5 sm:gap-y-2">
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
            <dl className="grid min-w-0 grid-cols-1 gap-y-1 text-sm sm:grid-cols-[auto_minmax(0,1fr)] sm:gap-x-5 sm:gap-y-2 [&>dd]:mb-3 [&>dd]:break-words sm:[&>dd]:mb-0">
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
                  <dt className="text-muted-foreground">{m.order_presentment_total()}</dt>
                  <dd>
                    {customerTotal && presentment
                      ? `${customerTotal} ${presentment.currency.toUpperCase()}`
                      : m.order_presentment_unavailable()}
                  </dd>
                  <dt className="text-muted-foreground">{m.order_recorded_tax()}</dt>
                  <dd>{tax || m.order_tax_unavailable()}</dd>
                </>
              )}
            </dl>
          </div>
        </div>
      </div>
      <dl className="space-y-1">
        <dt className="font-medium">{m.order_current_access()}</dt>
        <dd role="status">{entitlementLabel(order.entitlement)}</dd>
      </dl>
      {order.settlement === 'paid' && order.benefit ? (
        <div
          onClickCapture={(event) => {
            if (!benefitOrigin?.isCurrent()) event.preventDefault();
          }}
        >
          <BenefitDetails
            benefit={order.benefit}
            creatorName={order.creatorName}
            locale={locale}
            active={
              canUseBenefit &&
              (!hydrated || benefitOrigin?.isCurrent() === true) &&
              order.canUseBenefit === true &&
              order.entitlement.kind === 'current' &&
              order.entitlement.active
            }
          />
        </div>
      ) : null}
      {order.entitlementId ? (
        <p>
          <a
            href={purchaseHistoryHref(locale, `entitlements/${encodeURIComponent(order.entitlementId)}`, history)}
            className="inline-flex min-h-11 items-center text-primary underline underline-offset-4"
          >
            {m.entitlements_detail_heading()}
          </a>
        </p>
      ) : null}
      {order.settlement === 'paid' && order.entitlement.kind === 'unavailable' && (
        <OrderAccessRecovery
          key={`${origin.id}:${benefitOrigin?.id ?? 'retired'}`}
          order={order}
          locale={locale}
          origin={origin}
          benefitOrigin={benefitOrigin}
          enabled={hydrated && canReadOrder && signedIn}
          setOrder={setOrder}
        />
      )}
      {initial.canReconcile && signedIn && canReadOrder && (
        <section className="space-y-3" aria-label={m.order_reconcile_action()}>
          <Button
            variant="outline"
            size="lg"
            className="w-full sm:w-auto"
            disabled={
              (!command.operation && !csrfToken) ||
              ['refreshing', 'queued', 'denied', 'conflict'].includes(reconciliation)
            }
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
          disabled={!canReadOrder || !signedIn}
          onClick={() => {
            if (current()) window.location.reload();
          }}
        >
          {m.order_refresh()}
        </Button>
      )}
      <Exposure operation="order.list">
        <p>
          <a
            href={purchaseHistoryHref(locale, 'orders', history)}
            className="inline-flex min-h-10 items-center text-primary underline underline-offset-4"
          >
            {m.nav_orders()}
          </a>
        </p>
      </Exposure>
      <details className="min-w-0 text-sm">
        <summary className="min-h-11 cursor-pointer content-center rounded-sm py-3 font-medium focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-ring">
          {m.order_technical_details()}
        </summary>
        <dl className="space-y-3 [overflow-wrap:anywhere]">
          <div>
            <dt className="text-muted-foreground">{m.order_reference()}</dt>
            <dd className="mt-1 select-all font-mono">{order.id}</dd>
          </div>
          {money?.taxCode ? (
            <div>
              <dt className="text-muted-foreground">{m.order_tax_code()}</dt>
              <dd className="mt-1 select-all font-mono">{money.taxCode}</dd>
            </div>
          ) : null}
        </dl>
      </details>
    </article>
  );
}

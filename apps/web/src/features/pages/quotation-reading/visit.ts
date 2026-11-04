import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { browserObservation } from '../../../session/observation';
import { sessionQueryKey } from '../../../session/browser-state';
import { subjectHref } from '../../../subject/subject-href';
import type { QuotationRead } from '../../catalogue/quotation';
import type { QuotationTransport } from '../quotation-view';

type Intent = Parameters<QuotationTransport['read']>[0];
type Success = Extract<QuotationRead, { ok: true }>;
type Failure = Extract<QuotationRead, { ok: false }>;
type Page = { cursor?: string | undefined; session?: string | undefined; quote?: string | undefined };
type Visit = {
  intent: Intent;
  previous?: Page | undefined;
  phase: 'loading' | 'ready' | 'failed';
  result?: QuotationRead | undefined;
  observation: number;
};

/** One volatile receipt, containing descriptors only, never quotation bodies or a history of pages.
 * Its reader observation belongs to the existing candidate session, with no additional subscription.
 * A full reload intentionally loses this receipt.
 */
let receipt:
  | {
      token: string;
      id: string;
      locale: string;
      page: Page;
      text?: string | undefined;
      previous?: Page | undefined;
      origin?: string | undefined;
      current: () => boolean;
    }
  | undefined;

function safePath(value?: string) {
  return value && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : undefined;
}

export function useQuotationVisit(props: {
  id: string;
  locale: string;
  quote?: string | undefined;
  returnTo?: string | undefined;
  transport: QuotationTransport;
  initial?: QuotationRead | undefined;
}) {
  const { id, locale, quote, initial } = props;
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const work = useCatalogueLifetime(JSON.stringify(['quotation-visit', id, locale]));
  const token = useId();
  const selectedRef = useRef<HTMLHeadingElement>(null);
  const transport = useRef(props.transport);
  transport.current = props.transport;
  const sequence = useRef(0);
  const mounted = useRef(false);
  const focus = useRef<{ owner: number; element: Element | null } | undefined>(undefined);
  const address = `${id}:${locale}`;
  const url = typeof window === 'undefined' ? undefined : new URL(window.location.href);
  const returnToken = url?.searchParams.get('quotationReturn');
  const [restoration] = useState(() => {
    const saved = receipt;
    receipt = undefined;
    if (!returnToken) return undefined;
    return saved?.token === returnToken &&
      saved.id === id &&
      saved.locale === locale &&
      saved.page.quote === quote &&
      saved.current()
      ? saved
      : null;
  });
  const safeOrigin = safePath(props.returnTo) ?? restoration?.origin;
  const [text, setText] = useState<string | undefined>(restoration?.text);
  const chosenText = useRef(text);
  chosenText.current = text;
  const [visit, setVisit] = useState<Visit>(() => ({
    intent: restoration?.page ?? {
      quote: quote ?? (initial?.ok ? initial.selected?.id : undefined),
      session: initial?.ok ? initial.session : undefined,
    },
    previous: restoration?.previous,
    phase: restoration === null ? 'failed' : initial === undefined ? 'loading' : initial.ok ? 'ready' : 'failed',
    result: restoration === null ? { ok: false, reason: 'stale' } : initial,
    observation: 0,
  }));
  const current = useRef(visit);
  const source = useRef(address);
  const expectedQuote = useRef(quote);
  const publish = (next: Visit) => {
    current.current = next;
    setVisit(next);
  };

  function history(intent: Intent) {
    expectedQuote.current = intent.quote;
    if (!router || typeof window === 'undefined') return;
    const destination = new URL(window.location.href);
    if (intent.quote) destination.searchParams.set('quote', intent.quote);
    else destination.searchParams.delete('quote');
    destination.searchParams.delete('quotationReturn');
    // Router history retains ordinary Back/Forward intent. Native page descriptors stay private.
    router.history.push(`${destination.pathname}${destination.search}`);
  }

  async function request(intent: Intent, previous?: Page, focusSelected = false, push = false) {
    if (!work.active() || !mounted.current) return;
    receipt = undefined;
    const owner = ++sequence.current;
    focus.current = focusSelected ? { owner, element: document.activeElement } : undefined;
    publish({ intent: { ...intent }, previous, phase: 'loading', observation: owner });
    let result: QuotationRead;
    try {
      result = await transport.current.read({ ...intent });
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !work.active() || owner !== sequence.current || source.current !== address) return;
    publish({
      intent: {
        ...intent,
        ...(result.ok ? { session: result.session, quote: result.selected?.id ?? intent.quote } : {}),
      },
      previous,
      phase: result.ok ? 'ready' : 'failed',
      result,
      observation: owner,
    });
    if (push && result.ok) history({ ...intent, quote: result.selected?.id });
  }

  useEffect(() => {
    mounted.current = true;
    source.current = address;
    const focusElsewhere = (event: FocusEvent) => {
      if (focus.current && event.target !== focus.current.element && event.target !== selectedRef.current)
        focus.current = undefined;
    };
    document.addEventListener('focusin', focusElsewhere);
    // Supplied native data remains initial data: never refetch it on mount.
    if (initial === undefined && restoration !== null)
      void request(restoration?.page ?? { quote }, restoration?.previous, !!restoration);
    return () => {
      mounted.current = false;
      sequence.current += 1;
      focus.current = undefined;
      document.removeEventListener('focusin', focusElsewhere);
    };
  }, [work]);

  useEffect(() => {
    if (quote === expectedQuote.current) return;
    expectedQuote.current = quote;
    // A URL is only selection intent. Without an admitted descriptor it starts at page one.
    const retained = current.current;
    const onCurrentPage = quote && retained.result?.ok && retained.result.rows.some((row) => row.id === quote);
    const onPreviousPage = quote && retained.previous?.quote === quote;
    void request(
      onCurrentPage ? { ...retained.intent, quote } : onPreviousPage ? retained.previous! : { quote },
      onCurrentPage ? retained.previous : undefined,
      true,
    );
  }, [quote]);

  useLayoutEffect(() => {
    const ticket = focus.current;
    if (visit.phase === 'loading' || !ticket || ticket.owner !== visit.observation) return;
    focus.current = undefined; // Consumed even if focus moved; blur cannot re-arm this ticket.
    if (
      work.active() &&
      mounted.current &&
      visit.result?.ok &&
      visit.result.selected &&
      (document.activeElement === ticket.element ||
        (!ticket.element?.isConnected && document.activeElement === document.body))
    )
      selectedRef.current?.focus();
  }, [visit, work]);

  const read: Success | undefined = visit.phase === 'ready' && visit.result?.ok ? visit.result : undefined;
  const error: Failure | undefined =
    visit.phase === 'failed' && visit.result && !visit.result.ok ? visit.result : undefined;
  const facts = subjectHref({ id, label: read?.public.subject.labels[locale] ?? '' }, locale).href;
  const returnUrl = new URL(`${facts}/quotations`, 'https://local.invalid');
  if (read?.selected) returnUrl.searchParams.set('quote', read.selected.id);
  if (safeOrigin) returnUrl.searchParams.set('returnTo', safeOrigin);
  returnUrl.searchParams.set('quotationReturn', token);
  const returnHref = `${returnUrl.pathname}${returnUrl.search}`;

  function depart(event: MouseEvent<HTMLElement>) {
    const link = (event.target as Element).closest('a');
    if (!read?.selected || !link?.getAttribute('href')?.startsWith('/') || !work.active()) return;
    const store = browserObservation(client);
    const observed = store.getSnapshot();
    const sessionState = client.getQueryState(sessionQueryKey);
    receipt = {
      token,
      id,
      locale,
      page: { ...current.current.intent, quote: read.selected.id },
      text: chosenText.current,
      previous: current.current.previous,
      origin: safeOrigin,
      current: () => store.getSnapshot() === observed && client.getQueryState(sessionQueryKey) === sessionState,
    };
    // Departure retires every pending focus ticket without changing the admitted page.
    focus.current = undefined;
    if (
      router &&
      event.type === 'click' &&
      event.button === 0 &&
      !event.metaKey &&
      !event.ctrlKey &&
      !event.shiftKey &&
      !event.altKey
    ) {
      event.preventDefault();
      void router.navigate({ href: link.getAttribute('href')! });
    }
  }

  return {
    read,
    text,
    chooseText: (id?: string) => setText(id),
    error,
    selectedRef,
    safeOrigin,
    returnHref,
    depart,
    loading: visit.phase === 'loading',
    observation: visit.observation,
    hasPrevious: !!visit.previous,
    select: (selected: string) =>
      read?.rows.some((row) => row.id === selected)
        ? request({ ...current.current.intent, quote: selected, session: read.session }, visit.previous, true, true)
        : Promise.resolve(),
    more: () =>
      read?.next
        ? request(
            { cursor: read.next, session: read.session },
            { ...current.current.intent, quote: read.selected?.id },
            false,
            true,
          )
        : Promise.resolve(),
    previous: () => (visit.previous ? request(visit.previous, undefined, true, true) : Promise.resolve()),
    restart: () => request({}, undefined, false, true),
    refresh: () => request(current.current.intent, current.current.previous),
    retry: () =>
      error?.reason === 'unavailable' ? request(current.current.intent, current.current.previous) : Promise.resolve(),
  };
}

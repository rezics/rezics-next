import { useEffect, useId, useLayoutEffect, useRef, useState, type MouseEvent } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { useRouter } from '@tanstack/react-router';
import { useCatalogueLifetime } from '../../../subject/candidate-lifetime';
import { browserObservation } from '../../../session/observation';
import { sessionQueryKey } from '../../../session/browser-state';
import { subjectHref } from '../../../subject/subject-href';
import { candidateContext } from '../../../subject/candidates';
import type { QuotationRead } from '../../catalogue/quotation';
import type { QuotationTransport } from '../quotation-view';

type Intent = Parameters<QuotationTransport['read']>[0];
type Success = Extract<QuotationRead, { ok: true }>;
type Failure = Extract<QuotationRead, { ok: false }>;
type Page = {
  cursor?: string | undefined;
  session?: string | undefined;
  quote?: string | undefined;
  context?: string | undefined;
  selection?: Selection | undefined;
};
type Selection = {
  quote: string;
  observation?: string | undefined;
  statementId?: string | undefined;
  property?: string | undefined;
  context?: string | undefined;
  release?: string | undefined;
  revision?: number | undefined;
};
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
      context: string;
      reader: string;
      readerGeneration: number;
      page: Page;
      selection?: Selection | undefined;
      previous?: Page | undefined;
      origin?: string | undefined;
      current: () => boolean;
    }
  | undefined;

function selectedText(read: Success, statementId: string | undefined, locale: string) {
  const row = read.selected;
  if (!row) return undefined;
  return statementId
    ? row.statements.find((text) => text.statementId === statementId)
    : (row.statements.find((text) => text.language === locale) ?? row.statements[0]);
}

function selectionOf(read: Success, statementId: string | undefined, locale: string): Selection | undefined {
  const row = read.selected;
  if (!row) return;
  const text = selectedText(read, statementId, locale);
  if (statementId && !text) return { quote: row.id, observation: row.observation, statementId };
  return {
    quote: row.id,
    observation: row.observation,
    ...(text?.statementId ? { statementId: text.statementId } : {}),
    ...(text?.property ? { property: text.property } : {}),
    ...(text?.assertion
      ? {
          context: text.assertion.context,
          release: text.assertion.release,
          revision: text.assertion.revision,
        }
      : {}),
  };
}

function selectionMatches(read: Success, expected: Selection) {
  const row = read.selected;
  if (!row || row.id !== expected.quote || row.observation !== expected.observation) return false;
  if (!expected.statementId) return true;
  const text = row.statements.find(
    (candidate) =>
      candidate.statementId === expected.statementId &&
      (expected.property === undefined || candidate.property === expected.property),
  );
  return (
    !!text &&
    (!expected.context || text.assertion?.context === expected.context) &&
    (!expected.release || text.assertion?.release === expected.release) &&
    (expected.revision === undefined || text.assertion?.revision === expected.revision)
  );
}

function readingMatchesContext(read: Success, context: string) {
  return (
    read.public.subject.context === context &&
    read.rows.every(
      (row) =>
        row.contexts.every((entry) => !entry.assertion || entry.assertion.context === context) &&
        row.statements.every((statement) => !statement.assertion || statement.assertion.context === context),
    )
  );
}

function safePath(value?: string) {
  return value && value.length <= 2048 && value.startsWith('/') && !value.startsWith('//') && !value.startsWith('/\\')
    ? value
    : undefined;
}

function returnContext(value: string | null | undefined) {
  const match = value && /~([0-9a-f]{8}-[0-9a-f]{4}-[1-8][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})$/i.exec(value);
  return match?.[1];
}

export function useQuotationVisit(props: {
  id: string;
  locale: string;
  context?: string | undefined;
  quote?: string | undefined;
  returnTo?: string | undefined;
  transport: QuotationTransport;
  initial?: QuotationRead | undefined;
}) {
  const { id, locale, quote, initial } = props;
  const client = useQueryClient();
  const router = useRouter({ warn: false });
  const localToken = useId();
  const selectedRef = useRef<HTMLHeadingElement>(null);
  const transport = useRef(props.transport);
  transport.current = props.transport;
  const sequence = useRef(0);
  const mounted = useRef(false);
  const focus = useRef<{ owner: number; element: Element | null } | undefined>(undefined);
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
      (!props.context || saved.context === props.context) &&
      saved.current()
      ? saved
      : null;
  });
  const context =
    restoration && restoration !== null
      ? restoration.context
      : (props.context ?? returnContext(returnToken) ?? candidateContext);
  const lostReceipt = returnToken !== null && restoration === null;
  const initialResult =
    initial?.ok && !readingMatchesContext(initial, context) ? ({ ok: false, reason: 'stale' } as const) : initial;
  // Context is a public native address. The bounded marker can recover that address after a lost receipt;
  // it carries no admission, session, cursor, or authorized reading authority.
  const token = `${localToken}~${context}`;
  const work = useCatalogueLifetime(JSON.stringify(['quotation-visit', id, locale, context]));
  const address = `${id}:${locale}:${context}`;
  const safeOrigin = safePath(props.returnTo) ?? restoration?.origin;
  const [text, setText] = useState<string | undefined>(restoration?.selection?.statementId);
  const restorePending = useRef(!!restoration);
  const selectedIntent = useRef<Selection | undefined>(restoration?.selection);
  const chosenText = useRef(text);
  chosenText.current = text;
  const [visit, setVisit] = useState<Visit>(() => ({
    intent: restoration?.page ?? {
      ...(!lostReceipt ? { quote: quote ?? (initial?.ok ? initial.selected?.id : undefined) } : {}),
      session: initialResult?.ok ? initialResult.session : undefined,
      context,
    },
    previous: restoration?.previous,
    phase:
      restoration === null ? 'failed' : initialResult === undefined ? 'loading' : initialResult.ok ? 'ready' : 'failed',
    result: restoration === null ? { ok: false, reason: 'stale' } : initialResult,
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
    if (props.context || context !== candidateContext) destination.searchParams.set('context', context);
    else destination.searchParams.delete('context');
    destination.searchParams.delete('quotationReturn');
    // Router history retains ordinary Back/Forward intent. Native page descriptors stay private.
    router.history.push(`${destination.pathname}${destination.search}`);
  }

  async function request(
    intent: Intent,
    previous?: Page,
    focusSelected = false,
    push = false,
    expectedSelection?: Selection | null,
  ) {
    if (!work.active() || !mounted.current) return;
    receipt = undefined;
    const owner = ++sequence.current;
    const expected =
      expectedSelection === undefined
        ? restorePending.current
          ? restoration?.selection
          : undefined
        : expectedSelection;
    if (!expected) selectedIntent.current = undefined;
    const requestIntent = { ...intent, context };
    focus.current = focusSelected ? { owner, element: document.activeElement } : undefined;
    publish({ intent: requestIntent, previous, phase: 'loading', observation: owner });
    let result: QuotationRead;
    try {
      result = await transport.current.read(requestIntent);
    } catch {
      result = { ok: false, reason: 'unavailable' };
    }
    if (!mounted.current || !work.active() || owner !== sequence.current || source.current !== address) return;
    if (result.ok && !readingMatchesContext(result, context)) result = { ok: false, reason: 'stale' };
    if (expected && result.ok) {
      restorePending.current = false;
      selectedIntent.current = undefined;
      if (!selectionMatches(result, expected)) result = { ok: false, reason: 'stale' };
      else setText(expected.statementId);
    } else if (expected && result.ok === false && result.reason !== 'unavailable') {
      restorePending.current = false;
      selectedIntent.current = undefined;
    } else if (expected && !result.ok) {
      selectedIntent.current = expected;
    }
    publish({
      intent: {
        ...requestIntent,
        ...(result.ok ? { session: result.session, quote: result.selected?.id ?? intent.quote } : {}),
      },
      previous,
      phase: result.ok ? 'ready' : 'failed',
      result,
      observation: owner,
    });
    if (push && result.ok) history({ ...requestIntent, quote: result.selected?.id });
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
    if ((initial === undefined || restoration) && restoration !== null)
      void request(restoration?.page ?? { quote, context }, restoration?.previous, !!restoration);
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
  if (read?.selected) selectedIntent.current = selectionOf(read, text, locale);
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
    const readerGeneration = observed.state === 'signed-in' ? observed.observation.id : 0;
    const reader = work.reader;
    receipt = {
      token,
      id,
      locale,
      context,
      reader,
      readerGeneration,
      page: { ...current.current.intent, quote: read.selected.id },
      selection: selectionOf(read, chosenText.current, locale),
      previous: current.current.previous,
      origin: safeOrigin,
      current: () => {
        const currentObservation = store.getSnapshot();
        return (
          reader === (currentObservation.state === 'signed-in' ? currentObservation.observation.subject : '') &&
          readerGeneration === (currentObservation.state === 'signed-in' ? currentObservation.observation.id : 0) &&
          currentObservation === observed &&
          client.getQueryState(sessionQueryKey) === sessionState
        );
      },
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
    context,
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
            { ...current.current.intent, quote: read.selected?.id, selection: selectedIntent.current },
            false,
            true,
          )
        : Promise.resolve(),
    previous: () => {
      if (!visit.previous) return Promise.resolve();
      const { selection, ...intent } = visit.previous;
      return request(intent, undefined, true, true, selection ?? null);
    },
    restart: () => request({}, undefined, false, true, null),
    refresh: () => request(current.current.intent, current.current.previous, false, false, selectedIntent.current),
    retry: () =>
      error?.reason === 'unavailable'
        ? request(current.current.intent, current.current.previous, false, false, selectedIntent.current)
        : Promise.resolve(),
  };
}
